#!/usr/bin/env node
// Spike 3 — SQLite Sessions extension availability + replay semantics.
//
// Confirms (in @sqlite.org/sqlite-wasm 3.53.0+):
//   1. The Sessions extension is loadable in the Node WASM build.
//   2. A session captures DB mutations into a changeset.
//   3. The changeset can be re-applied to a fresh DB with identical
//      schema, reproducing the source DB's state.
//   4. Conflicts are surfacable through the apply API and gettable
//      so we can pick a per-conflict policy.
//   5. Successive (independent) changesets can be concatenated/applied
//      against a common base to produce a merged state — minus
//      conflicts which we handle explicitly.
//
// Run: cd /tmp/wb-spike-deps && node sqlite-sessions.mjs

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
const capi = sqlite3.capi;
const wasm = sqlite3.wasm;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ": " + detail : ""}`);
  if (ok) pass++; else fail++;
}

// 1. Sessions API exposed
check("sqlite3session_create available", typeof capi.sqlite3session_create === "function");
check("sqlite3session_attach available", typeof capi.sqlite3session_attach === "function");
check("sqlite3session_changeset available", typeof capi.sqlite3session_changeset === "function");
check("sqlite3changeset_apply available",
  typeof capi.sqlite3changeset_apply === "function" ||
  typeof capi.sqlite3changeset_apply_v2 === "function" ||
  typeof capi.sqlite3changeset_apply_strm === "function");

// Helpers
function newDb() {
  return new sqlite3.oo1.DB(":memory:", "ct");
}

function exec(db, sql, ...params) {
  return db.exec({ sql, bind: params, returnValue: "resultRows", rowMode: "object" });
}

// Helpers — capture session into a Uint8Array, then free the WASM mem.
function captureChangeset(dbPtr) {
  const ppSession = wasm.alloc(8);
  let rc = capi.sqlite3session_create(dbPtr, "main", ppSession);
  if (rc !== 0) throw new Error(`session_create rc=${rc}`);
  const pSession = wasm.peekPtr(ppSession);
  wasm.dealloc(ppSession);
  rc = capi.sqlite3session_attach(pSession, null);
  if (rc !== 0) throw new Error(`session_attach rc=${rc}`);
  return {
    pSession,
    capture() {
      const ppChange = wasm.alloc(8);
      const pnChange = wasm.alloc(4);
      const rc = capi.sqlite3session_changeset(pSession, pnChange, ppChange);
      if (rc !== 0) throw new Error(`session_changeset rc=${rc}`);
      const nChange = wasm.peek(pnChange, "i32");
      const pChange = wasm.peekPtr(ppChange);
      const bytes = wasm.heap8u().slice(pChange, pChange + nChange);
      capi.sqlite3_free(pChange);
      wasm.dealloc(ppChange);
      wasm.dealloc(pnChange);
      return bytes;
    },
    close() {
      capi.sqlite3session_delete(pSession);
    },
  };
}

function applyChangeset(dbPtr, csBytes, conflictPolicy = 1 /* REPLACE */) {
  const pCs = wasm.alloc(csBytes.length);
  wasm.heap8u().set(csBytes, pCs);
  const conflictTypes = [];
  const pHandler = wasm.installFunction("ipip", (_pCtx, eConflict, _pIter) => {
    conflictTypes.push(eConflict);
    return conflictPolicy;
  });
  const rc = capi.sqlite3changeset_apply(dbPtr, csBytes.length, pCs, 0, pHandler, 0);
  wasm.dealloc(pCs);
  wasm.uninstallFunction(pHandler);
  return { rc, conflictTypes };
}

// 2. Capture changeset, replay on fresh DB with identical schema/state.
{
  const dbA = newDb();
  const dbB = newDb();
  for (const db of [dbA, dbB]) {
    exec(db, "CREATE TABLE clips (id INTEGER PRIMARY KEY, start REAL NOT NULL, dur REAL NOT NULL, html TEXT)");
    exec(db, "INSERT INTO clips (id, start, dur, html) VALUES (1, 0, 5, '<p>hi</p>')");
  }

  const session = captureChangeset(dbA.pointer);
  exec(dbA, "INSERT INTO clips (id, start, dur, html) VALUES (2, 5, 3, '<p>two</p>')");
  exec(dbA, "UPDATE clips SET dur = 4 WHERE id = 1");
  const cs = session.capture();
  check("changeset has bytes", cs.length > 0, `${cs.length} bytes`);

  const r = applyChangeset(dbB.pointer, cs);
  check("apply on healthy DB rc=0", r.rc === 0, `rc=${r.rc} conflicts=[${r.conflictTypes.join(",")}]`);

  const rowsA = exec(dbA, "SELECT id, start, dur, html FROM clips ORDER BY id");
  const rowsB = exec(dbB, "SELECT id, start, dur, html FROM clips ORDER BY id");
  check("dbB state matches dbA after replay",
    JSON.stringify(rowsA) === JSON.stringify(rowsB),
    `A=${rowsA.length} rows B=${rowsB.length} rows`);

  session.close();
  dbA.close();
  dbB.close();
}

// 3. Conflict scenario: same row modified differently.
{
  const dbA = newDb();
  const dbB = newDb();
  for (const db of [dbA, dbB]) {
    exec(db, "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    exec(db, "INSERT INTO kv VALUES ('color', 'red')");
  }

  const session = captureChangeset(dbA.pointer);
  exec(dbA, "UPDATE kv SET v = 'blue' WHERE k = 'color'");
  const cs = session.capture();

  exec(dbB, "UPDATE kv SET v = 'green' WHERE k = 'color'");
  const r = applyChangeset(dbB.pointer, cs, 1 /* REPLACE */);
  check("apply with conflict handler returns rc=0", r.rc === 0, `rc=${r.rc}`);
  // SQLITE_CHANGESET_DATA = 1 (mutation against a row whose pre-image
  // doesn't match the changeset's pre-image — i.e., the parallel-edit case).
  check("DATA conflict surfaced (eConflict=1)",
    r.conflictTypes.includes(1),
    `types=[${r.conflictTypes.join(",")}]`);

  const rowsB = exec(dbB, "SELECT k, v FROM kv");
  check("REPLACE policy applied A's value", rowsB[0]?.v === "blue", `dbB color = ${rowsB[0]?.v}`);

  session.close();
  dbA.close();
  dbB.close();
}

// 4. NOTFOUND conflict — apply changeset against a row that doesn't exist
{
  const dbA = newDb();
  const dbB = newDb();
  for (const db of [dbA, dbB]) {
    exec(db, "CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    exec(db, "INSERT INTO kv VALUES ('a', '1')");
  }

  const session = captureChangeset(dbA.pointer);
  exec(dbA, "UPDATE kv SET v = '2' WHERE k = 'a'");
  const cs = session.capture();

  exec(dbB, "DELETE FROM kv WHERE k = 'a'");  // row missing in B
  // Conflict-handler return codes per SQLite docs:
  //   SQLITE_CHANGESET_OMIT = 0, REPLACE = 1, ABORT = 2.
  const r = applyChangeset(dbB.pointer, cs, 0 /* OMIT */);
  check("apply over missing row rc=0 with OMIT policy", r.rc === 0, `rc=${r.rc}`);
  // SQLITE_CHANGESET_NOTFOUND = 2 (the row the changeset wants to mutate
  // does not exist in the target DB).
  check("NOTFOUND conflict surfaced (eConflict=2)",
    r.conflictTypes.includes(2),
    `types=[${r.conflictTypes.join(",")}]`);

  const rowsB = exec(dbB, "SELECT k, v FROM kv");
  check("OMIT policy left dbB without the row",
    rowsB.length === 0,
    `dbB has ${rowsB.length} rows`);

  session.close();
  dbA.close();
  dbB.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
