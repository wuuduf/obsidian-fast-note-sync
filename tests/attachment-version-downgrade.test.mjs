import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function harness(versionSupported) {
  class TFile { constructor(path) { this.path = path; this.extension = path.split('.').at(-1); this.stat = { size: 20, mtime: 1, ctime: 1 }; } }
  class TFolder {}
  const filename = path.resolve(import.meta.dirname, '../src/lib/sync/operator.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }, sent = [], notices = [], writes = [], logs = [], status = [], active = [];
  const noop = () => {}, stubs = new Proxy({}, { get: () => noop });
  const helpers = { dump: (...args) => logs.push({ debug: args.join(' ') }), hashContent: p => `h:${p}`, getPluginDir: () => 'plugin', generateUUID: () => 'round-1', isPathExcluded: () => false, isFolderSyncPathExcluded: () => false, configIsPathExcluded: () => false, getConfigSyncCustomDirs: () => [], showSyncNotice: msg => notices.push(msg), isLargeBinarySyncRisk: () => false, yieldToMain: async () => {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, WebSocket: { OPEN: 1 }, window: { setTimeout() {}, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {} },
    require(id) {
      if (id === 'obsidian') return { TFile, TFolder, normalizePath: p => p };
      if (id === '../utils/helpers') return helpers;
      if (id === './fair_scan') return { fairScanOrder: files => ({ items: files, next: 0 }) };
      if (id === './operator_config') return { ...stubs, configAllPaths: async () => [] };
      if (id === './operator_file') return { ...stubs, isPluginUnloading: false, clearPendingFileMutations() {}, captureAttachmentSnapshot() { throw new Error('attachment must not be hashed'); } };
      if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: row => logs.push(row) }) } };
      if (id === './websocket_action') return new Proxy({}, { get: (_target, name) => name });
      if (id.endsWith('/lang')) return { $: key => key };
      return stubs;
    }, sleep: async () => {}, setTimeout, clearTimeout }, { filename });
  const stats = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, failed: 0, completed: 0 });
  const state = { attachmentConflictSupported: true, attachmentVersionCASSupported: versionSupported, attachmentMutationCASSupported: false, protectedFilesSupported: false, syncUpChunkNum: 100, pipelineWindowUp: 0, newConflictedPathsThisRound: new Set(), pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(), conflictedPaths: new Set(), activeSyncContext: null };
  const plugin = {
    settings: { syncEnabled: true, configSyncEnabled: true, cloudPreviewEnabled: false, offlineDeleteSyncEnabled: true, vault: 'V', isShowNotice: true }, syncState: state,
    app: { vault: { configDir: '.obsidian', getName: () => 'V', getAllLoadedFiles: () => [new TFile('photo.bin')], adapter: { exists: async () => false } }, loadLocalStorage() {}, saveLocalStorage() {} },
    websocket: { on() {}, off() {}, ws: null, async SendMessage(action, data, before, after) { if (!before?.()) { sent.push({ action, data }); after?.(); } } },
    menuManager: { ribbonIconStatus: true }, diagnostics: { begin() {}, get() {} },
    fileHashManager: { getAllPaths: () => ['photo.bin', 'deleted.bin'], getPathHash: () => 'old-base', bulkSetFromScanned() {}, flush() {} },
    configHashManager: { isReady: () => false }, folderSnapshotManager: { isReady: () => false, setFolderMtimes() {} },
    localStorageManager: { getMetadata: () => 0, setMetadata: (...v) => writes.push(v), savePending() {}, getStorageConfigs: async () => [] },
    progressTracker: { reset: types => active.push(...types), recordHashProgress() {}, isTypeFullyDone: () => true, getOverallPct: () => 100, forceComplete() {} },
    retryRecovery: { started() {}, completed: (...v) => { plugin.retryResult = v; }, interrupt() {} },
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(), pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(), pendingNoteDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingNoteModifies: new Map(), pendingConfigModifies: new Map(), scannedNoteHashes: new Map(), scannedFileHashes: new Map(), scannedConfigHashes: new Map(), syncPageStateMap: new Map(), fileDownloadSessions: new Map(),
    updateStatusBar: text => status.push(text), statusBarManager: { updateConflictBadge() {} },
    resetSyncTasks() { this.noteSyncTasks = stats(); this.fileSyncTasks = stats(); this.folderSyncTasks = stats(); this.configSyncTasks = stats(); state.offlineGuardSkippedThisRound = false; state.attachmentVersionSkippedThisRound = false; },
  };
  return { operator: module.exports, plugin, state, sent, notices, writes, logs, status, active };
}

test('old or Windows service skips attachment sync while finishing note, folder and config as partial', async () => {
  const h = harness(false); await h.operator.handleSync(h.plugin, false, 'auto');
  assert.deepEqual(h.sent.map(item => item.action).sort(), ['FolderSync', 'NoteSync', 'SettingSync'], JSON.stringify(h.logs));
  assert.equal(h.plugin.expectedSyncCount, 3); assert.equal(h.plugin.fileSyncEnd, true);
  assert.deepEqual([...h.active].sort(), ['folder', 'note', 'setting']);
  assert.equal(h.state.attachmentVersionSkippedThisRound, true); assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.ok(h.notices.some(text => text.includes('附件') && text.includes('升级')));
  assert.equal(h.plugin.fileHashManager.getPathHash('photo.bin'), 'old-base');
  h.operator.checkSyncCompletion(h.plugin, 1, Date.now(), 'round-1');
  assert.equal(h.plugin.retryResult[1], 1); assert.equal(h.plugin.retryResult[2], true);
  assert.equal(h.writes.some(item => item[0] === 'lastSyncSuccessTime'), false);
  assert.ok(h.status.includes('ui.status.completed_with_failures'));
  assert.equal(h.logs.find(row => row.action === 'SyncSummary').status, 'error');
});

test('a capability arriving after scan starts does not unexpectedly re-enable attachments mid-round', async () => {
  const h = harness(false);
  h.plugin.progressTracker.recordHashProgress = () => { h.state.attachmentVersionCASSupported = true; };
  await h.operator.handleSync(h.plugin, false, 'auto');
  assert.equal(h.sent.some(item => item.action === 'FileSync'), false);
  assert.equal(h.plugin.expectedSyncCount, 3); assert.equal(h.plugin.fileSyncEnd, true);
});
