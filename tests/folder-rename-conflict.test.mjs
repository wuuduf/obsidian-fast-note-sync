import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

function harness() {
  class TFolder { constructor(path) { this.path = path; } }
  const old = new TFolder('old');
  const target = new TFolder('new');
  const entries = new Map([['old', old], ['new', target], ['new/photo.png', { path: 'new/photo.png', bytes: 'local attachment' }]]);
  const deleted = [], renamed = [], completed = [], logs = [], notices = [];
  const plugin = {
    settings: { syncEnabled: true, vault: 'A' }, syncState: { activeSyncContext: 'ctx' },
    folderSyncTasks: { failed: 0 }, lastSyncPathRenamed: new Set(),
    lockManager: { async withLock(_key, operation) { return operation(); } },
    recordSyncCompleted: (...args) => completed.push(args), addIgnoredFile() {}, removeIgnoredFile() {},
    folderSnapshotManager: { removeFolder() {}, setFolderMtime() {} },
    localStorageManager: { getMetadata: () => 0, setMetadata() {} },
    app: { vault: {
      getAbstractFileByPath: path => entries.get(path) ?? null,
      async rename(folder, next) { renamed.push([folder.path, next]); entries.delete(folder.path); folder.path = next; entries.set(next, folder); },
    } },
  };
  const file = path.resolve(import.meta.dirname, '../src/lib/sync/operator_folder.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, window: { setTimeout() {} },
    require(id) {
      if (id === 'obsidian') return { TFolder, normalizePath: p => p };
      if (id.endsWith('/diagnostics')) return { sourceTraceId: () => 'trace' };
      if (id.endsWith('/helpers')) return { dump() {}, dumpError() {}, isFolderSyncPathExcluded: () => false, checkAndNotifyCaseConflict: () => false, showSyncNotice: msg => notices.push(msg),
        vaultDelete: async (_vault, entry) => { deleted.push(entry.path); for (const key of entries.keys()) if (key === entry.path || key.startsWith(entry.path + '/')) entries.delete(key); } };
      if (id === './sync_log_manager') return { SyncLogManager: { getInstance: () => ({ addLog: (...args) => logs.push(args) }) } };
      return {};
    },
  }, { filename: file });
  const run = () => module.exports.receiveFolderSyncRename({ oldPath: 'old', path: 'new', context: 'ctx', pageIndex: 2 }, plugin);
  return { plugin, old, target, entries, deleted, renamed, completed, logs, notices, run };
}

test('remote folder rename preserves an occupied target and its attachments', async () => {
  const h = harness(); await h.run();
  assert.equal(h.entries.get('old'), h.old);
  assert.equal(h.entries.get('new'), h.target);
  assert.equal(h.entries.get('new/photo.png').bytes, 'local attachment');
  assert.deepEqual(h.deleted, []); assert.deepEqual(h.renamed, []);
  assert.equal(h.plugin.folderSyncTasks.failed, 1);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.completed, [['folder', 2, 'ctx']]);
});

test('folder rename proceeds when the destination is absent', async () => {
  const h = harness(); h.entries.delete('new'); h.entries.delete('new/photo.png'); await h.run();
  assert.equal(h.entries.get('new'), h.old); assert.equal(h.entries.has('old'), false);
  assert.deepEqual(h.renamed, [['old', 'new']]); assert.equal(h.plugin.folderSyncTasks.failed, 0);
});

test('a folder rename waiting on a lock cannot affect a replacement vault', async () => {
  const h = harness(); let release, enter;
  const waiting = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { enter = resolve; });
  h.plugin.lockManager.withLock = async (_key, work) => { enter(); await waiting; return work(); };
  const running = h.run(); await entered; h.plugin.settings.vault = 'B'; release(); await running;
  assert.equal(h.entries.get('old'), h.old); assert.equal(h.entries.get('new'), h.target);
  assert.deepEqual(h.deleted, []); assert.deepEqual(h.completed, []);
});

test('a folder rename lock timeout is a failure and does not mutate either folder', async () => {
  const h = harness(); h.plugin.lockManager.withLock = async () => null; await h.run();
  assert.equal(h.entries.get('old'), h.old); assert.equal(h.entries.get('new'), h.target);
  assert.equal(h.plugin.folderSyncTasks.failed, 1);
  assert.deepEqual(h.completed, [['folder', 2, 'ctx']]);
});
