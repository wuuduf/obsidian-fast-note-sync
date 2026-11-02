import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";
const code = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/fair_scan.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const module = { exports: {} }; vm.runInNewContext(code, { module, exports: module.exports });
test("a bounded multi-round scan reaches every file beyond its budget", () => {
  const items = Array.from({ length: 11 }, (_, i) => i);
  let cursor = 0; const visited = new Set();
  for (let i = 0; i < 4; i++) {
    const order = module.exports.fairScanOrder(items, cursor, 3);
    for (const item of order.items.slice(0, 3)) visited.add(item);
    cursor = order.next;
  }
  assert.deepEqual([...visited].sort((a, b) => a - b), items);
});
