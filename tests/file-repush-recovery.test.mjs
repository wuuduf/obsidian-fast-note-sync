import { diagnostics } from "./helpers/diagnostics.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';
import { webcrypto, createHash } from 'node:crypto';

function gate() {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  class TFile { constructor(path, size = 3) { this.path = path; this.stat = { size, mtime: 1, ctime: 1 }; } }
  let sequence = 0;
  const files = new Map(); const writes = new Map(); const sent = []; const completions = []; const logs = []; const removed = []; const released = [];
  const state = { writeGate: null, entered: null, failWrite: false, rejectSend: null, excluded: new Set() };
  const plugin = {
    settings: { syncEnabled: true, vault: 'Test', cloudPreviewEnabled: false },
    diagnostics: new diagnostics.DiagnosticContexts(),
    syncState: { activeSyncContext: 'A', pendingFilePushPageIndex: new Map(), pendingFileDeleteOperations: new Map(), attachmentConflictSupported: true, attachmentRePushSafeSupported: true, attachmentMutationCASSupported: true, attachmentVersionCASSupported: true },
    pendingFileDeleteAcks: new Set(), pendingUploadHashes: new Map(), pendingFileRenames: [],
    pendingDeleteFilePaths: new Set(),
    fileDownloadSessions: new Map(), fileSyncTasks: { failed: 0, completed: 0 }, lastSyncMtime: new Map(),
    lastSyncPathRenamed: new Set(), lastSyncPathDeleted: new Set(), downloadedFilesCount: 0, downloadedChunksCount: 0, totalFilesToDownload: 0, totalChunksToDownload: 0,
    recordSyncCompleted(_type, page, context) {
      if (context !== undefined && context !== (this.syncState.activeSyncContext ?? '')) return;
      this.fileSyncTasks.completed++; completions.push({ page, context });
    },
    progressTracker: { recordDownloadComplete() {} },
    concurrencyLimiter: { async waitForSlot() {}, releaseSlot(key) { released.push(key); } },
    lockManager: { async withLock(_key, operation) { return operation(); } },
    websocket: { async SendMessage(action, data, before, after) { if (before?.()) return true; sent.push({ action, data }); if (state.rejectSend === action) throw new Error('send failed'); after?.(); } },
    localStorageManager: { getMetadata: () => 0, setMetadata() {}, savePending() {} },
    fileHashManager: { getPathHash: () => 'same', getValidHash: () => null, setFileHash() {}, removeFileHash(path) { removed.push(path); } }, addIgnoredFile() {}, removeIgnoredFile() {}, isIgnoredFile: () => false,
    app: { vault: {
      getFileByPath: (p) => files.get(p) ?? null, getFolderByPath: () => null,
      async readBinary(file) { const value = writes.get(file.path); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); },
      adapter: { exists: async () => false },
      async createBinary(p, bytes) {
        state.entered?.resolve(); if (state.writeGate) await state.writeGate.promise;
        if (state.failWrite) throw new Error('disk unavailable');
        writes.set(p, Buffer.from(bytes)); files.set(p, new TFile(p, bytes.byteLength));
      },
      async modifyBinary(file, bytes) { await this.createBinary(file.path, bytes); },
      async rename(file, nextPath) {
        if (files.has(nextPath)) throw new Error('target already exists');
        const contents = writes.get(file.path);
        writes.delete(file.path); files.delete(file.path);
        file.path = nextPath; files.set(nextPath, file);
        if (contents) writes.set(nextPath, contents);
      },
    } },
  };
  plugin.diagnostics.begin('A', 'original-file-root');
  const sourcePath = path.resolve(import.meta.dirname, '../src/lib/sync/operator_file.ts');
  const source = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, crypto: webcrypto, Uint8Array, ArrayBuffer, DataView, TextDecoder, TextEncoder, Blob,
    window: { setTimeout() { return 1; }, clearTimeout() {} }, setTimeout, clearTimeout,
    require(id) {
      if (id === './hash_timeout') return { withHashTimeout: work => work() };
      if (id === './attachment_baseline') return { getAttachmentBaseSha: () => state.baseSha, getAttachmentBaseVersion: () => state.baseSha ? "version-1" : undefined, validAttachmentVersion: value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), setAttachmentBaseSha(...args) { state.savedBase = args; }, getAttachmentConflict: () => state.conflict, setAttachmentConflict(_p, _path, sha, copyPath) { state.conflict = { remoteSha256: sha, copyPath, mutation: state.conflict?.mutation }; }, setAttachmentMutationConflict(_p, _path, mutation, sha, targetPath, _vault, remoteVersion) { if (state.failConflictState) throw new Error('storage unavailable'); state.conflict = { remoteSha256: sha, mutation, targetPath, remoteVersion }; }, clearAttachmentMutationConflict() { if (state.conflict?.mutation) state.conflict = undefined; }, setAttachmentPendingConflict() { if (state.failConflictState) throw new Error('storage unavailable'); state.conflict ??= { remoteSha256: '', pending: true }; }, clearAttachmentPendingConflict() { if (state.conflict?.pending) state.conflict = undefined; }, shouldDeferAttachmentConflict: () => false, setAttachmentDeletedConflict() { state.deletedConflict = true; }, setAttachmentResolution() {}, finishAttachmentResolution() {} };
      if (id === './attachment_conflict_copy') return { saveAttachmentConflictCopy: async (_vault, _path, bytes) => { state.copies = (state.copies || 0) + 1; writes.set('conflict-copy', Buffer.from(bytes)); files.set('conflict-copy', new TFile('conflict-copy', bytes.byteLength)); return 'conflict-copy'; } };
      if (id.endsWith("/diagnostics")) return diagnostics;
      if (id === 'obsidian') return { TFile, TAbstractFile: class {}, normalizePath: (p) => p, Platform: { isMobile: true } };
      if (id === '../utils/helpers') return {
        dump() {}, dumpError() {}, showSyncNotice() {}, generateUUID: () => `operation-${++sequence}`, getPluginDir: () => '.obsidian/plugins/fast-note-sync',
        isPathExcluded: (p) => state.excluded.has(p), isLargeBinarySyncRisk: () => false, checkAndNotifyCaseConflict: () => false,
        hashContent: p => `hash:${p}`, hashFileAsync: async () => 'same', hashArrayBuffer: async () => 'same', getSafeCtime: stat => stat.ctime, vaultDelete: async (_vault, file) => { files.delete(file.path); writes.delete(file.path); }, sleep: async () => {},
      };
      if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: (row) => logs.push(row), addLog: (...row) => logs.push(row) }) } };
      if (id === '../storage/file_cloud_preview') return { FileCloudPreview: { isRestrictedType: () => false } };
      if (id === '../api/http_api_service') return { HttpApiService: class {} };
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename: sourcePath });
  const ops = module.exports;
  const rename = (context = 'A', pageIndex = 2) => ops.receiveFileSyncRename({ context, pageIndex, oldPath: 'old.bin', path: 'new.bin', contentHash: 'same', previousVersion: 'version-1', fileVersion: 'version-2', size: 3 }, plugin);
  const update = (context = 'A', path = 'new.bin') => ops.receiveFileSyncUpdate({ context, path, pathHash: 'new', vault: 'Test', contentHash: 'same', ctime: 1, mtime: 1, lastTime: 1, size: 3 }, plugin);
  const sessionId = '00000000-0000-0000-0000-000000000001';
  const metadata = (context = 'A', path = 'new.bin') => ops.receiveFileSyncChunkDownload({ context, path, contentHash: 'same', fileVersion: 'version-1', ctime: 1, mtime: 1, size: 3, sessionId, chunkSize: 3, totalChunks: 1 }, plugin);
  const chunk = () => {
    const buffer = new ArrayBuffer(43); new Uint8Array(buffer).set(new TextEncoder().encode(sessionId));
    new DataView(buffer).setUint32(36, 0, false); new Uint8Array(buffer).set([1, 2, 3], 40);
    return ops.handleFileChunkDownload(buffer, plugin);
  };
  return { plugin, state, files, writes, sent, completions, logs, ops, rename, update, metadata, chunk, TFile, removed, released };
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

test('a different vault with a reused context cannot inherit an old rename page', async () => {
  const h = harness(); await h.rename('A', 2);
  h.plugin.settings.vault = 'Replacement';
  await h.update('A'); await h.metadata('A'); await h.chunk();
  assert.deepEqual(h.completions, [{ page: undefined, context: 'A' }]);
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

test('a rename cannot discard an existing local target despite a matching sampled hash', async () => {
  const h = harness();
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([4, 5, 6]));
  h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  h.state.baseSha = createHash('sha256').update(Buffer.from([9, 8, 7])).digest('hex');
  await h.rename();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([4, 5, 6]));
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.sent.filter(message => message.action === 'FileRePush').length, 1);
  assert.equal(h.completions.length, 0);
  await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('an existing target without the old path is verified by downloading instead of a sampled hash', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  await h.rename(); assert.equal(h.sent.filter(message => message.action === 'FileRePush').length, 1);
  assert.equal(h.completions.length, 0);
  await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a remote rename moves local changes without marking them as the server version', async () => {
  const h = harness();
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([9, 8, 7]));
  h.state.baseSha = createHash('sha256').update(Buffer.from([4, 5, 6])).digest('hex');
  await h.rename();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.sent.filter(message => message.action === 'FileRePush').length, 1);
  await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('identical rename target converges after full SHA verification and clears the pending guard', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([1, 2, 3]));
  await h.rename(); await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([1, 2, 3]));
  assert.equal(h.state.copies, undefined);
  assert.equal(h.state.conflict, undefined);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('an in-flight download cannot overwrite an occupied rename target', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  h.state.baseSha = createHash('sha256').update(Buffer.from([9, 8, 7])).digest('hex');
  await h.ops.receiveFileSyncUpdate({ context: 'A', path: 'old.bin', pathHash: 'old', contentHash: 'same', ctime: 1, mtime: 1, lastTime: 1, size: 3 }, h.plugin);
  await h.metadata('A', 'old.bin');
  await h.rename();
  await h.rename();
  assert.equal(h.sent.filter(message => message.action === 'FileRePush').length, 0, 'duplicate rename shares the redirected download');
  await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  assert.deepEqual(h.completions, [{ page: undefined, context: 'A' }, { page: 2, context: 'A' }]);
});

test('failure to persist the rename target guard leaves both local files intact', async () => {
  const h = harness();
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([4, 5, 6]));
  h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  h.state.failConflictState = true;
  await h.rename();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([4, 5, 6]));
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.sent.length, 0);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a re-push delete response settles its rename page without deleting the protected target', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  await h.rename();
  await h.ops.receiveFileSyncDelete({ path: 'new.bin', context: 'A' }, h.plugin);
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.state.deletedConflict, true);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a failed re-push settles its rename page and keeps the target retryable', async () => {
  const h = harness(); h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  await h.rename();
  h.ops.receiveFileRePushFailed({ path: 'new.bin', context: 'A' }, h.plugin);
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.state.conflict.pending, true);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
  h.plugin.syncState.activeSyncContext = null;
  assert.equal(await h.ops.retryPendingAttachmentConflict('new.bin', h.plugin), true);
  assert.equal(h.sent.filter(message => message.action === 'FileRePush').length, 2);
});

test('rename notifications from a server without safe re-push support are rejected', async () => {
  const h = harness(); h.plugin.syncState.attachmentRePushSafeSupported = false;
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([4, 5, 6]));
  await h.rename();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([4, 5, 6]));
  assert.equal(h.sent.length, 0);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('rename lock timeout reports failure without touching either file', async () => {
  const h = harness(); h.plugin.lockManager.withLock = async () => null;
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([4, 5, 6]));
  await h.rename();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([4, 5, 6]));
  assert.equal(h.sent.length, 0);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a rename waiting for a lock cannot mutate a replacement vault', async () => {
  const h = harness(); const entered = gate(); const release = gate();
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([4, 5, 6]));
  h.plugin.lockManager.withLock = async (_key, work) => { entered.resolve(); await release.promise; return work(); };
  const pending = h.rename(); await entered.promise; h.plugin.settings.vault = 'Replacement'; release.resolve(); await pending;
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([4, 5, 6]));
  assert.equal(h.sent.length, 0); assert.equal(h.completions.length, 0);
});

test('a delayed download cannot write into a replacement vault even if the context is reused', async () => {
  const h = harness();
  await h.update(); await h.metadata();
  h.plugin.settings.vault = 'Replacement';
  await h.chunk();
  assert.equal(h.writes.has('new.bin'), false);
  assert.equal(h.completions.length, 0);
  assert.equal(h.plugin.fileDownloadSessions.size, 0);
});

test('a vault switch during the local SHA read cannot overwrite an attachment', async () => {
  const h = harness(); const entered = gate(); const release = gate();
  h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  const read = h.plugin.app.vault.readBinary.bind(h.plugin.app.vault);
  h.plugin.app.vault.readBinary = async file => { entered.resolve(); await release.promise; return read(file); };
  await h.update(); await h.metadata();
  const pending = h.chunk(); await entered.promise; h.plugin.settings.vault = 'Replacement'; release.resolve(); await pending;
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.equal(h.state.copies, undefined); assert.equal(h.completions.length, 0);
  assert.equal(h.plugin.fileDownloadSessions.size, 0);
});

test('download lock timeout reports failure instead of acknowledging an unwritten file', async () => {
  const h = harness(); await h.update(); await h.metadata(); h.plugin.lockManager.withLock = async () => null;
  await h.chunk();
  assert.equal(h.writes.has('new.bin'), false);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: undefined, context: 'A' }]);
  assert.equal(h.plugin.fileDownloadSessions.size, 0);
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

test('download preserves a changed local attachment and stores the incoming version separately', async () => {
  const h = harness();
  h.files.set('new.bin', new h.TFile('new.bin'));
  h.writes.set('new.bin', Buffer.from([9, 8, 7]));
  await h.update(); await h.metadata(); await h.chunk();
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  await h.update(); await h.metadata(); await h.chunk();
  assert.equal(h.state.copies, 1, 'the same remote bytes reuse their verified conflict copy');
});

test('remote deletion preserves changed, unknown or unreadable local attachments', async () => {
  for (const mode of ['changed', 'unknown', 'unreadable', 'same']) {
    const h = harness();
    h.files.set('new.bin', new h.TFile('new.bin'));
    h.writes.set('new.bin', Buffer.from([9, 8, 7]));
    if (mode !== 'unknown') h.state.baseSha = createHash('sha256').update(mode === 'same' ? Buffer.from([9, 8, 7]) : Buffer.from([1, 2, 3])).digest('hex');
    if (mode === 'unreadable') h.plugin.app.vault.readBinary = async () => { throw new Error('read failed'); };
    await h.ops.receiveFileSyncDelete({ path: 'new.bin', previousVersion: 'version-1', context: 'A', pageIndex: 1 }, h.plugin);
    assert.equal(h.files.has('new.bin'), mode !== 'same', mode);
    assert.equal(h.state.deletedConflict === true, mode !== 'same', mode);
    assert.equal(h.completions.length, 1, mode);
  }
});

test('stale delete or rename cannot remove a same-content newer attachment', async () => {
  for (const action of ['delete', 'rename']) {
    const h = harness(); h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([1, 2, 3]));
    h.state.baseSha = createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex');
    if (action === 'delete') await h.ops.receiveFileSyncDelete({ path: 'old.bin', previousVersion: 'older', context: 'A', pageIndex: 1 }, h.plugin);
    else await h.ops.receiveFileSyncRename({ oldPath: 'old.bin', path: 'new.bin', previousVersion: 'older', fileVersion: 'newer', context: 'A', pageIndex: 1 }, h.plugin);
    assert.deepEqual(h.writes.get('old.bin'), Buffer.from([1, 2, 3]));
    assert.equal(h.writes.has('new.bin'), false);
    if (action === 'rename') assert.equal(h.sent[0].action, 'FileRePush');
  }
});

test('direct deletion and rename carry only the previously confirmed strong base', async () => {
  const h = harness(); h.state.baseSha = 'a'.repeat(64);
  await h.ops.fileDeleteByPath('old.bin', h.plugin);
  assert.equal(h.sent[0].action, 'FileDelete'); assert.equal(h.sent[0].data.baseSha256, 'a'.repeat(64));
  assert.equal(h.sent[0].data.baseVersion, 'version-1');
  assert.equal(h.sent[0].data.versionGuard, true);
  assert.equal(h.plugin.pendingFileDeleteAcks.has('old.bin'), true);
  h.state.baseSha = undefined;
  const file = new h.TFile('new.bin'); h.files.set('new.bin', file); h.writes.set('new.bin', Buffer.from([1, 2, 3]));
  await h.ops.fileRename(file, 'old.bin', h.plugin);
  assert.equal(h.sent[1].action, 'FileRename'); assert.equal(h.sent[1].data.baseHashMissing, true);
  assert.equal(h.sent[1].data.versionGuard, true);
  assert.equal(h.sent[1].data.baseSha256, undefined);
});

test('out-of-order direct deletion replies cannot settle a newer deletion or a recreated upload', async () => {
  const h = harness();
  await h.ops.fileDeleteByPath('old.bin', h.plugin);
  await h.ops.fileDeleteByPath('old.bin', h.plugin);
  const [first, second] = h.sent.map(item => item.data.operationId);
  assert.notEqual(first, second);
  h.ops.receiveFileDeleteAck({ path: 'old.bin', operationId: first }, h.plugin);
  assert.equal(h.plugin.syncState.pendingFileDeleteOperations.has(second), true);
  assert.deepEqual(h.released, [`mutation-delete:${first}`]);
  assert.equal(h.removed.length, 0);
  await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: first, path: 'old.bin', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
  h.ops.receiveFileMutationFailed({ operation: 'delete', operationId: first, path: 'old.bin' }, h.plugin);
  assert.equal(h.plugin.syncState.pendingFileDeleteOperations.has(second), true);
  assert.equal(h.state.conflict, undefined);
  h.files.set('old.bin', new h.TFile('old.bin'));
  h.plugin.pendingUploadHashes.set('old.bin', 'new-upload');
  h.ops.receiveFileDeleteAck({ path: 'old.bin', operationId: second }, h.plugin);
  assert.deepEqual(h.released, [`mutation-delete:${first}`, `mutation-delete:${second}`]);
  assert.equal(h.removed.length, 0);
  assert.equal(h.plugin.pendingUploadHashes.get('old.bin'), 'new-upload');
});

test('out-of-order direct rename replies match the operation even for identical paths', async () => {
  const h = harness(); const file = new h.TFile('new.bin');
  h.files.set('new.bin', file); h.writes.set('new.bin', Buffer.from([1, 2, 3]));
  await h.ops.fileRename(file, 'old.bin', h.plugin);
  await h.ops.fileRename(file, 'old.bin', h.plugin);
  const [first, second] = h.sent.map(item => item.data.operationId);
  assert.notEqual(first, second);
  h.ops.receiveFileRenameAck({ path: 'new.bin', operationId: first }, h.plugin);
  await h.ops.receiveFileMutationConflict({ operation: 'rename', operationId: first, path: 'old.bin', targetPath: 'new.bin', reason: 'target_exists' }, h.plugin);
  h.ops.receiveFileMutationFailed({ operation: 'rename', operationId: first, path: 'old.bin', targetPath: 'new.bin' }, h.plugin);
  assert.equal(h.plugin.pendingFileRenames.length, 1);
  assert.equal(h.plugin.pendingFileRenames[0].operationId, second);
  assert.deepEqual(h.released, [`mutation-rename:${first}`]);
  assert.equal(h.state.conflict, undefined);
  await h.ops.receiveFileMutationConflict({ operation: 'rename', operationId: second, path: 'old.bin', targetPath: 'new.bin', reason: 'target_exists' }, h.plugin);
  assert.equal(h.state.conflict.mutation, 'rename');
  assert.deepEqual(h.released, [`mutation-rename:${first}`, `mutation-rename:${second}`]);
  h.ops.receiveFileRenameAck({ path: 'new.bin', operationId: second }, h.plugin);
  assert.equal(h.released.length, 2);
});

test('direct mutation replies survive a finished or replaced sync context', async () => {
  for (const next of [null, 'B']) {
    const h = harness(); await h.ops.fileDeleteByPath('old.bin', h.plugin);
    const id = h.sent[0].data.operationId; h.plugin.syncState.activeSyncContext = next;
    await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: id, path: 'old.bin', context: 'A', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
    assert.equal(h.state.conflict.mutation, 'delete');
    assert.equal(h.released.includes(`mutation-delete:${id}`), true);
    assert.equal(h.sent[1].action, 'FileRePush'); assert.equal(h.sent[1].data.context, next ?? '');
    assert.equal(h.completions.length, 0);
    h.state.conflict = undefined; // This test harness uses a single shared conflict slot.
    await h.ops.fileDeleteByPath('other.bin', h.plugin);
    const id2 = h.sent.at(-1).data.operationId;
    h.ops.receiveFileMutationFailed({ operation: 'delete', operationId: id2, path: 'other.bin', context: 'A' }, h.plugin);
    assert.equal(h.released.includes(`mutation-delete:${id2}`), true);
    await h.ops.fileDeleteByPath('third.bin', h.plugin);
    const id3 = h.sent.at(-1).data.operationId;
    h.ops.receiveFileDeleteAck({ operationId: id3, path: 'third.bin', context: 'A' }, h.plugin);
    assert.equal(h.released.includes(`mutation-delete:${id3}`), true);
    h.plugin.pendingDeleteFilePaths.add('paged.bin');
    h.ops.receiveFileDeleteAck({ path: 'paged.bin', context: 'A', pageIndex: 1 }, h.plugin);
    assert.equal(h.plugin.pendingDeleteFilePaths.has('paged.bin'), true);
  }
});

test('a direct conflict waits for retry restart before fetching the retained remote bytes', async () => {
  const h = harness();
  const file = path.resolve(import.meta.dirname, '../src/lib/sync/sync_retry_controller.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, window: { setTimeout: () => 1, clearTimeout() {} } });
  const host = { getLog: () => ({ retryable: true, retryState: 'restart-required', retryContext: 'A' }), update() {}, vault: () => h.plugin.settings.vault, context: () => 'A', connected: () => true, failures: () => 0, restart() {} };
  h.plugin.retryRecovery = new module.exports.SyncRetryController(host);
  h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
  await h.ops.fileDeleteByPath('old.bin', h.plugin); const id = h.sent[0].data.operationId;
  assert.equal(h.plugin.retryRecovery.retry('log'), true); assert.equal(h.plugin.retryRecovery.acceptsContext(), false);
  await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: id, path: 'old.bin', context: 'A', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
  assert.equal(h.sent.length, 1); assert.equal(h.state.conflict.mutation, 'delete');
  h.plugin.syncState.activeSyncContext = 'B'; h.plugin.retryRecovery.started('B', 'Test');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent[1].action, 'FileRePush'); assert.equal(h.sent[1].data.context, 'B');
  await h.update('B', 'old.bin'); await h.metadata('B', 'old.bin'); await h.chunk();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([1, 2, 3]));
  assert.equal(h.state.conflict.mutation, 'delete'); h.plugin.retryRecovery.clear();
});

test('cancel and unload discard deferred fetches while retaining the conflict', async () => {
  for (const event of ['interrupt', 'clear']) {
    const h = harness();
    const file = path.resolve(import.meta.dirname, '../src/lib/sync/sync_retry_controller.ts');
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, window: { setTimeout: () => 1, clearTimeout() {} } });
    const host = { getLog: () => ({ retryable: true, retryState: 'restart-required', retryContext: 'A' }), update() {}, vault: () => 'Test', context: () => 'A', connected: () => true, failures: () => 0, restart() {} };
    h.plugin.retryRecovery = new module.exports.SyncRetryController(host);
    h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
    await h.ops.fileDeleteByPath('old.bin', h.plugin); const id = h.sent[0].data.operationId;
    h.plugin.retryRecovery.retry('log');
    await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: id, path: 'old.bin', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
    if (event === 'interrupt') h.plugin.retryRecovery.interrupt('cancelled'); else h.plugin.retryRecovery.clear();
    h.plugin.syncState.activeSyncContext = 'B'; h.plugin.retryRecovery.started('B', 'Test');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.sent.length, 1); assert.equal(h.state.conflict.mutation, 'delete');
  }
});

test('deferred mutation fetch is discarded after a vault or connection change', async () => {
  for (const change of ['vault', 'connection']) {
    const h = harness(); let resume;
    h.plugin.retryRecovery = { acceptsContext: () => false, whenContextAccepted: callback => { resume = callback; } };
    h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
    await h.ops.fileDeleteByPath('old.bin', h.plugin); const id = h.sent[0].data.operationId;
    await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: id, path: 'old.bin', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
    if (change === 'vault') h.plugin.settings.vault = 'Other'; else h.plugin.websocket.count++;
    resume(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.sent.length, 1); assert.equal(h.state.conflict.mutation, 'delete');
  }
});

test('manual mutation retry works for an absent old path and refuses unsafe or changed state', async () => {
  const h = harness(); h.state.conflict = { mutation: 'delete', remoteSha256: 'a'.repeat(64) };
  h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
  h.plugin.syncState.activeSyncContext = null;
  await h.ops.retryAttachmentMutationConflict('old.bin', h.plugin);
  assert.equal(h.sent[0].action, 'FileRePush'); assert.equal(h.sent[0].data.path, 'old.bin');
  h.state.conflict.remoteSha256 = '';
  await assert.rejects(h.ops.retryAttachmentMutationConflict('old.bin', h.plugin), /人工检查/);
  h.state.conflict.remoteSha256 = 'a'.repeat(64); h.plugin.syncState.activeSyncContext = 'B';
  await assert.rejects(h.ops.retryAttachmentMutationConflict('old.bin', h.plugin), /等待/);
  h.plugin.syncState.activeSyncContext = null;
  h.plugin.websocket.SendMessage = async (_action, _data, before, after) => { h.plugin.settings.vault = 'Other'; if (!before()) after(); };
  await assert.rejects(h.ops.retryAttachmentMutationConflict('old.bin', h.plugin), /已变化/);
});

test('manual mutation retry downloads without counting an unpaged sync task', async () => {
  const h = harness(); h.state.conflict = { mutation: 'delete', remoteSha256: 'a'.repeat(64) };
  h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
  h.plugin.syncState.activeSyncContext = null;
  await h.ops.retryAttachmentMutationConflict('old.bin', h.plugin);
  await h.update('', 'old.bin'); await h.metadata('', 'old.bin'); await h.chunk();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([1, 2, 3]));
  assert.equal(h.completions.length, 0); assert.equal(h.plugin.fileSyncTasks.completed, 0); assert.equal(h.plugin.fileSyncTasks.failed, 0);
  assert.equal(h.state.conflict.mutation, 'delete');
  assert.equal(h.state.savedBase[5], 'version-1', 'the downloaded bytes use the chunk-session version');
});

test('manual mutation retry removes its owner when send fails or is cancelled', async () => {
  for (const failure of ['send', 'cancel']) {
    const h = harness(); h.state.conflict = { mutation: 'delete', remoteSha256: 'a'.repeat(64) };
    h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
    h.plugin.syncState.activeSyncContext = null;
    if (failure === 'send') h.state.rejectSend = 'FileRePush';
    else h.plugin.websocket.SendMessage = async (_action, _data, before) => { h.plugin.websocket.count++; before(); };
    await assert.rejects(h.ops.retryAttachmentMutationConflict('old.bin', h.plugin));
    await h.update('', 'old.bin'); await h.metadata('', 'old.bin'); await h.chunk();
    assert.ok(h.completions.length > 0, 'subsequent ordinary download must not inherit failed retry owner');
  }
});

test('a buffered manual retry rejects replaced or cleared mutation state even with the same SHA', async () => {
  for (const replacement of [undefined, { remoteSha256: 'a'.repeat(64) }, { mutation: 'rename', targetPath: 'next.bin', remoteSha256: 'a'.repeat(64) }, { mutation: 'rename', targetPath: 'other.bin', remoteSha256: 'a'.repeat(64) }]) {
    const h = harness(); h.state.conflict = { mutation: 'rename', targetPath: 'next.bin', remoteSha256: 'a'.repeat(64) };
    h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
    h.plugin.syncState.activeSyncContext = null;
    const entered = gate(), release = gate(); let sent = false;
    h.plugin.websocket.SendMessage = async (_action, _data, before, after) => { entered.resolve(); await release.promise; if (!before()) { sent = true; after(); } };
    const pending = h.ops.retryAttachmentMutationConflict('old.bin', h.plugin); await entered.promise;
    h.state.conflict = replacement; release.resolve();
    if (replacement?.mutation === 'rename' && replacement.targetPath === 'next.bin') {
      await pending; assert.equal(sent, true);
    } else {
      await assert.rejects(pending, /已变化/); assert.equal(sent, false);
    }
  }
});

test('a deferred mutation fetch ignores a replacement with the same SHA', async () => {
  const h = harness(); let resume;
  h.plugin.retryRecovery = { acceptsContext: () => false, whenContextAccepted: callback => { resume = callback; } };
  h.plugin.websocket.count = 1; h.plugin.websocket.isConnected = () => true; h.plugin.websocket.isAuth = true;
  await h.ops.fileDeleteByPath('old.bin', h.plugin); const id = h.sent[0].data.operationId;
  await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: id, path: 'old.bin', reason: 'base_changed', remoteSha256: 'a'.repeat(64) }, h.plugin);
  h.state.conflict = { mutation: 'rename', targetPath: 'new.bin', remoteSha256: 'a'.repeat(64) };
  resume(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.sent.length, 1);
});

test('a paged mutation re-push cancelled by replacement settles its page without changing the new marker', async () => {
  const h = harness(); const entered = gate(), release = gate(); let sent = false;
  h.plugin.pendingDeleteFilePaths.add('old.bin');
  h.plugin.websocket.SendMessage = async (_action, _data, before, after) => { entered.resolve(); await release.promise; if (!before()) { sent = true; after(); } };
  const pending = h.ops.receiveFileMutationConflict({ operation: 'delete', path: 'old.bin', reason: 'base_changed', remoteSha256: 'a'.repeat(64), context: 'A', pageIndex: 3 }, h.plugin);
  await entered.promise; h.state.conflict = { mutation: 'rename', targetPath: 'new.bin', remoteSha256: 'a'.repeat(64) }; release.resolve(); await pending;
  assert.equal(sent, false); assert.equal(h.state.conflict.mutation, 'rename');
  assert.equal(h.plugin.fileSyncTasks.failed, 1); assert.deepEqual(h.completions, [{ page: 3, context: 'A' }]);
});

test('an unsent mutation releases its own slot and retains the previous base', async () => {
  const h = harness(); h.state.rejectSend = 'FileDelete'; h.state.baseSha = 'a'.repeat(64);
  await assert.rejects(h.ops.fileDeleteByPath('old.bin', h.plugin), /send failed/);
  assert.deepEqual(h.released, ['mutation-delete:operation-1']); assert.equal(h.removed.length, 0);
  assert.equal(h.plugin.pendingFileDeleteAcks.has('old.bin'), false);
});

test('a mutation waiting for a lock cannot be sent into another vault', async () => {
  const h = harness(), entered = gate(), release = gate();
  h.plugin.lockManager.withLock = async (_key, work) => { entered.resolve(); await release.promise; return work(); };
  const pending = h.ops.fileDeleteByPath('old.bin', h.plugin); await entered.promise;
  h.plugin.settings.vault = 'Replacement'; release.resolve(); await pending;
  assert.equal(h.sent.length, 0); assert.equal(h.removed.length, 0);
});

test('a server without mutation CAS never receives an attachment deletion or rename', async () => {
  const h = harness(); h.plugin.syncState.attachmentMutationCASSupported = false;
  const file = new h.TFile('new.bin'); h.files.set('new.bin', file); h.writes.set('new.bin', Buffer.from([1, 2, 3]));
  await h.ops.fileDeleteByPath('old.bin', h.plugin); await h.ops.fileRename(file, 'old.bin', h.plugin);
  assert.equal(h.sent.length, 0); assert.equal(h.removed.length, 0);
});

test('a server without attachment version CAS cannot receive deletion or rename', async () => {
  const h = harness(); h.plugin.syncState.attachmentVersionCASSupported = false;
  const file = new h.TFile('new.bin'); h.files.set('new.bin', file); h.writes.set('new.bin', Buffer.from([1, 2, 3]));
  await h.ops.fileDeleteByPath('old.bin', h.plugin); await h.ops.fileRename(file, 'old.bin', h.plugin);
  assert.equal(h.sent.length, 0); assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin'), undefined);
});

test('offline deletion protects unresolved mutations and never invents a strong base', () => {
  const h = harness(); h.state.baseSha = 'a'.repeat(64);
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin').baseSha256, 'a'.repeat(64));
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin').baseVersion, 'version-1');
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin').versionGuard, true);
  h.state.baseSha = undefined;
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin').baseHashMissing, true);
  h.state.conflict = { mutation: 'delete', remoteSha256: 'b'.repeat(64) };
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin'), undefined);
  h.state.conflict = undefined; h.plugin.syncState.attachmentMutationCASSupported = false;
  assert.equal(h.ops.offlineAttachmentDeletion(h.plugin, 'old.bin'), undefined);
});

test('a paged delete conflict keeps the base until the remote version has reached disk', async () => {
  const h = harness(); h.plugin.pendingDeleteFilePaths.add('old.bin');
  await h.ops.receiveFileMutationConflict({ operation: 'delete', path: 'old.bin', remoteSha256: 'a'.repeat(64), reason: 'base_changed', context: 'A', pageIndex: 2 }, h.plugin);
  assert.equal(h.plugin.pendingDeleteFilePaths.has('old.bin'), false);
  assert.equal(h.state.conflict.mutation, 'delete'); assert.equal(h.removed.length, 0);
  assert.equal(h.sent[0].action, 'FileRePush'); assert.equal(h.completions.length, 0);
  await h.update('A', 'old.bin'); await h.metadata('A', 'old.bin'); await h.chunk();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([1, 2, 3]));
  assert.equal(h.state.conflict.mutation, 'delete');
  assert.equal(h.state.conflict.remoteSha256, createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.deepEqual(h.completions, [{ page: 2, context: 'A' }]);
});

test('a recreated old path and renamed target survive a conflicting rename', async () => {
  const h = harness(); h.plugin.pendingFileRenames.push({ oldPath: 'old.bin', newPath: 'new.bin', contentHash: 'same', operationId: 'rename-1', slotKey: 'mutation-rename:rename-1', vault: 'Test' });
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([9, 8, 7]));
  h.files.set('new.bin', new h.TFile('new.bin')); h.writes.set('new.bin', Buffer.from([4, 5, 6]));
  await h.ops.receiveFileMutationConflict({ operation: 'rename', operationId: 'rename-1', path: 'old.bin', targetPath: 'new.bin', remoteSha256: 'a'.repeat(64), reason: 'base_changed', context: 'A' }, h.plugin);
  assert.equal(h.plugin.pendingFileRenames.length, 0); assert.deepEqual(h.released, ['mutation-rename:rename-1']);
  await h.update('A', 'old.bin'); await h.metadata('A', 'old.bin'); await h.chunk();
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('new.bin'), Buffer.from([4, 5, 6]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
  assert.equal(h.state.conflict.mutation, 'rename'); assert.equal(h.removed.length, 0);
  assert.equal(h.plugin.fileSyncTasks.failed, 0, 'unpaged event must not affect the active page');
  assert.equal(h.completions.length, 0);
});

test('failed mutation and re-push release only their matching slots and settle each page once', async () => {
  const h = harness(); h.plugin.pendingFileDeleteAcks.add('old.bin'); h.plugin.pendingDeleteFilePaths.add('old.bin');
  h.plugin.syncState.pendingFileDeleteOperations.set('direct-1', { path: 'old.bin', vault: 'Test', slotKey: 'mutation-delete:direct-1' });
  h.ops.receiveFileMutationFailed({ operation: 'delete', path: 'old.bin', context: 'A', pageIndex: 3 }, h.plugin);
  h.ops.receiveFileMutationFailed({ operation: 'delete', path: 'old.bin', context: 'A', pageIndex: 3 }, h.plugin);
  assert.deepEqual(h.released, []); assert.equal(h.removed.length, 0);
  h.ops.receiveFileMutationFailed({ operation: 'delete', operationId: 'direct-1', path: 'old.bin', context: 'A' }, h.plugin);
  assert.deepEqual(h.released, ['mutation-delete:direct-1']);
  assert.deepEqual(h.completions, [{ page: 3, context: 'A' }]);
  h.state.rejectSend = 'FileRePush';
  await h.ops.receiveFileMutationConflict({ operation: 'delete', path: 'other.bin', remoteSha256: 'a'.repeat(64), reason: 'base_changed', context: 'A', pageIndex: 4 }, h.plugin);
  assert.equal(h.state.conflict.mutation, 'delete'); assert.equal(h.removed.length, 0);
  assert.deepEqual(h.completions, [{ page: 3, context: 'A' }, { page: 4, context: 'A' }]);
});

test('remote lookup failure settles a mutation conflict once without counting a second failure', async () => {
  const h = harness();
  await h.ops.receiveFileMutationConflict({ operation: 'delete', path: 'old.bin', remoteSha256: 'a'.repeat(64), reason: 'base_changed', context: 'A', pageIndex: 8 }, h.plugin);
  h.ops.receiveFileRePushFailed({ path: 'old.bin', context: 'A' }, h.plugin);
  assert.equal(h.plugin.fileSyncTasks.failed, 1);
  assert.equal(h.state.conflict.mutation, 'delete'); assert.deepEqual(h.completions, [{ page: 8, context: 'A' }]);
});

test('a successful paged delete ACK only clears its own missing path and settles once', () => {
  const h = harness(); h.plugin.pendingDeleteFilePaths.add('old.bin'); h.plugin.pendingDeleteFilePaths.add('other.bin');
  h.ops.receiveFileDeleteAck({ path: 'old.bin', context: 'A', pageIndex: 4 }, h.plugin);
  h.ops.receiveFileDeleteAck({ path: 'old.bin', context: 'A', pageIndex: 4 }, h.plugin);
  assert.deepEqual(h.removed, ['old.bin']); assert.equal(h.plugin.pendingDeleteFilePaths.has('other.bin'), true);
  assert.deepEqual(h.completions, [{ page: 4, context: 'A' }]);
});

test('a paged delete ACK never clears a recreated local path', () => {
  const h = harness(); h.plugin.pendingDeleteFilePaths.add('old.bin'); h.files.set('old.bin', new h.TFile('old.bin'));
  h.plugin.pendingUploadHashes.set('old.bin', 'new-snapshot');
  h.state.baseSha = 'b'.repeat(64);
  h.ops.receiveFileDeleteAck({ path: 'old.bin', context: 'A', pageIndex: 5 }, h.plugin);
  assert.equal(h.removed.length, 0); assert.equal(h.plugin.pendingUploadHashes.get('old.bin'), 'new-snapshot');
  assert.equal(h.state.baseSha, 'b'.repeat(64)); assert.equal(h.released.length, 0);
  assert.deepEqual(h.completions, [{ page: 5, context: 'A' }]);
});

test('ambiguous mutation conflicts never request another path and each page settles', async () => {
  for (const reason of ['path_mismatch', 'target_exists', 'remote_deleted', 'invalid_base']) {
    const h = harness();
    h.plugin.pendingFileRenames.push({ oldPath: 'old.bin', newPath: 'new.bin', contentHash: 'same', operationId: 'rename-1', slotKey: 'mutation-rename:rename-1', vault: 'Test' });
    await h.ops.receiveFileMutationConflict({ operation: 'rename', operationId: 'rename-1', path: 'old.bin', targetPath: 'new.bin', remoteSha256: 'a'.repeat(64), reason, context: 'A' }, h.plugin);
    assert.equal(h.sent.length, 0, reason); assert.equal(h.state.conflict.mutation, 'rename', reason);
    assert.equal(h.completions.length, 0, reason);
  }
});

test('an unpaged mutation conflict during a sync cannot acknowledge or fail its page', async () => {
  const h = harness();
  h.files.set('old.bin', new h.TFile('old.bin')); h.writes.set('old.bin', Buffer.from([9, 8, 7]));
  h.plugin.syncState.pendingFileDeleteOperations.set('delete-1', { path: 'old.bin', vault: 'Test', slotKey: 'mutation-delete:delete-1' });
  await h.ops.receiveFileMutationConflict({ operation: 'delete', operationId: 'delete-1', path: 'old.bin', remoteSha256: 'a'.repeat(64), reason: 'base_changed', context: 'A' }, h.plugin);
  await h.update('A', 'old.bin'); await h.metadata('A', 'old.bin'); await h.chunk();
  assert.equal(h.completions.length, 0); assert.equal(h.plugin.fileSyncTasks.failed, 0);
  assert.deepEqual(h.writes.get('old.bin'), Buffer.from([9, 8, 7]));
  assert.deepEqual(h.writes.get('conflict-copy'), Buffer.from([1, 2, 3]));
});

test('a rename ACK matches its destination even when responses arrive out of order', () => {
  const h = harness();
  h.plugin.pendingFileRenames.push({ oldPath: 'one-old.bin', newPath: 'one-new.bin', contentHash: '1', operationId: 'one', slotKey: 'mutation-rename:one', vault: 'Test' });
  h.plugin.pendingFileRenames.push({ oldPath: 'two-old.bin', newPath: 'two-new.bin', contentHash: '2', operationId: 'two', slotKey: 'mutation-rename:two', vault: 'Test' });
  h.ops.receiveFileRenameAck({ path: 'two-new.bin', operationId: 'two' }, h.plugin);
  assert.deepEqual(h.plugin.pendingFileRenames.map(item => item.newPath), ['one-new.bin']);
  assert.deepEqual(h.released, ['mutation-rename:two']); assert.deepEqual(h.removed, ['two-old.bin']);
  h.ops.receiveFileRenameAck({ path: 'unknown.bin', operationId: 'one' }, h.plugin);
  assert.deepEqual(h.released, ['mutation-rename:two']);
});

test('accepting a mutation conflict requires the full fetched SHA and never writes to the server', async () => {
  const h = harness(); const file = new h.TFile('old.bin'); h.files.set('old.bin', file); h.writes.set('old.bin', Buffer.from([1, 2, 3]));
  h.state.conflict = { mutation: 'delete', remoteSha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'), remoteVersion: 'version-1' };
  await h.ops.acceptAttachmentMutationRemote(file, h.plugin);
  assert.equal(h.state.conflict, undefined); assert.equal(h.sent.length, 0);
  h.state.conflict = { mutation: 'rename', remoteSha256: 'a'.repeat(64), remoteVersion: 'version-1' };
  await assert.rejects(h.ops.acceptAttachmentMutationRemote(file, h.plugin), /不一致/);
  assert.equal(h.state.conflict.mutation, 'rename'); assert.equal(h.sent.length, 0);
});

test('accepting a mutation conflict cannot clear it after a vault switch during hashing', async () => {
  const h = harness(); const file = new h.TFile('old.bin'); h.files.set('old.bin', file); h.writes.set('old.bin', Buffer.from([1, 2, 3]));
  h.state.conflict = { mutation: 'delete', remoteSha256: createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'), remoteVersion: 'version-1' };
  const entered = gate(), release = gate(); const read = h.plugin.app.vault.readBinary.bind(h.plugin.app.vault);
  h.plugin.app.vault.readBinary = async file => { entered.resolve(); await release.promise; return read(file); };
  const promise = h.ops.acceptAttachmentMutationRemote(file, h.plugin); await entered.promise;
  h.plugin.settings.vault = 'Replacement'; release.resolve();
  await assert.rejects(promise, /不一致/); assert.equal(h.state.conflict.mutation, 'delete');
});
