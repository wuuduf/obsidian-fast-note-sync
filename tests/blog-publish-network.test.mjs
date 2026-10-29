import { diagnostics } from "./helpers/diagnostics.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function harness(networkLibrary, stalled = false) {
  const timers = new Map(); const requests = []; let id = 0;
  const sourcePath = path.resolve(import.meta.dirname, '../src/lib/api/http_api_service.ts');
  const source = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const request = (url, options) => {
    requests.push({ url, ...options });
    if (!stalled) return Promise.resolve({ status: 200, json: async () => ({ code: 200, status: true }) });
    return new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  vm.runInNewContext(source, {
    module, exports: module.exports, AbortController,
    window: { setTimeout(callback, delay) { assert.equal(delay, 30000); timers.set(++id, callback); return id; }, clearTimeout(key) { timers.delete(key); } },
    require(name) {
      if (name.endsWith("/diagnostics")) return diagnostics;
      if (name === 'obsidian') return { requestUrl: (options) => { requests.push(options); return stalled ? new Promise(() => {}) : Promise.resolve({ status: 200, json: { code: 200, status: true } }); } };
      if (name.includes('helpers')) return { addRandomParam: (url) => url, nativeFetch: request };
      if (name.includes('/types')) return { CLIENT_TYPE: 'test' };
      return { getLocale: () => 'en' };
    },
  });
  const api = new module.exports.HttpApiService({ settings: { api: 'https://sync.example.test', vault: 'Test', networkLibrary }, manifest: {}, getClientName: () => 'fixture' });
  return { api, requests, timers };
}
for (const network of ['fetch', 'requestUrl']) {
  test(`${network}: publication preserves the note scope and releases its request timer`, async () => {
    const h = harness(network); const result = await h.api.executeBlogPublish('Blog/one.md');
    assert.equal(h.requests.length, 1); assert.equal(h.requests[0].method, 'POST');
    assert.deepEqual(JSON.parse(h.requests[0].body), { vault: 'Test', path: 'Blog/one.md' });
    assert.equal(h.timers.size, 0);
    assert.equal(result.traceId, h.requests[0].headers['X-Trace-ID']);
  });
  test(`${network}: an unresponsive publication request times out and releases the timer`, async () => {
    const h = harness(network, true); const pending = h.api.executeBlogPublish('Blog/one.md');
    const rejected = assert.rejects(pending, error => {
      assert.match(error.message, /超时.*发布历史/);
      assert.equal(error.traceId, h.requests[0].headers['X-Trace-ID']);
      return true;
    });
    for (const callback of [...h.timers.values()]) callback();
    await rejected; assert.equal(h.timers.size, 0);
  });
}
