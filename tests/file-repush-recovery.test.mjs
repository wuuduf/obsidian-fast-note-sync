import { diagnostics } from "./helpers/diagnostics.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function gate() {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  class TFile { constructor(path, size = 3) { this.path = path; this.stat = { size, mtime: 1, ctime: 1 }; } }
  const files = new Map(); const writes = new Map(); const sent = []; const completions = []; const logs = [];
  const state = { writeGate: null, entered: null, failWrite: false, rejectSend: null, excluded: new Set() };
  const plugin = {
    settings: { syncEnabled: true, vault: 'Test', cloudPreviewEnabled: false },
    diagnostics: new diagnostics.DiagnosticContexts(),
    syncState: { activeSyncContext: 'A', pendingFilePushPageIndex: new Map() },
    pendingFileDeleteAcks: new Set(), pendingUploadHashes: new Map(), pendingFileRenames: [],
    fileDownloadSessions: new Map(), fileSyncTasks: { failed: 0, completed: 0 }, lastSyncMtime: new Map(),
    lastSyncPathRenamed: new Set(), downloadedFilesCount: 0, downloadedChunksCount: 0, totalFilesToDownload: 0, totalChunksToDownload: 0,
    recordSyncCompleted(_type, page, context) {
      if (context !== undefined && context !== (this.syncState.activeSyncContext ?? '')) return;
      this.fileSyncTasks.completed++; completions.push({ page, context });
    },
    progressTracker: { recordDownloadComplete() {} },
    concurrencyLimiter: { async waitForSlot() {}, releaseSlot() {} },
    lockManager: { async withLock(_key, operation) { return operation(); } },
    websocket: { async SendMessage(action, data) { sent.push({ action, data }); if (state.rejectSend === action) throw new Error('send failed'); } },
    localStorageManager: { getMetadata: () => 0, setMetadata() {} },
    fileHashManager: { setFileHash() {}, removeFileHash() {} }, addIgnoredFile() {}, removeIgnoredFile() {},
    app: { vault: {
      getFileByPath: (p) => files.get(p) ?? null, getFolderByPath: () => null,
      adapter: { exists: async () => false },
      async createBinary(p, bytes) {
        state.entered?.resolve(); if (state.writeGate) await state.writeGate.promise;
        if (state.failWrite) throw new Error('disk unavailable');
        writes.set(p, Buffer.from(bytes)); files.set(p, new TFile(p, bytes.byteLength));
      },
      async modifyBinary(file, bytes) { await this.createBinary(file.path, bytes); },
    } },
  };
  plugin.diagnostics.begin('A', 'original-file-root');
  const sourcePath = path.resolve(import.meta.dirname, '../src/lib/sync/operator_file.ts');
  const source = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Blob,
    window: { setTimeout() { return 1; }, clearTimeout() {} }, setTimeout, clearTimeout,
    require(id) {
      if (id.endsWith("/diagnostics")) return diagnostics;
      if (id === 'obsidian') return { TFile, TAbstractFile: class {}, normalizePath: (p) => p, Platform: { isMobile: true } };
      if (id === '../utils/helpers') return {
        dump() {}, dumpError() {}, getPluginDir: () => '.obsidian/plugins/fast-note-sync',
        isPathExcluded: (p) => state.excluded.has(p), isLargeBinarySyncRisk: () => false, checkAndNotifyCaseConflict: () => false,
        hashFileAsync: async () => 'same', hashArrayBuffer: async () => 'same', sleep: async () => {},
      };
      if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: (row) => logs.push(row), addLog: (...row) => logs.push(row) }) } };
      if (id === '../storage/file_cloud_preview') return { FileCloudPreview: { isRestrictedType: () => false } };
      if (id === '../api/http_api_service') return { HttpApiService: class {} };
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename: sourcePath });
  const ops = module.exports;
  const rename = (context = 'A', pageIndex = 2) => ops.receiveFileSyncRename({ context, pageIndex, oldPath: 'old.bin', path: 'new.bin', contentHash: 'same', size: 3 }, plugin);
  const update = (context = 'A') => ops.receiveFileSyncUpdate({ context, path: 'new.bin', pathHash: 'new', vault: 'Test', contentHash: 'same', ctime: 1, mtime: 1, lastTime: 1, size: 3 }, plugin);
  const sessionId = '00000000-0000-0000-0000-000000000001';
  const metadata = (context = 'A') => ops.receiveFileSyncChunkDownload({ context, path: 'new.bin', contentHash: 'same', ctime: 1, mtime: 1, size: 3, sessionId, chunkSize: 3, totalChunks: 1 }, plugin);
  const chunk = () => {
    const buffer = new ArrayBuffer(43); new Uint8Array(buffer).set(new TextEncoder().encode(sessionId));
    new DataView(buffer).setUint32(36, 0, false); new Uint8Array(buffer).set([1, 2, 3], 40);
    return ops.handleFileChunkDownload(buffer, plugin);
  };
  return { plugin, state, files, writes, sent, completions, logs, ops, rename, update, metadata, chunk, TFile };
}

test('a rename re-push settles its original page exactly once after the actual binary write', async () => {
  const h = harness(); await h.rename(); await h.rename();
  assert.equal(h.sent.filter((message) => message.action === 'FileRePush').length, 1);
  assert.equal(h.completions.length, 0, 'requesting re-push is not local completion');
  await h.update(); await h.metadata();
  h.state.entered = gate(); h.state.writeGate = gate();
  const pending = h.chunk(); await h.state.entered.promise;
  assert.equal(h.completions.length, 0, 'receiving all chunks is not a completed disk write');
  h.state.writeGate.resolve(); await pending;
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([1, 2, 3]));
  assert.equal(h.plugin.fileDownloadSessions.size, 0);
});

test('a failed re-pushed write settles the original page as a failure', async () => {
  const h = harness(); await h.rename(); await h.update(); await h.metadata(); h.state.failWrite = true; await h.chunk();
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]); assert.equal(h.plugin.fileDownloadSessions.size, 0);
});

test('new context and same path cannot inherit an old pending re-push page', async () => {
  const h = harness(); await h.rename('A', 2);
  h.plugin.syncState.activeSyncContext = 'B'; await h.rename('B', 7);
  await h.update('A'); assert.equal(h.plugin.fileDownloadSessions.size, 0);
  await h.update('B'); await h.metadata('B'); await h.chunk();
  assert.deepEqual(h.completions, [{ page: 7, context: 'B' }]);
});

test('an old in-flight write failure does not pollute a replacement round counters', async () => {
  const h = harness(); await h.rename(); await h.update(); await h.metadata();
  h.state.entered = gate(); h.state.writeGate = gate(); h.state.failWrite = true;
  const pending = h.chunk(); await h.state.entered.promise; h.plugin.syncState.activeSyncContext = 'B';
  h.plugin.diagnostics.begin('B', 'replacement-file-root');
  h.plugin.settings.vault = 'Replacement';
  h.state.writeGate.resolve(); await pending;
  assert.equal(h.plugin.fileSyncTasks.failed, 0); assert.equal(h.completions.length, 0);
  const failure = h.logs.find(row => row.status === 'error');
  assert.equal(failure.traceId, 'original-file-root');
  assert.equal(failure.vault, 'Test');
});

test('filtering a re-pushed file reports its deferred original page once', async () => {
  const h = harness(); await h.rename(); h.state.excluded.add('new.bin'); await h.update();
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]); assert.equal(h.plugin.fileSyncTasks.failed, 0);
});

test('an already matching rename target completes once without re-push', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); await h.rename();
  assert.equal(h.sent.length, 0); assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a failed re-push send releases the deferred request for another attempt', async () => {
  const h = harness(); h.state.rejectSend = 'FileRePush'; await h.rename();
  assert.equal(h.plugin.fileSyncTasks.failed, 1); assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
  h.state.rejectSend = null; await h.rename();
  assert.equal(h.sent.filter((message) => message.action === 'FileRePush').length, 2);
});

test('reset discards pending re-push ownership while preserving unpaged compatibility', async () => {
  const h = harness(); await h.rename(); h.ops.resetFileOperations(); await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.completions, [{ page: undefined, context: 'A' }]);
});
