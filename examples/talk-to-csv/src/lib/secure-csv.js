// Secure CSV pipeline for the talk-to-csv showcase.
//
// Mental model: this workbook is an "encrypted document". The
// inline <wb-data id="orders" encryption="age-v1"> in index.html is
// what was issued to the user — they sign in to read it.
//
// Sign-in paths:
//
//   signInWithPassphrase(passphrase)
//     Decrypt the inline block. Always available — works on file://,
//     localhost, or hosted.
//
//   signInWithPasskey()
//     Decrypt the localStorage envelope that was bound to the user's
//     passkey when they previously enabled "remember on this device".
//     Requires an HTTPS or localhost origin; surfaced as unavailable
//     on file://.
//
//   enablePasskey()
//     One-time enrollment after a successful passphrase sign-in. We
//     register a WebAuthn-PRF credential, encrypt the same plaintext
//     to it, and persist the envelope to localStorage. Subsequent
//     visits go through signInWithPasskey().
//
// The CSV plaintext lives in module-local memory while signed in;
// signOut() drops it (and forgetPasskey() additionally wipes the
// localStorage envelope so the next visit returns to passphrase).

// age-encryption is imported statically so Vite bundles it into the
// portable .html. The runtime package's lazy-load wrapper
// (loadAge) uses a vite-ignored dynamic import that doesn't survive
// the singlefile build; calling typage directly avoids that.
import { Encrypter, Decrypter, webauthn } from "age-encryption";
import {
  readVault,
  writeVault,
  clearVault,
  defaultRpId,
  passkeyAvailable,
} from "./vault.js";

let runtime = null;
let unlockedBytes = null;
let cachedSchema = null;
let cachedRowCount = 0;

async function getRuntime() {
  if (!runtime) {
    const { loadRuntime } = await import("virtual:workbook-runtime");
    runtime = await loadRuntime();
  }
  return runtime;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Read the inline <wb-data> the workbook ships with. */
function readInlineBlock() {
  const els = document.querySelectorAll("wb-data[encryption='age-v1']");
  if (!els.length) {
    throw new Error("This workbook has no encrypted block to sign in to.");
  }
  const el = els[0];
  return {
    sha256: el.getAttribute("sha256") ?? "",
    base64: (el.textContent ?? "").replace(/\s+/g, ""),
    id: el.getAttribute("id") ?? "data",
  };
}

async function decryptPassphrase(cipher, passphrase) {
  const d = new Decrypter();
  d.addPassphrase(passphrase);
  return d.decrypt(cipher);
}

async function decryptIdentity(cipher, identity) {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(cipher);
}

async function encryptToRecipient(plaintext, recipient) {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return e.encrypt(plaintext);
}

export async function signInWithPassphrase(passphrase) {
  const blk = readInlineBlock();
  const cipher = base64ToBytes(blk.base64);
  const plaintext = await decryptPassphrase(cipher, passphrase);
  const got = await sha256Hex(plaintext);
  if (got !== blk.sha256) throw new Error("integrity check failed");
  return adoptPlaintext(plaintext);
}

export async function signInWithPasskey() {
  const v = readVault();
  if (!v || !v.prfIdentity) {
    throw new Error("Passkey not enabled on this device yet — sign in with your passphrase first.");
  }
  const identity = new webauthn.WebAuthnIdentity({
    identity: v.prfIdentity,
    rpId: v.rpId ?? undefined,
  });
  const cipher = base64ToBytes(v.cipher);
  const plaintext = await decryptIdentity(cipher, identity);
  const got = await sha256Hex(plaintext);
  if (got !== v.sha256) throw new Error("integrity check failed");
  return adoptPlaintext(plaintext);
}

/**
 * One-time enrollment, called after a successful passphrase sign-in.
 * Registers a passkey and writes a parallel envelope to localStorage.
 */
export async function enablePasskey({ rpId = defaultRpId(), label = "talk-to-csv" } = {}) {
  if (!unlockedBytes) {
    throw new Error("enablePasskey: sign in first");
  }
  if (!passkeyAvailable()) {
    throw new Error(
      "Passkeys aren't available here — they need an HTTPS or localhost origin.",
    );
  }
  const prfIdentity = await webauthn.createCredential({
    keyName: label,
    rpId,
  });
  const recipient = new webauthn.WebAuthnRecipient({
    identity: prfIdentity,
    rpId,
  });
  const cipher = await encryptToRecipient(unlockedBytes, recipient);
  const sha256 = await sha256Hex(unlockedBytes);
  writeVault({
    cipher: bytesToBase64(cipher),
    sha256,
    methods: ["passkey"],
    prfIdentity,
    rpId,
    filename: "",
    rows: cachedRowCount,
  });
}

/** Sign out of the current session — drops plaintext from memory.
 *  Doesn't touch the vault; next visit can sign back in via passkey
 *  or passphrase. */
export function signOut() {
  unlockedBytes = null;
  cachedSchema = null;
  cachedRowCount = 0;
}

/** Wipe the passkey envelope from localStorage. The user can re-
 *  enable it later by signing in with passphrase + clicking enable. */
export function forgetPasskey() {
  signOut();
  clearVault();
}

export function hasPasskeyEnrolled() {
  const v = readVault();
  return Boolean(v && v.prfIdentity);
}

// ─── Queries against the unlocked plaintext ───────────────────────

export async function query(sql) {
  if (!unlockedBytes) throw new Error("query: not signed in");
  const { wasm } = await getRuntime();
  const csvText = new TextDecoder().decode(unlockedBytes);
  const outputs = wasm.runPolarsSql(sql, csvText);
  const csvOut = outputs.find((o) => o.kind === "text" && o.mime_type === "text/csv");
  if (!csvOut) {
    const err = outputs.find((o) => o.kind === "error");
    throw new Error(err?.message ?? "query produced no CSV output");
  }
  return parseCsv(csvOut.content);
}

export async function getAllRows() {
  return query("SELECT * FROM data");
}
export async function getSampleRows(n = 5) {
  return query(`SELECT * FROM data LIMIT ${n}`);
}
export function getSchema() {
  return cachedSchema;
}
export function getRowCount() {
  return cachedRowCount;
}

// ─── helpers ──────────────────────────────────────────────────────

async function adoptPlaintext(plaintext) {
  unlockedBytes = plaintext;
  const csvText = new TextDecoder().decode(plaintext);
  cachedSchema = deriveSchemaFromCsv(csvText);
  cachedRowCount = countRows(csvText);
  return { schema: cachedSchema, rows: cachedRowCount };
}

function countRows(csvText) {
  const trimmed = csvText.replace(/\n+$/g, "");
  if (!trimmed) return 0;
  return Math.max(0, trimmed.split("\n").length - 1);
}
function deriveSchemaFromCsv(csvText) {
  const head = csvText.split("\n", 1)[0];
  const second = csvText.split("\n", 2)[1] ?? "";
  const cols = parseRow(head);
  const sampleCells = parseRow(second);
  return cols.map((name, i) => ({ name, type: inferType(sampleCells[i]) }));
}
function inferType(cell) {
  if (cell === undefined || cell === "") return "text";
  if (/^-?\d+$/.test(cell)) return "int";
  if (/^-?\d*\.\d+$/.test(cell)) return "float";
  if (/^\d{4}-\d{2}-\d{2}/.test(cell)) return "date";
  return "text";
}
function parseCsv(s) {
  const lines = s.trim().split("\n");
  if (!lines.length) return [];
  const head = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseRow(line);
    const row = {};
    head.forEach((k, i) => {
      const v = cells[i];
      row[k] = isNumeric(v) ? Number(v) : v;
    });
    return row;
  });
}
function parseRow(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { inQ = !inQ; continue; }
    if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function isNumeric(s) {
  return s !== "" && !isNaN(Number(s));
}
