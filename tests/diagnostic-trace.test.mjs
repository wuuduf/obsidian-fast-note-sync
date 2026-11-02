import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';
import { diagnostics, loadDiagnostics } from './helpers/diagnostics.mjs';
import { loadDiagnosticRuntime } from '../scripts/diagnostic-fixture-runtime.mjs';

function moduleAt(relative, require = () => ({}), globals = {}) {
  const file = path.resolve(import.meta.dirname, '../src', relative);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: (id) => id.endsWith('/diagnostics') ? diagnostics : require(id), console, AbortController, URL, setTimeout, clearTimeout, ...globals });
  return module.exports;
}

test('diagnostic IDs validate ASCII length, reject header injection, and work without Web Crypto', () => {
  for (const value of ['a', 'A'.repeat(64), 'trace_1.2:retry-3']) assert.equal(diagnostics.validTraceId(value), value);
  for (const value of ['', '-bad', '中文', 'a'.repeat(65), 'a\r\nx-secret: bad', null]) assert.equal(diagnostics.validTraceId(value), undefined);
  const fallback = loadDiagnostics({ crypto: undefined }); const ids = new Set();
  for (let index = 0; index < 100; index++) { const id = fallback.createTraceId(); assert.equal(fallback.validTraceId(id), id); ids.add(id); }
  assert.equal(ids.size, 100);
});

test('round contexts have independent bounded roots and preserve the original ID on retries', () => {
  const contexts = new diagnostics.DiagnosticContexts(2);
  const first = contexts.begin('first'); const second = contexts.begin('second');
  assert.notEqual(first, second); assert.equal(contexts.begin('first', 'replacement'), first);
  assert.equal(contexts.begin('retry', second), second); assert.equal(contexts.get('first'), undefined);
  assert.equal(diagnostics.sourceTraceId({ diagnostics: contexts }, 'second', 'other'), second);
  assert.equal(diagnostics.sourceTraceId({ diagnostics: contexts }, 'first'), undefined, 'never fall back to the current round for old work');
});

function logHarness() {
  const lines = []; const state = { contents: '', statGate: null, entered: null, writes: 0 };
  const adapter = {
    async stat() { state.entered?.(); if (state.statGate) await state.statGate; return { size: Buffer.byteLength(state.contents) }; },
    async append(_file, line) { lines.push(line); state.contents += line; },
    async write(_file, value) { state.writes++; state.contents = value; },
  };
  const { SyncLogManager } = moduleAt('lib/sync/sync_log_manager.ts', (id) => id === 'obsidian' ? { moment: () => ({ format: () => 'time' }) } : id.includes('helpers') ? { dumpError() {}, getPluginDir: () => '.obsidian/plugins/fast-note-sync' } : { $: key => key }, { window: { setTimeout, clearTimeout } });
  const manager = SyncLogManager.getInstance(); const plugin = { manifest: { id: 'fast-note-sync' }, app: { vault: { adapter } }, diagnostics: new diagnostics.DiagnosticContexts(), retryRecovery: { clear() {} } };
  manager.init(plugin);
  return { manager, plugin, state, lines };
}

test('diagnostics persist in order with bounded lines and rotation, including retry state', async () => {
  const h = logHarness();
  assert.equal(h.manager.logFilePath, '.obsidian/plugins/fast-note-sync/sync.log');
  h.manager.addOrUpdateLog({ id: 'failure', type: 'receive', action: 'NoteSync', status: 'error', traceId: 'root-1', retryState: 'failed', message: 'failed' });
  h.manager.updateRetry('failure', { retryState: 'retrying' }); h.manager.updateRetry('failure', { retryState: 'recovered', status: 'success' });
  await h.manager.writeQueue; assert.equal(h.lines.length, 3);
  assert.match(h.lines[0], /Trace: root-1/); assert.match(h.lines[1], /Retry: retrying/); assert.match(h.lines[2], /Retry: recovered/);
  h.state.contents = 'x'.repeat(1024 * 1024);
  h.manager.addLog('error', 'NoteModify', 'large'.repeat(100_000), 'error', undefined, undefined, { traceId: 'root-large' });
  await h.manager.writeQueue; assert.equal(h.state.writes, 1); assert.ok(Buffer.byteLength(h.state.contents) < 30_000); assert.match(h.state.contents, /truncated.*Trace: root-large/);
  await h.manager.shutdown();
});

test('clearing or unloading cannot replay queued old log writes after the boundary', async () => {
  for (const boundary of ['clear', 'shutdown']) {
    const h = logHarness(); let release; h.state.statGate = new Promise(resolve => release = resolve);
    let entered; const began = new Promise(resolve => entered = resolve); h.state.entered = entered;
    h.manager.addLog('error', 'NoteModify', 'old', 'error', undefined, undefined, { traceId: 'old-root' });
    await began;
    const finishing = boundary === 'clear' ? h.manager.clearLogs() : h.manager.shutdown();
    h.state.statGate = null; release(); await finishing; await h.manager.writeQueue;
    assert.equal(h.state.contents, '');
    if (boundary === 'clear') {
      h.manager.addLog('error', 'NoteModify', 'new', 'error', undefined, undefined, { traceId: 'new-root' });
      await h.manager.writeQueue; assert.match(h.state.contents, /new-root/); assert.doesNotMatch(h.state.contents, /old-root/);
      await h.manager.shutdown();
    }
  }
});

test('a late note failure keeps its original vault and trace after connection scope changes', async () => {
  const h = logHarness(); let release; let entered;
  const gate = new Promise(resolve => release = resolve); const began = new Promise(resolve => entered = resolve);
  h.plugin.settings = { vault: 'Original', syncEnabled: true }; h.plugin.syncState = { activeSyncContext: 'old-note-context' };
  h.plugin.diagnostics.begin('old-note-context', 'old-note-root');
  h.plugin.noteSyncTasks = { failed: 0 }; let completions = 0;
  h.plugin.recordSyncCompleted = (_type, _page, context) => { if (context === h.plugin.syncState.activeSyncContext) completions++; };
  h.plugin.lockManager = { async withLock() { entered(); await gate; throw new Error('local operation failed'); } };
  const { receiveNoteSyncDelete } = moduleAt('lib/sync/operator_note.ts', id => {
    if (id === 'obsidian') return { normalizePath: path => path, TFile: class {} };
    if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => h.manager } };
    if (id.includes('helpers')) return { dump() {}, dumpError() {}, isPathExcluded: () => false };
    return {};
  });
  const pending = receiveNoteSyncDelete({ context: 'old-note-context', path: 'Blog/one.md' }, h.plugin); await began;
  h.plugin.settings.vault = 'Replacement'; h.plugin.syncState.activeSyncContext = 'new-note-context';
  h.plugin.diagnostics.begin('new-note-context', 'new-note-root'); release(); await pending;
  const failure = h.manager.getLogs()[0]; assert.equal(failure.traceId, 'old-note-root'); assert.equal(failure.vault, 'Original');
  assert.equal(h.plugin.noteSyncTasks.failed, 0); assert.equal(completions, 0); await h.manager.shutdown();
});

test('HTTP request IDs remain local across concurrent success, error, and non-JSON responses', async () => {
  for (const networkLibrary of ['fetch', 'requestUrl']) {
    const requests = []; const logs = [];
    const { HttpApiService } = moduleAt('lib/api/http_api_service.ts', (id) => {
      if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: row => logs.push(row) }) } };
      const send = (_url, options) => new Promise(resolve => requests.push({ options, resolve }));
      if (id === 'obsidian') return { requestUrl: options => send(options.url, options) };
      if (id.includes('helpers')) return { addRandomParam: url => url, nativeFetch: send, dumpError() {} };
      return { CLIENT_TYPE: 'fixture' };
    });
    const api = new HttpApiService({ settings: { api: 'https://fixture.test', vault: 'Test', networkLibrary }, manifest: {}, getClientName: () => 'fixture' });
    const first = api.request('/api/first?token=never-log-this', { method: 'GET' });
    const second = api.request('/api/second', { method: 'GET' });
    const ids = requests.map(request => request.options.headers['X-Trace-ID']); assert.notEqual(ids[0], ids[1]);
    const respond = (index, status, json, traceId) => requests[index].resolve(networkLibrary === 'fetch' ? { status, json: async () => json, headers: { get: () => traceId } } : { status, json, headers: { 'x-TRACE-id': traceId } });
    respond(1, 500, null, 'server-error-id'); respond(0, 200, { code: 200, traceId: 'server-body-id' }, 'server-header-id');
    assert.equal((await first).traceId, 'server-body-id'); assert.equal((await second).traceId, 'server-error-id');
    assert.equal(logs.find(row => row.traceId === 'server-body-id').status, 'success'); assert.equal(logs.find(row => row.traceId === 'server-error-id').status, 'error');
    assert.equal(JSON.stringify(logs).includes('never-log-this'), false);
    const third = api.request('/api/third', { method: 'GET' }); respond(2, 500, null, 'bad\r\nheader'); assert.equal((await third).traceId, requests[2].options.headers['X-Trace-ID']);
    const health = api.request('/api/health', { method: 'GET' }); respond(3, 200, true, undefined); assert.equal((await health).json, true);
  }
});

test('HTTP network errors expose their own ID without persisting unsafe external error text', async () => {
  const logs = [];
  const { HttpApiService } = moduleAt('lib/api/http_api_service.ts', (id) => id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: row => logs.push(row) }) } } : id.includes('helpers') ? { addRandomParam: url => url, nativeFetch: async () => { throw new Error('failed https://host/?token=private'); } } : { CLIENT_TYPE: 'fixture' });
  const api = new HttpApiService({ settings: { api: 'https://fixture.test', vault: 'Test', networkLibrary: 'fetch' }, manifest: {}, getClientName: () => 'fixture' });
  await assert.rejects(api.request('/api/user', { method: 'GET' }), error => { assert.equal(diagnostics.validTraceId(error.traceId), error.traceId); assert.match(error.message, new RegExp(error.traceId)); return true; });
  assert.doesNotMatch(JSON.stringify(logs), /private/); assert.equal(logs.length, 1);
});

test('publication application failures report the server root rather than a different sending ID', async () => {
  for (const networkLibrary of ['fetch', 'requestUrl']) {
    const response = { code: 400, status: false, details: 'preflight failed', traceId: 'server-publication-root' };
    const { HttpApiService } = moduleAt('lib/api/http_api_service.ts', id => {
      if (id === 'obsidian') return { requestUrl: async () => ({ status: 400, json: response, headers: {} }) };
      if (id.includes('helpers')) return { addRandomParam: url => url, nativeFetch: async () => ({ status: 400, json: async () => response }) };
      return { CLIENT_TYPE: 'fixture' };
    }, { window: { setTimeout, clearTimeout } });
    const api = new HttpApiService({ settings: { api: 'https://fixture.test', vault: 'Test', networkLibrary }, manifest: {}, getClientName: () => 'fixture' });
    await assert.rejects(api.executeBlogPublish('Blog/one.md'), error => {
      assert.equal(error.traceId, 'server-publication-root'); assert.match(error.message, /preflight failed.*server-publication-root/); return true;
    });
  }
});

test('real Go publication response retains its persisted job/history/retry root in the plugin', { skip: !process.env.FNS_BLOG_DIAGNOSTIC_CONTRACT_PATH }, async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FNS_BLOG_DIAGNOSTIC_CONTRACT_PATH, 'utf8'));
  for (const row of [fixture.job, fixture.history, fixture.retry, fixture.restored]) assert.equal(row.traceId, fixture.traceId);
  for (const networkLibrary of ['fetch', 'requestUrl']) {
    const { HttpApiService } = moduleAt('lib/api/http_api_service.ts', id => {
      if (id === 'obsidian') return { requestUrl: async () => ({ status: 200, json: fixture.http.body, headers: { 'x-trace-id': fixture.http.header } }) };
      if (id.includes('helpers')) return { addRandomParam: url => url, nativeFetch: async () => ({ status: 200, json: async () => fixture.http.body, headers: { get: () => fixture.http.header } }) };
      return { CLIENT_TYPE: 'fixture' };
    }, { window: { setTimeout, clearTimeout } });
    const api = new HttpApiService({ settings: { api: 'https://fixture.test', vault: 'Test', networkLibrary }, manifest: {}, getClientName: () => 'fixture' });
    assert.equal((await api.executeBlogPublish('Blog/one.md')).traceId, fixture.traceId);
  }
});

test('Protobuf request envelope retains the diagnostic root independently from routing context', () => {
  const runtime = loadDiagnosticRuntime();
  const bytes = runtime.enSendDTOToProtobuf('NoteSyncPageAck', { traceId: 'root-proto', context: 'context-proto', vault: 'Test', pageIndex: 2 });
  const envelope = runtime.proto.v1.WSMessage.decode(bytes);
  const request = runtime.proto.v1.NoteSyncPageAckRequest.decode(envelope.data);
  assert.equal(envelope.traceId, 'root-proto'); assert.equal(request.context, 'context-proto'); assert.equal(request.pageIndex, 2);
});

test('safe re-push capability is negotiated and failures bypass generic conflict handling', () => {
  const actions = moduleAt('lib/sync/websocket_action.ts');
  const failures = []; let genericErrors = 0;
  const { WebSocketManager } = moduleAt('lib/sync/websocket_manager.ts', id => {
    if (id === './operator_file') return { receiveFileRePushFailed: (data) => failures.push(data), clearUploadQueue() {} };
    if (id === './websocket_action') return actions;
    if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ logReceivedMessage() {} }) } };
    if (id.includes('helpers')) return { dump() {}, showSyncNotice() {}, safeStringify: JSON.stringify };
    return {};
  });
  const plugin = {
    settings: { vault: 'Test' }, syncState: { activeSyncContext: 'A' }, currentSyncType: 'full',
    diagnostics: new diagnostics.DiagnosticContexts(),
    localStorageManager: { getMetadata() {}, setMetadata() {} },
    retryRecovery: { acceptsContext: () => true, error() { genericErrors++; return true; } },
  };
  const socket = Object.create(WebSocketManager.prototype);
  socket.plugin = plugin; socket.client = { notifyStatusChange() {}, unRegister() {} };
  socket.sendClientInfo = () => {}; socket.StartHandle = async () => {};
  socket.handleStructuredMessage('Authorization', { code: 200, data: { attachmentRePushSafeSupported: true, attachmentMutationCASSupported: true } });
  assert.equal(plugin.syncState.attachmentRePushSafeSupported, true);
  assert.equal(plugin.syncState.attachmentMutationCASSupported, true);
  socket.handleStructuredMessage('FileRePushFailed', { code: 461, status: false, vault: 'Test', context: 'A', data: { path: 'file.bin' } });
  assert.equal(failures.length, 1); assert.equal(failures[0].path, 'file.bin'); assert.equal(genericErrors, 0);
  socket.unRegister(); assert.equal(plugin.syncState.attachmentRePushSafeSupported, false); assert.equal(plugin.syncState.attachmentMutationCASSupported, false);
  socket.handleStructuredMessage('Authorization', { code: 200, data: {} });
  assert.equal(plugin.syncState.attachmentRePushSafeSupported, false);
  assert.equal(plugin.syncState.attachmentMutationCASSupported, false);
});

test('websocket dispatches identified direct mutations across sync and retry boundaries only', () => {
  const received = []; const actions = moduleAt('lib/sync/websocket_action.ts');
  const { WebSocketManager } = moduleAt('lib/sync/websocket_manager.ts', id => {
    if (id === './operator_file') return { receiveFileMutationConflict: data => received.push(['conflict', data]), receiveFileMutationFailed: data => received.push(['failed', data]) };
    if (id === './operator') return { receiveOperators: new Map([['FileDeleteAck', data => received.push(['delete', data])], ['FileRenameAck', data => received.push(['rename', data])]]) };
    if (id === './websocket_action') return actions;
    if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ logReceivedMessage() {} }) } };
    if (id.includes('helpers')) return { dump() {}, showSyncNotice() {}, safeStringify: JSON.stringify };
    return {};
  });
  const socket = Object.create(WebSocketManager.prototype);
  socket.plugin = { settings: { vault: 'Test' }, syncState: { activeSyncContext: 'B' }, diagnostics: new diagnostics.DiagnosticContexts(), retryRecovery: { acceptsContext: () => false }, currentSyncType: 'full' };
  socket.client = { notifyActivity() {} };
  const message = { code: 200, vault: 'Test', context: 'A', data: { operationId: 'id', path: 'x' } };
  for (const action of ['FileDeleteAck', 'FileRenameAck', 'FileMutationConflict', 'FileMutationFailed']) socket.handleStructuredMessage(action, message);
  assert.deepEqual(received.map(item => item[0]), ['delete', 'rename', 'conflict', 'failed']);
  socket.handleStructuredMessage('FileDeleteAck', { ...message, pageIndex: 1 });
  socket.handleStructuredMessage('FileMutationConflict', { ...message, pageIndex: 1 });
  socket.handleStructuredMessage('FileDeleteAck', { ...message, data: { path: 'x' } });
  socket.handleStructuredMessage('FileDeleteAck', { ...message, vault: 'Other' });
  assert.equal(received.length, 4);
});

test('real Go trace fixture survives PB decoding, failure logging, page retry and full restart', { skip: !process.env.FNS_DIAGNOSTIC_CONTRACT_PATH }, async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FNS_DIAGNOSTIC_CONTRACT_PATH, 'utf8'));
  assert.equal(fixture.echoedRequestId, fixture.traceId);
  const runtime = loadDiagnosticRuntime(); const decoded = runtime.deReceivePacket(Buffer.from(fixture.protobufSuccessBase64, 'base64'));
  assert.equal(decoded.traceId, fixture.traceId); assert.equal(decoded.context, fixture.context); assert.equal(decoded.action, 'NoteSyncPage');
  const h = logHarness(); const state = { context: fixture.context }; const sends = []; const restarts = [];
  h.plugin.settings = { vault: 'Test' }; h.plugin.syncState = { activeSyncContext: fixture.context }; h.plugin.diagnostics.begin(fixture.context, fixture.traceId);
  const { SyncRetryController } = moduleAt('lib/sync/sync_retry_controller.ts', undefined, { window: { setTimeout, clearTimeout } });
  const controller = new SyncRetryController({ getLog: id => h.manager.getLog(id), update: (id, patch) => h.manager.updateRetry(id, patch), vault: () => 'Test', context: () => state.context, connected: () => true, failures: () => 0,
    sendPage: (...args) => sends.push(args), restart: traceId => { restarts.push(traceId); state.context = 'restart-context'; h.plugin.diagnostics.begin(state.context, traceId); controller.started(state.context, 'Test'); } });
  h.plugin.retryRecovery = controller;
  const actions = moduleAt('lib/sync/websocket_action.ts');
  const { WebSocketManager } = moduleAt('lib/sync/websocket_manager.ts', id => {
    if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => h.manager } };
    if (id === './websocket_action') return actions;
    if (id.includes('helpers')) return { dump() {}, showSyncNotice() {}, safeStringify: JSON.stringify };
    return {};
  });
  const socket = Object.create(WebSocketManager.prototype); socket.plugin = h.plugin;
  // The real Go reply is cache expiry after a requested retry, so start with
  // the original read-failure row that owns that pending retry.
  h.manager.logReceivedMessage('NoteSync', { ...fixture.jsonFailure.payload, data: { resourceType: 'note', pageIndex: fixture.jsonFailure.payload.data.pageIndex, retryable: true } }, 'full');
  const row = h.manager.getLogs()[0]; assert.equal(row.traceId, fixture.traceId); assert.equal(row.retryContext, fixture.context);
  controller.retry(row.id); assert.equal(sends[0][3], fixture.traceId);
  socket.handleStructuredMessage(fixture.jsonFailure.type, fixture.jsonFailure.payload);
  assert.equal(h.manager.getLog(row.id).retryState, 'restart-required');
  controller.retry(row.id); assert.deepEqual(restarts, [fixture.traceId]); assert.equal(h.plugin.diagnostics.get('restart-context'), fixture.traceId);
  controller.completed('restart-context', 0); assert.equal(h.manager.getLog(row.id).traceId, fixture.traceId); assert.equal(h.manager.getLog(row.id).retryState, 'recovered');
  await h.manager.writeQueue; assert.match(h.state.contents, new RegExp(fixture.traceId)); await h.manager.shutdown();
});
