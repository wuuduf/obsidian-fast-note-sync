import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync(path.resolve(import.meta.dirname, "../src/lib/sync/hash_timeout.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const timers = new Map();
let nextTimer = 0;
const module = { exports: {} };
vm.runInNewContext(source, {
  module, exports: module.exports, AbortController,
  window: {
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  },
});
const { withHashTimeout } = module.exports;

assert.equal(await withHashTimeout(async () => "hash"), "hash");
assert.equal(timers.size, 0, "successful hashes release their timers");
await assert.rejects(withHashTimeout(async () => { throw new Error("read failed"); }), /read failed/);
assert.equal(timers.size, 0, "failed reads release their timers");

let rejectRead, workSignal;
const stalledRead = withHashTimeout(signal => new Promise((_, reject) => { workSignal = signal; rejectRead = reject; }), 42);
await Promise.resolve();
assert.equal(timers.size, 1);
const [{ callback, ms }] = timers.values();
assert.equal(ms, 42);
callback();
await assert.rejects(stalledRead, /Hash timeout/, "a stalled read must not block the scan indefinitely");
assert.equal(workSignal.aborted, true, "a timeout must notify queued work so it can be removed");
assert.equal(timers.size, 0);
rejectRead(new Error("late read failure"));
await Promise.resolve();
