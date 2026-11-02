import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";

const source = ts.transpileModule(fs.readFileSync(new URL("../src/lib/utils/helpers.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const allocations = [];
let fetchRange;
class TrackedBytes extends Uint8Array {
  constructor(...args) {
    super(...args);
    if (typeof args[0] === "number") allocations.push(args[0]);
  }
}
const module = { exports: {} };
vm.runInNewContext(source, {
  module, exports: module.exports, Uint8Array: TrackedBytes, AbortController,
  window: { setTimeout: (callback, delay) => delay ? setTimeout(callback, delay) : (queueMicrotask(callback), 0), clearTimeout },
  require(id) {
    if (id === "obsidian") return { TFolder: class {}, Platform: { isMobile: false } };
    if (id === "../../i18n/lang") return { $: key => key };
    if (id === "../helpers_obsidian_bypass") return { nativeFetch: (...args) => fetchRange(...args), dump() {} };
    if (id === "../../main" || id === "../sync/sync_log_manager") return {};
    throw new Error(`Unexpected import ${id}`);
  },
});

function expectedRolling(buffer) {
  const size = buffer.length;
  const slice = 5 * 1024 * 1024;
  const mid = Math.min(Math.max(0, Math.floor(size / 2) - Math.floor(slice / 2)), Math.max(0, size - slice));
  const samples = size <= 2 * slice ? [buffer] : [buffer.subarray(0, slice), buffer.subarray(mid, mid + slice), buffer.subarray(size - slice)];
  let hash = 0;
  for (const part of samples) for (const byte of part) hash = (Math.imul(hash, 31) + byte) | 0;
  return String(hash);
}

test("large attachment rolling hashes keep compatibility without allocating a 15 MiB sample", async () => {
  for (const size of [0, 97, 10 * 1024 * 1024, 10 * 1024 * 1024 + 1, 16 * 1024 * 1024 + 37]) {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) bytes[index] = (index * 37 + (index >>> 8)) & 255;
    allocations.length = 0;
    const expected = expectedRolling(bytes);
    assert.equal(await module.exports.hashArrayBuffer(bytes.buffer), expected, `rolling hash at size ${size}`);
    assert.equal(allocations.includes(15 * 1024 * 1024), false, "sample bytes must remain views of the original snapshot");
  }
});

test("file hashing uses correct range offsets or safely falls back to the full file", async () => {
  const bytes = new Uint8Array(10 * 1024 * 1024 + 101);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 19 + (index >>> 14)) & 255;
  const expected = expectedRolling(bytes);
  let reads = 0, requests = 0, cancel = 0;
  const app = { vault: { adapter: {
    async stat() { return { size: bytes.length }; },
    getResourcePath() { return "https://resource.test/file"; },
    async readBinary() { reads++; return bytes.buffer.slice(0); },
  } } };
  for (const mode of ["valid", "ignored", "short", "wrong-offset", "oversized"]) {
    reads = 0; requests = 0; cancel = 0; allocations.length = 0;
    fetchRange = async (_url, options) => {
      requests++;
      const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      const start = Number(match[1]), end = Number(match[2]);
      let produced = 0;
      if (mode === "ignored") return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); if (++produced === 11) controller.close(); },
        cancel() { cancel++; },
      }), { status: 200 });
      const body = bytes.subarray(start, end + 1 - (mode === "short" ? 1 : 0));
      const actual = mode === "oversized" ? new Uint8Array(body.length + 1) : body;
      const contentStart = mode === "wrong-offset" ? start + 1 : start;
      return new Response(actual, { status: 206, headers: { "Content-Range": `bytes ${contentStart}-${end}/${bytes.length}` } });
    };
    assert.equal(await module.exports.hashFileAsync(app, "a.bin"), expected, mode);
    if (mode === "valid") {
      assert.equal(requests, 3); assert.equal(reads, 0);
      assert.equal(allocations.includes(15 * 1024 * 1024), false, "ranges must not be copied into an extra sample buffer");
    }
    else {
      assert.equal(reads, 1, `${mode}: fallback must read the complete file once`);
      assert.equal(allocations.includes(15 * 1024 * 1024), false, `${mode}: fallback must not copy the sample`);
    }
    if (mode === "ignored") assert.equal(cancel, 1, "ignored Range response must be cancelled");
  }
});
