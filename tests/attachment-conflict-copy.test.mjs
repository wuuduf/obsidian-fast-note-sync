import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";

const source = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/attachment_conflict_copy.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(source, { module, exports: module.exports, require: () => ({ normalizePath: path => path }), ArrayBuffer });

test("attachment conflict copies never replace the original or an existing copy", async () => {
  const files = new Map([["folder/photo.png", "local"], ["folder/photo.conflict-first.png", "existing"]]);
  const vault = {
    getAbstractFileByPath: path => files.get(path),
    async createBinary(path, data) { if (files.has(path)) throw new Error("exists"); files.set(path, data); },
  };
  const ids = ["first", "second"];
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const result = await module.exports.saveAttachmentConflictCopy(vault, "folder/photo.png", bytes, () => ids.shift());
  assert.equal(result, "folder/photo.conflict-second.png");
  assert.equal(files.get("folder/photo.png"), "local");
  assert.equal(files.get("folder/photo.conflict-first.png"), "existing");
  assert.equal(files.get(result), bytes);
});
