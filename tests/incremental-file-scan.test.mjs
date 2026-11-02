import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";

function load(file, requireFn = () => ({})) {
  const filename = path.resolve(import.meta.dirname, "../src/lib/sync", file);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const unrefTimeout = (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; };
  vm.runInNewContext(source, { module, exports: module.exports, require: requireFn, console, window: { setTimeout: unrefTimeout, clearTimeout } }, { filename });
  return module.exports;
}

const { shouldSkipIncrementalFile } = load("incremental_file_scan.ts");

test("incremental scans skip only a valid cache equal to the acknowledged base", () => {
  assert.equal(shouldSkipIncrementalFile(true, 100, 200, "old", "old", false), true);
  assert.equal(shouldSkipIncrementalFile(true, 100, 200, "old", null, false), false, "invalidated ACK cache must be rehashed despite older mtime");
  assert.equal(shouldSkipIncrementalFile(true, 100, 200, "old", "new", false), false, "a local change must stay eligible until it is confirmed");
  assert.equal(shouldSkipIncrementalFile(true, 100, 200, "old", "old", true), false);
  assert.equal(shouldSkipIncrementalFile(false, 100, 200, "old", "old", false), false);
  assert.equal(shouldSkipIncrementalFile(true, 100, 200, null, "old", false), false);
});

test("FileSyncEnd never validates an unacknowledged hash against current file metadata", async () => {
  const noop = () => {};
  const actions = new Proxy({}, { get: (_target, name) => name });
  const stubs = new Proxy({}, { get: () => noop });
  const operator = load("operator.ts", (id) => {
    if (id === "./websocket_action") return actions;
    if (id === "./incremental_file_scan") return { shouldSkipIncrementalFile };
    return stubs;
  });
  const pending = new Map([["image.bin", "snapshot-hash"]]);
  const cache = new Map(); const bases = new Map([["image.bin", "previous-base"]]);
  const plugin = {
    fileSyncTasks: { completed: 0 },
    progressTracker: { setDownloadTotal() {}, recordUploadComplete() {}, getTypeTaskTotal: () => 0 },
    syncState: {}, pendingDeleteFilePaths: new Set(['conflict.bin']), pendingUploadHashes: pending,
    scannedFileHashes: new Map(),
    fileHashManager: {
      removeFileHashes() { throw new Error('FileSyncEnd cannot clear unacknowledged deletes'); }, flush() {},
      setFileHashes(entries, stat) {
        for (const [key, hash] of entries) cache.set(key, { hash, ...stat(key) });
      },
    },
    localStorageManager: { clearPending() {} },
  };
  await operator.receiveOperators.get("FileSyncEnd")({ context: "A" }, plugin);
  const cached = cache.get("image.bin");
  assert.equal(cached.hash, "snapshot-hash");
  assert.equal(cached.mtime, -1); assert.equal(cached.size, -1);
  assert.equal(bases.get("image.bin"), "previous-base");
  assert.equal(pending.size, 0);
  assert.equal(plugin.pendingDeleteFilePaths.has('conflict.bin'), true);
  const currentFile = { mtime: 100, size: 3 };
  const validCache = cached.mtime === currentFile.mtime && cached.size === currentFile.size ? cached.hash : null;
  assert.equal(shouldSkipIncrementalFile(true, currentFile.mtime, 200, bases.get("image.bin"), validCache, false), false);
});

test("offline attachment deletes require CAS and are pending before the request is sent", async () => {
  const noop = () => {}, actions = new Proxy({}, { get: (_target, name) => name });
  const stubs = new Proxy({}, { get: () => noop });
  const operator = load('operator.ts', id => id === './websocket_action' ? actions : stubs);
  const handlers = new Map(), observed = [];
  const plugin = {
    settings: { syncEnabled: true, configSyncEnabled: false, cloudPreviewEnabled: false, vault: 'test', offlineDeleteSyncEnabled: true },
    syncState: { syncUpChunkNum: 100, pipelineWindowUp: 0, protectedFilesSupported: true, attachmentConflictSupported: true, attachmentVersionCASSupported: true, attachmentMutationCASSupported: false },
    websocket: { on(n, f) { handlers.set(n, f); }, off(n) { handlers.delete(n); }, async SendMessage(action, payload, _before, after) { if (action === 'FileSync') observed.push({ payload, pending: [...plugin.pendingDeleteFilePaths] }); after?.(); } },
    pendingNoteModifies: new Map(), folderSnapshotManager: { setFolderMtimes() {} }, localStorageManager: { savePending() {} },
  };
  const note = { lastTime: 0, notes: [], delNotes: [], missingNotes: [] };
  const file = { lastTime: 0, files: [], delFiles: [{ path: 'old.bin', pathHash: 'p', baseSha256: 'a'.repeat(64) }], missingFiles: [], protectedFiles: [] };
  const config = { lastTime: 0, configs: [], delConfigs: [], missingConfigs: [] };
  const folder = { lastTime: 0, folders: [], delFolders: [], missingFolders: [] };
  await assert.rejects(operator.handleRequestSend(plugin, 'note', note, file, config, folder), /安全的附件离线删除/);
  assert.equal(observed.length, 0);
  plugin.syncState.attachmentMutationCASSupported = true;
  await operator.handleRequestSend(plugin, 'note', note, file, config, folder);
  assert.deepEqual(observed[0].pending, ['old.bin']);
  assert.equal(observed[0].payload.delFiles[0].baseSha256, 'a'.repeat(64));
});

test("protected files are batched with the complete comparison and old servers are rejected", async () => {
  const noop = () => {};
  const actions = new Proxy({}, { get: (_target, name) => name });
  const stubs = new Proxy({}, { get: () => noop });
  const operator = load("operator.ts", id => id === "./websocket_action" ? actions : stubs);
  const handlers = new Map(), sent = [];
  const plugin = {
    settings: { syncEnabled: true, configSyncEnabled: false, cloudPreviewEnabled: false, vault: "test", offlineDeleteSyncEnabled: false },
    syncState: { syncUpChunkNum: 2, pipelineWindowUp: 0, protectedFilesSupported: false, attachmentConflictSupported: true, attachmentVersionCASSupported: true },
    websocket: { on(name, fn) { handlers.set(name, fn); }, off(name) { handlers.delete(name); },
      async SendMessage(action, payload, _before, after) { sent.push({ action, payload }); after?.(); if (payload.batchIndex < payload.totalBatches - 1) queueMicrotask(() => handlers.get(`${action}BatchAck`)?.({ context: payload.context, batchIndex: payload.batchIndex })); } },
    pendingNoteModifies: new Map(), folderSnapshotManager: { setFolderMtimes() {} }, localStorageManager: { savePending() {} },
  };
  const note = { lastTime: 0, notes: [], delNotes: [], missingNotes: [] };
  const file = { lastTime: 0, files: [], delFiles: [], missingFiles: [], protectedFiles: [{ path: "unread.bin", pathHash: "u" }, { path: "budget.bin", pathHash: "b" }, { path: "third.bin", pathHash: "c" }] };
  const config = { lastTime: 0, configs: [], delConfigs: [], missingConfigs: [] };
  const folder = { lastTime: 0, folders: [], delFolders: [], missingFolders: [] };
  plugin.syncState.attachmentConflictSupported = false;
  await operator.handleRequestSend(plugin, "note", note, file, config, folder);
  assert.equal(sent.some(item => item.action === 'FileSync'), false, "old service must not receive a FileSync request");
  assert.deepEqual(sent.map(item => item.action).sort(), ['FolderSync', 'NoteSync']);
  sent.length = 0;
  plugin.syncState.attachmentConflictSupported = true;
  await assert.rejects(operator.handleRequestSend(plugin, "note", note, file, config, folder), /升级同步服务/);
  assert.equal(sent.length, 0, "an old server must receive no partial FileSync");
  plugin.syncState.protectedFilesSupported = true;
  await operator.handleRequestSend(plugin, "note", note, file, config, folder);
  const payloads = sent.filter(item => item.action === "FileSync").map(item => item.payload);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads.flatMap(payload => Array.from(payload.protectedFiles, entry => entry.path)), ["unread.bin", "budget.bin", "third.bin"]);
  assert.ok(payloads.every(payload => payload.lastTime === 0));
});
