import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = path.resolve(import.meta.dirname, "../src/lib/sync/concurrency_limiter.ts");
const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(source, {
  module, exports: module.exports,
  require(id) {
    if (id === "../utils/helpers") return { dump() {} };
    throw new Error(`Unexpected import: ${id}`);
  },
});
const { ConcurrencyLimiter } = module.exports;
const limiter = new ConcurrencyLimiter({ settings: { concurrencyControlEnabled: true, maxConcurrentUploads: 1 } });
await limiter.waitForSlot("old-active");
const abandoned = Array.from({ length: 100 }, (_, index) => limiter.waitForSlot(`old-${index}`, true));
limiter.clear();
await Promise.all(abandoned);
let nextStarted = false;
void limiter.waitForSlot("new-connection").then(() => { nextStarted = true; });
await Promise.resolve();
await Promise.resolve();
assert.equal(nextStarted, true, "clearing 100 queued tasks must leave all new-connection slots free");

// Normal queued acquisition must still consume a slot and preserve FIFO ACKs.
let first = false;
let second = false;
const firstWaiting = limiter.waitForSlot("fifo-1", true).then(() => { first = true; });
const secondWaiting = limiter.waitForSlot("fifo-2", true).then(() => { second = true; });
limiter.releaseSlot("new-connection");
await firstWaiting;
assert.equal(first, true);
assert.equal(second, false);
limiter.releaseFifoSlot();
await secondWaiting;
assert.equal(second, true);
