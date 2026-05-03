# KEK rotation runbook — Workbooks Studio broker

**Audience:** broker on-call. Run this when rotating the broker's Key Encryption Key — scheduled rotation (~yearly), suspected compromise, or compliance event.

**Spec context:** [`THREAT_MODEL.md`](./THREAT_MODEL.md) §6 (Disaster recovery — KEK compromise) and `bd show core-l6n.3` (C9.3).

---

## Trust model recap

The broker holds wrapped DEKs in D1's `wrapped_keys` table. Each row carries a `kek_ref` column naming the KEK version that wrapped it (`local:v1`, `local:v2`, …). The broker's `getKek()` builds a keyring at request time:

- **Primary**: `BROKER_LOCAL_KEK` — wraps all *new* entries, returns `kek.ref() = local:v<N>`.
- **Previous** (optional): `BROKER_LOCAL_KEK_PREV` — present only during a rotation window. Used to unwrap rows whose `kek_ref` points at the prior version.

A row's `kek_ref` is the source of truth for which KEK is needed to unwrap it. The keyring routes by `kek_ref`, fail-closed on unknown.

The KEK material is a wrangler secret (never an env var or file in non-dev). Rotating means:

1. Mint a new 32-byte KEK.
2. Bind both new (primary) and previous (rotation tail) to the broker.
3. Drain — re-wrap every existing wrapped DEK under the new primary.
4. Unbind the previous KEK once drain completes.

The broker stays fully available throughout. No customer-visible event.

---

## Prerequisites

- Local checkout of the broker (`apps/workbooks-broker/`).
- `wrangler` CLI authenticated against the deployment account.
- Read access to the broker's D1 (`signal-workbooks-broker`).
- A scratchpad — the runbook produces ephemeral key material that must not be persisted.

---

## Step-by-step

### 1. Mint the new KEK

```bash
openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=' > /tmp/new_kek
# Verify length: should be 43 chars (32 bytes base64url, no padding).
wc -c /tmp/new_kek
```

Treat `/tmp/new_kek` as live key material. Don't paste into chat / commit it / leave it on disk.

### 2. Read the current KEK out of wrangler secrets

You need the *value* of the current `BROKER_LOCAL_KEK` to bind it as `BROKER_LOCAL_KEK_PREV`. Wrangler doesn't expose secret values via CLI — recover it from the credential store you used at provisioning time (1Password, vault, etc.).

If the current value is genuinely lost (compromise scenario where the operator who provisioned it is no longer reachable) — skip to the **emergency re-encrypt** path at the bottom. You'll lose unwrap-ability for legacy rows and need to re-encrypt customer-side artifacts.

### 3. Bind both versions to the broker

For each environment (`staging`, `production`):

```bash
cd apps/workbooks-broker

# Bind the previous KEK as the rotation tail.
echo -n "<current value>" | wrangler secret put BROKER_LOCAL_KEK_PREV --env <env>

# Bind the new KEK as the primary.
cat /tmp/new_kek | wrangler secret put BROKER_LOCAL_KEK --env <env>
```

After this, the keyring at the broker resolves both `local:v<old>` and `local:v<new>`. Existing wraps still unwrap (via PREV); new wraps go to the new primary. Verify:

```bash
curl -sS https://broker.signal.ml/v1/health
# Expect: ready: true, missing_secrets: []
```

### 4. Bump the primary's `id` in `kek.ts`

Edit `apps/workbooks-broker/src/lib/kek.ts`:

```diff
-  const primary = new LocalKekVersion(
-    base64UrlToBytes(env.BROKER_LOCAL_KEK),
-    "v1",
-  );
+  const primary = new LocalKekVersion(
+    base64UrlToBytes(env.BROKER_LOCAL_KEK),
+    "v2",            // bumped from v1 for this rotation
+  );
```

And similarly bump the previous version's `id`:

```diff
-    const prev = new LocalKekVersion(
-      base64UrlToBytes(env.BROKER_LOCAL_KEK_PREV),
-      "vprev",
-    );
+    const prev = new LocalKekVersion(
+      base64UrlToBytes(env.BROKER_LOCAL_KEK_PREV),
+      "v1",             // pre-rotation primary
+    );
```

The `id` strings are what get stored as `kek_ref` for new wraps. Keep them in lockstep with the bumped version. Deploy:

```bash
wrangler deploy --env <env>
```

### 5. Re-wrap migration

Add a one-off worker route gated on a per-environment migration token. The worker iterates `wrapped_keys` where `kek_ref != current_primary_ref`, unwraps with the previous version (via the keyring), re-wraps with the primary, writes back atomically with the new `kek_ref`.

Pseudocode (drop into `src/routes/admin.ts`, mount at `/v1/admin/migrate-kek`, gate behind a `MIGRATION_TOKEN` secret bound only during the migration):

```ts
const PRIMARY_REF = getKek(env).ref();
const stmt = env.DB.prepare(
  `SELECT workbook_id, view_id, ciphertext, kek_ref FROM wrapped_keys
   WHERE kek_ref != ?1 LIMIT 100`,
);
let total = 0;
for (;;) {
  const { results } = await stmt.bind(PRIMARY_REF).all();
  if (results.length === 0) break;
  for (const row of results) {
    const wb = await getWorkbook(env, row.workbook_id);
    const ad = dekAd({
      workbookId: row.workbook_id,
      viewId: row.view_id,
      policyHash: wb.policy_hash,
    });
    const dek = await kek.unwrap(
      new Uint8Array(row.ciphertext),
      ad,
      row.kek_ref,
    );
    const rewrapped = await kek.wrap(dek, ad);
    dek.fill(0);
    await env.DB.prepare(
      `UPDATE wrapped_keys SET ciphertext = ?1, kek_ref = ?2
       WHERE workbook_id = ?3 AND view_id = ?4`,
    )
      .bind(rewrapped, PRIMARY_REF, row.workbook_id, row.view_id)
      .run();
    total++;
  }
}
return new Response(JSON.stringify({ rewrapped: total }), { status: 200 });
```

Run:

```bash
curl -X POST -H "Authorization: Bearer $MIGRATION_TOKEN" \
  https://broker.signal.ml/v1/admin/migrate-kek
# {"rewrapped": 1492}
```

Repeat until `rewrapped: 0` is returned.

### 6. Verify drain is complete

```sql
-- via wrangler d1 execute
SELECT kek_ref, COUNT(*) FROM wrapped_keys GROUP BY kek_ref;
-- Expect: only the new primary appears.
```

### 7. Unbind the previous KEK

```bash
wrangler secret delete BROKER_LOCAL_KEK_PREV --env <env>
```

Remove the migration route from `src/routes/admin.ts` and the `MIGRATION_TOKEN` secret. Deploy.

### 8. Audit-log the rotation

Append a manual entry to `audit_events` (or simply post a note in the customer-visible incident timeline if the rotation is compliance-driven):

```sql
INSERT INTO audit_events
  (workbook_id, identity_sub, action, identity_email_domain, ip_prefix, created_at)
  VALUES ('*', 'broker-operator', 'kek-rotation-complete', NULL, NULL,
          strftime('%s','now'));
```

---

## Verification checklist

- [ ] `/v1/health` returns `ready: true`, `missing_secrets: []` in both staging + prod.
- [ ] `SELECT kek_ref, COUNT(*) FROM wrapped_keys GROUP BY kek_ref` shows only the new primary.
- [ ] `BROKER_LOCAL_KEK_PREV` is unset in `wrangler secret list`.
- [ ] A fresh workbook `register` → `wrap` → `release` → unwrap-on-recipient e2e completes.
- [ ] `apps/workbooks-broker/test:e2e` passes against the rotated broker.
- [ ] Old KEK material is destroyed in the credential store (or clearly tagged "rotated out 2026-XX-XX, never reuse").

---

## Emergency re-encrypt path (compromise scenario, lost legacy KEK)

If the old KEK is compromised AND irrecoverable, you can't unwrap legacy entries — they're effectively gone. Recovery:

1. Bind only the new KEK as `BROKER_LOCAL_KEK`. Don't bind a previous tail.
2. `DELETE FROM wrapped_keys WHERE kek_ref != 'local:v<new>';` — these can never unwrap.
3. Notify customers. Each affected workbook needs the author to re-seal: re-encrypt the cleartext, register again with the broker. The author retains the cleartext on their machine, so this is a workflow event, not data loss.
4. Surface `workbook-revoked: kek-compromise` audit entries for affected `workbook_id`s.
5. Document the compromise event + customer-visible timeline in the SOC2 / compliance log.

This path is destructive to recipients with legacy artifacts they can't re-receive. Treat as a last resort.

---

## Schedule

- **Routine:** annual rotation, scheduled in Q4 of each calendar year.
- **Triggered:** on suspected compromise, employee with KEK access leaves, or compliance event.
- **Drill:** every 6 months, run a no-op rotation in staging — bind, deploy, migrate, verify, unbind. Time the cycle. Update this runbook with whatever surprised the on-call.
