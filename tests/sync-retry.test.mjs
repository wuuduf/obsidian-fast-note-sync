import { diagnostics } from "./helpers/diagnostics.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function moduleAt(relative, require = () => ({}), globals = {}) {
  const file = path.resolve(import.meta.dirname, '../src', relative);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: (id) => id.endsWith("/diagnostics") ? diagnostics : require(id), console, setTimeout, clearTimeout, ...globals }, { filename: file });
  return module.exports;
}
function harness(type = 'note') {
  let timerId = 0; const timers = new Map();
  const timerApi = { setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) };
  const { SyncRetryController } = moduleAt('lib/sync/sync_retry_controller.ts', undefined, { ...timerApi, window: timerApi });
  const row = { id: 'original-error', action: 'NoteSync', type: 'receive', status: 'error', vault: 'Test', retryable: true, retryType: type, retryContext: 'retry-contract', retryPageIndex: 2 };
  const state = { vault: 'Test', context: 'retry-contract', connected: true, failures: 0, sends: [], restarts: 0 };
  const logs = new Map([[row.id, row]]);
  const controller = new SyncRetryController({
    getLog: (id) => logs.get(id), update: (id, patch) => Object.assign(logs.get(id), patch),
    vault: () => state.vault, context: () => state.context, connected: () => state.connected, failures: () => state.failures,
    sendPage: (...args) => state.sends.push(args),
    restart: () => { state.restarts++; controller.interrupt('controlled cancel'); state.context = null; },
  }, 100, 200);
  return { row, state, logs, controller, timers, expire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach((fn) => fn()); } };
}

for (const type of ['note', 'file', 'setting', 'folder']) test(`${type}: retry is single-flight and recovers only after the matching local page applies`, () => {
  const h = harness(type);
  assert.equal(h.controller.retry(h.row.id), true); assert.equal(h.controller.retry(h.row.id), false);
  assert.equal(h.row.retryState, 'retrying'); assert.equal(h.state.sends.length, 1);
  h.controller.pageApplied(type, 'retry-contract', 2); assert.equal(h.row.retryState, 'retrying', 'no early recovery before metadata');
  h.controller.pageReceived(type, 'old-context', 2); h.controller.pageApplied(type, 'old-context', 2);
  h.controller.pageReceived(type, 'retry-contract', 3); h.controller.pageApplied(type, 'retry-contract', 3);
  assert.equal(h.row.retryState, 'retrying');
  h.controller.pageReceived(type, 'retry-contract', 2); assert.equal(h.row.retryState, 'retrying');
  h.controller.pageApplied(type, 'retry-contract', 2);
  assert.equal(h.row.retryState, 'recovered'); assert.equal(h.row.status, 'success'); assert.equal(h.row.retryable, false);
  assert.equal(h.timers.size, 0); assert.equal(h.controller.retry(h.row.id), false);
});

test('a new read failure releases the lock and updates the original row for another attempt', () => {
  const h = harness(); h.controller.retry(h.row.id);
  assert.equal(h.controller.error({ code: 439, context: 'retry-contract', vault: 'Test', message: 'still unavailable', data: { resourceType: 'note', pageIndex: 2, retryable: true } }), true);
  assert.equal(h.row.retryState, 'failed'); assert.equal(h.logs.size, 1);
  assert.equal(h.controller.retry(h.row.id), true); assert.equal(h.row.retryAttempts, 2); h.controller.clear();
});

function expiredFlow(message) {
  const h = harness(); h.controller.retry(h.row.id);
  assert.equal(h.controller.error(message), true);
  assert.equal(h.row.retryState, 'restart-required'); assert.match(h.row.retryMessage, /缓存已过期/);
  assert.equal(h.controller.retry(h.row.id), true); assert.equal(h.state.restarts, 1);
  assert.equal(h.row.retryState, 'retrying'); assert.equal(h.controller.acceptsContext(), false);
  assert.equal(h.controller.retry(h.row.id), false);
  h.state.context = 'new-context'; h.controller.started('new-context', 'Test');
  assert.equal(h.controller.acceptsContext(), true);
  h.controller.completed('retry-contract', 0); assert.equal(h.row.retryState, 'retrying');
  h.controller.completed('new-context', 0); assert.equal(h.row.retryState, 'recovered'); assert.equal(h.timers.size, 0);
}
test('expired cache offers a guarded whole-round restart and waits for its new context to complete', () => {
  expiredFlow({ code: 439, context: 'retry-contract', vault: 'Test', data: { resourceType: 'note', pageIndex: 2, retryable: false, restartRequired: true, reason: 'download_cache_expired' } });
});
test('real Go expiry response closes the plugin recovery loop', { skip: !process.env.FNS_RETRY_CONTRACT_PATH }, () => {
  const message = JSON.parse(fs.readFileSync(process.env.FNS_RETRY_CONTRACT_PATH, 'utf8'));
  expiredFlow(message);
});
test('missing replies, disconnection, cancellation, and new sessions release retry locks', () => {
  for (const interrupt of ['timeout', 'disconnect', 'cancel', 'new-session']) {
    const h = harness(); h.controller.retry(h.row.id);
    if (interrupt === 'timeout') h.expire();
    else if (interrupt === 'new-session') { h.state.context = 'other'; h.controller.started('other', 'Test'); }
    else h.controller.interrupt(interrupt);
    assert.equal(h.row.retryState, 'restart-required'); assert.equal(h.timers.size, 0);
  }
});
test('local failures and partial full-sync completion are never labeled recovered', () => {
  const h = harness(); h.controller.retry(h.row.id); h.controller.pageReceived('note', 'retry-contract', 2); h.state.failures++;
  h.controller.pageApplied('note', 'retry-contract', 2); assert.equal(h.row.retryState, 'restart-required');
  h.controller.retry(h.row.id); h.state.context = 'new'; h.controller.started('new', 'Test');
  h.controller.completed('new', 0, true); assert.equal(h.row.retryState, 'restart-required');
  assert.equal(h.row.status, 'error');
});
test('offline, other-vault, unrelated active rounds, and duplicate page rows cannot send extra work', () => {
  const h = harness(); h.state.connected = false; assert.equal(h.controller.retry(h.row.id), false);
  h.state.connected = true; h.state.vault = 'Other'; assert.equal(h.controller.retry(h.row.id), false);
  h.state.vault = 'Test'; h.state.context = 'unrelated'; assert.equal(h.controller.retry(h.row.id), false);
  assert.equal(h.state.restarts, 0);
  h.state.context = 'retry-contract'; h.row.retryState = 'failed'; h.controller.retry(h.row.id);
  const duplicate = { ...h.row, id: 'duplicate' }; h.logs.set(duplicate.id, duplicate);
  assert.equal(h.controller.retry(duplicate.id), false); assert.equal(h.state.sends.length, 1); h.controller.clear();
});
test('legacy failures use full restart; clearing logs cancels attempt timers', () => {
  const h = harness(); delete h.row.retryType; delete h.row.retryPageIndex; h.state.context = null;
  h.controller.retry(h.row.id); assert.equal(h.state.restarts, 1);
  h.controller.clear(); assert.equal(h.timers.size, 0);
});

test('page-applied notifications include last and legacy pages but not duplicate completions', () => {
  const { SyncProgressTracker } = moduleAt('lib/sync/sync_progress_tracker.ts', (id) => id.includes('helpers') ? { dump() {} } : { $: (key) => key }, { window: { setTimeout: () => 1, clearTimeout() {} } });
  const tracker = new SyncProgressTracker(); const applied = [];
  tracker.onPageApplied = (...args) => applied.push(args); tracker.reset(['note']);
  tracker.recordPageProgress('note', 0, 2, true); tracker.recordCompleted('note', 0);
  assert.equal(applied.length, 0); tracker.recordCompleted('note', 0); tracker.recordCompleted('note', 0);
  assert.equal(applied.length, 1); assert.equal(applied[0][1], 0);
  tracker.reset(['note']); tracker.recordPageProgress('note', 0, 1, true); tracker.recordCompleted('note');
  assert.equal(applied.length, 2);
});

test('old async completions cannot advance a replacement session', () => {
  const { default: FastSync } = moduleAt('main.ts', (id) => id === 'obsidian' ? { Plugin: class {} } : new Proxy({}, { get: () => () => {} }));
  const plugin = { syncState: { activeSyncContext: 'new' }, noteSyncTasks: { completed: 0 } };
  FastSync.prototype.recordSyncCompleted.call(plugin, 'note', 2, 'old'); assert.equal(plugin.noteSyncTasks.completed, 0);
  FastSync.prototype.recordSyncCompleted.call(plugin, 'note', 2, 'new'); assert.equal(plugin.noteSyncTasks.completed, 1);
});

test('actionless failures enter one log row, retries update it, and late expiry ACKs stay quiet', () => {
  const timerApi = { setTimeout: () => 1, clearTimeout() {} };
  const helpers = { dump() {}, dumpError() {}, safeStringify: JSON.stringify, showSyncNotice() {} };
  const { SyncLogManager } = moduleAt('lib/sync/sync_log_manager.ts', (id) => id === 'obsidian' ? { moment: () => ({ format: () => '' }) } : id.includes('helpers') ? helpers : { $: (key) => key }, { ...timerApi, window: timerApi });
  const manager = SyncLogManager.getInstance(); const notices = []; const receiveOperators = new Map();
  const actions = moduleAt('lib/sync/websocket_action.ts');
  const { WebSocketManager } = moduleAt('lib/sync/websocket_manager.ts', (id) => {
    if (id === './sync_log_manager') return { SyncLogManager };
    if (id === './websocket_action') return actions;
    if (id.includes('helpers')) return { ...helpers, showSyncNotice: (message) => notices.push(message) };
    if (id === './operator') return { receiveOperators };
    if (id === 'obsidian') return { moment: () => ({ format: () => '' }), Platform: {} };
    return { $: (key) => key };
  }, { ...timerApi, window: timerApi });
  const plugin = { settings: { vault: 'Test' }, syncState: { activeSyncContext: 'retry-contract' }, currentSyncType: 'incremental' };
  const { SyncRetryController } = moduleAt('lib/sync/sync_retry_controller.ts', undefined, { ...timerApi, window: timerApi });
  plugin.retryRecovery = new SyncRetryController({ getLog: (id) => manager.getLog(id), update: (id, patch) => manager.updateRetry(id, patch), vault: () => 'Test', context: () => plugin.syncState.activeSyncContext, connected: () => true, failures: () => 0, sendPage() {}, restart() {} });
  manager.init(plugin);
  const socket = Object.create(WebSocketManager.prototype); socket.plugin = plugin; socket.client = { notifyActivity() {} };
  const failure = { code: 439, context: 'retry-contract', vault: 'Test', message: 'read failed', data: { retryable: true, resourceType: 'note', pageIndex: 2 } };
  socket.handleStructuredMessage('', failure); socket.handleStructuredMessage('', failure);
  assert.equal(manager.getLogs().length, 1); const row = manager.getLogs()[0]; assert.equal(row.retryable, true);
  plugin.retryRecovery.retry(row.id); assert.equal(manager.getLog(row.id).retryState, 'retrying');
  const expiry = { ...failure, data: { ...failure.data, retryable: false, restartRequired: true, reason: 'download_cache_expired' } };
  socket.handleStructuredMessage('', expiry); assert.equal(manager.getLogs().length, 1); assert.equal(manager.getLog(row.id).retryState, 'restart-required');
  const noticeCount = notices.length; socket.handleStructuredMessage('', expiry); assert.equal(notices.length, noticeCount);
  manager.updateRetry(row.id, { retryState: 'recovered', status: 'success', retryable: false });
  socket.handleStructuredMessage('', failure); assert.equal(manager.getLog(row.id).retryState, 'recovered');
  assert.equal(manager.getLogs().filter((log) => log.status === 'error').length, 0);
  assert.equal(manager.getUnreadFailedCount(), 0);
});

test('retry ACK uses the previous page and explicit context without consuming normal page state', () => {
  const { default: FastSync } = moduleAt('main.ts', (id) => id === 'obsidian' ? { Plugin: class {} } : new Proxy({}, { get: () => () => {} }));
  const sent = []; const plugin = { settings: { vault: 'Test' }, syncState: { activeSyncContext: 'another' }, syncPageStateMap: new Map([['note', { context: 'ordinary' }]]), websocket: { Send: (...args) => sent.push(args) }, sendSyncPageAck: FastSync.prototype.sendSyncPageAck };
  FastSync.prototype.retryFailedPage.call(plugin, 'note', 'retry-contract', 2);
  assert.equal(sent[0][0], 'NoteSyncPageAck'); assert.equal(sent[0][1].pageIndex, 1); assert.equal(sent[0][1].context, 'retry-contract');
  assert.equal(plugin.syncPageStateMap.has('note'), true);
  FastSync.prototype.retryFailedPage.call(plugin, 'note', 'retry-contract', 0);
  assert.equal(sent[1][1].pageIndex, -1);
});

test('expired-page restart performs a full comparison rather than reusing advanced incremental timestamps', () => {
  let host; const calls = [];
  const stub = function () {};
  const { default: FastSync } = moduleAt('main.ts', (id) => {
    if (id === 'obsidian') return { Plugin: class {} };
    if (id.endsWith('sync_retry_controller')) return { SyncRetryController: class { constructor(value) { host = value; } } };
    if (id.endsWith('/operator')) return { cancelSync: () => calls.push('cancel'), handleSync: (_plugin, incremental) => calls.push(incremental) };
    return new Proxy({}, { get: () => stub });
  });
  new FastSync(); host.restart(); assert.deepEqual(calls, ['cancel', false]);
});
