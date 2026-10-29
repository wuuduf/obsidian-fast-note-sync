import { diagnostics } from "./helpers/diagnostics.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(networkLibrary) {
  const pending = []; const updates = []; const redirectPolicies = [];
  const plugin = {
    settings: { api: 'https://old.example.test', apiToken: 'fixture-token', vault: 'Original', networkLibrary, allowedRedirectDomains: 'old-mirror.example.test' },
    runApi: 'https://old.example.test', manifest: {}, getClientName: () => 'fixture',
    updateRuntimeApi: (url) => updates.push(url),
  };
  const send = () => { const request = deferred(); pending.push(request); return request.promise; };
  const file = path.resolve(import.meta.dirname, '../src/lib/api/http_api_service.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, AbortController,
    require(name) {
      if (name.endsWith("/diagnostics")) return diagnostics;
      if (name === 'obsidian') return { requestUrl: send };
      if (name.includes('helpers')) return {
        addRandomParam: (url) => url, nativeFetch: send, dumpError() {},
        isAllowedRedirect(_from, _to, policy) { redirectPolicies.push(policy); return true; },
      };
      if (name.includes('/types')) return { CLIENT_TYPE: 'test' };
      return {};
    },
  });
  const api = new module.exports.HttpApiService(plugin);
  const reply = (index = 0, url = 'https://old.example.test/api/user/info') => pending[index].resolve({
    status: 200, url, json: networkLibrary === 'fetch' ? async () => ({ code: 200, data: { uid: 1 } }) : { code: 200, data: { uid: 1 } },
  });
  return { api, plugin, pending, updates, redirectPolicies, reply };
}

function trackedSignal() {
  const controller = new AbortController(); const listeners = new Set();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => { if (type === 'abort') listeners.add(listener); originalAdd(type, listener, options); };
  controller.signal.removeEventListener = (type, listener, options) => { if (type === 'abort') listeners.delete(listener); originalRemove(type, listener, options); };
  return { controller, listeners };
}

for (const mode of ['fetch', 'requestUrl']) {
  test(`${mode}: an already aborted request never starts network work`, async () => {
    const h = harness(mode); const controller = new AbortController(); controller.abort();
    const request = h.api.request('/api/user/info', { method: 'GET', signal: controller.signal });
    if (h.pending.length) h.reply();
    await assert.rejects(request, /abort|cancel|timeout/i);
    assert.equal(h.pending.length, 0);
  });

  test(`${mode}: switching connection settings rejects late results without changing the new API`, async () => {
    for (const field of ['api', 'apiToken', 'vault', 'runApi', 'networkLibrary']) {
      const h = harness(mode); const request = h.api.getUserInfo();
      if (field === 'runApi') h.plugin.runApi = 'https://new.example.test';
      else h.plugin.settings[field] = field === 'networkLibrary' ? (mode === 'fetch' ? 'requestUrl' : 'fetch') : 'changed';
      h.reply(0, 'https://old-mirror.example.test/api/user/info');
      await assert.rejects(request, /连接设置已变化/);
      assert.equal(h.updates.length, 0, `old ${field} result must not overwrite the new connection`);
    }
  });

  test(`${mode}: an aborted transport result cannot become a successful response`, async () => {
    const h = harness(mode); const { controller } = trackedSignal();
    const request = h.api.request('/api/user/info', { method: 'GET', signal: controller.signal });
    const rejected = assert.rejects(request, /abort|cancel|timeout/i);
    controller.abort(); h.reply(); await rejected;
    assert.equal(h.updates.length, 0);
  });
}

for (const outcome of ['success', 'failure', 'abort']) {
  test(`requestUrl: ${outcome} removes its abort listener`, async () => {
    const h = harness('requestUrl'); const { controller, listeners } = trackedSignal();
    const request = h.api.request('/api/user/info', { method: 'GET', signal: controller.signal });
    if (outcome === 'success') { h.reply(); await request; }
    else {
      const rejected = assert.rejects(request);
      if (outcome === 'failure') h.pending[0].reject(new Error('offline'));
      else controller.abort();
      await rejected;
    }
    assert.equal(listeners.size, 0);
  });
}

test('fetch: changing redirect policy invalidates an in-flight redirect', async () => {
  const h = harness('fetch'); const request = h.api.getUserInfo();
  h.plugin.settings.allowedRedirectDomains = 'new.example.test';
  h.reply(0, 'https://old-mirror.example.test/api/user/info');
  await assert.rejects(request, /连接设置已变化/);
  assert.deepEqual(h.updates, []);
});

test('fetch: a current allowed redirect still updates the runtime API', async () => {
  const h = harness('fetch'); const request = h.api.getUserInfo();
  h.reply(0, 'https://old-mirror.example.test/api/user/info'); await request;
  assert.deepEqual(h.redirectPolicies, ['old-mirror.example.test']);
  assert.deepEqual(h.updates, ['https://old-mirror.example.test']);
});

test('requestUrl: repeated successful requests can share a signal without accumulating listeners', async () => {
  const h = harness('requestUrl'); const { controller, listeners } = trackedSignal();
  for (let index = 0; index < 64; index++) {
    const request = h.api.request('/api/user/info', { method: 'GET', signal: controller.signal });
    h.reply(index); await request; assert.equal(listeners.size, 0);
  }
});
