import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { diagnostics } from "./diagnostics.mjs";

export function createUploadRuntime(bytes = Buffer.from("one"), options = {}) {
  class TFile { constructor() { this.path = "a.bin"; this.stat = { size: bytes.length, mtime: 10, ctime: 9 }; } }
  const file = new TFile();
  const logs = [], sent = [], messages = [], cached = [], completed = [], released = [], deleted = [], reads = [];
  const storage = new Map();
  let current = Buffer.from(bytes);
  let rollingHash = "42";
  let runtime;
  const plugin = {
    settings: { syncEnabled: true, vault: "test", cloudPreviewEnabled: false },
    diagnostics: new diagnostics.DiagnosticContexts(),
    syncState: { activeSyncContext: "A", pendingFilePushPageIndex: new Map(), attachmentConflictSupported: true, attachmentVersionCASSupported: true },
    pendingUploadHashes: new Map(), pendingFileDeleteAcks: new Set(), totalChunksToUpload: 0, uploadedChunksCount: 0,
    lastSyncMtime: new Map(), fileSyncTasks: { failed: 0 },
    localStorageManager: { savePending() {}, getMetadata() { return 0; }, setMetadata() {} },
    fileHashManager: { setFileHash(...args) { cached.push(args); }, setFileHashes() {}, getPathHash() { return null; }, getValidHash() { return null; }, removeFileHash() {} },
    concurrencyLimiter: { async waitForSlot() {}, releaseSlot(path) { released.push(path); } },
    lockManager: { withLock(_path, work) { return work(); } }, addIgnoredFile() {}, removeIgnoredFile() {},
    recordSyncCompleted(...args) { completed.push(args); },
    websocket: {
      async SendMessage(action, data, before, after) { if (before?.()) return; messages.push({ action, data }); after?.(); },
      async SendBinary(frame, _prefix, before, after) {
        if (before()) return "cancelled";
        sent.push(Buffer.from(frame)); after(); return "sent";
      },
    },
    app: { loadLocalStorage: key => storage.get(key), saveLocalStorage: (key, value) => storage.set(key, value), vault: {
      getName: () => "test", getFileByPath: () => file,
      async readBinary() { reads.push(current.length); return Uint8Array.from(current).buffer; },
    } },
  };
  plugin.diagnostics.begin("A", "upload-test");
  const filename = path.resolve(import.meta.dirname, "../../src/lib/sync/operator_file.ts");
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const schedule = (fn, ms, ...args) => setTimeout(fn, ms === 15000 && options.prepareTimeoutMs !== undefined ? options.prepareTimeoutMs : ms, ...args);
  vm.runInNewContext(source, { module, exports: module.exports, console, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder, crypto: webcrypto,
    window: { setTimeout: schedule, clearTimeout }, setTimeout: schedule, clearTimeout,
    require(id) {
      if (id.endsWith("/diagnostics")) return diagnostics;
      if (id === "./hash_timeout") return { withHashTimeout: work => work() };
      if (id === "./attachment_baseline") return { getAttachmentBaseSha: () => undefined, getAttachmentBaseVersion: () => undefined, validAttachmentVersion: value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), setAttachmentBaseSha() {}, getAttachmentConflict: () => undefined, setAttachmentConflict() {}, shouldDeferAttachmentConflict: () => false, setAttachmentDeletedConflict() {}, setAttachmentResolution() {}, finishAttachmentResolution() {}, ...options.baseline };
      if (id === "./attachment_conflict_copy") return { saveAttachmentConflictCopy: async () => "conflict-copy" };
      if (id === "obsidian") return { TFile, TAbstractFile: class {}, normalizePath: p => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return {
        dump() {}, dumpError() {}, showSyncNotice() {}, logMemorySnapshot() {}, sleep: async () => {}, isPathExcluded: () => false, isLargeBinarySyncRisk: () => false,
        getSafeCtime: stat => stat.ctime, hashContent: () => "pathhash", hashArrayBuffer: async () => rollingHash, generateUUID: () => "test-check", vaultDelete: async (_vault, f) => { deleted.push(f.path); },
      };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog(entry) { logs.push(entry); }, addLog(...entry) { logs.push(entry); } }) } };
      if (id === "../storage/file_cloud_preview") return { FileCloudPreview: class {} };
      if (id === "../api/http_api_service") return { HttpApiService: class { async getFileInfo() { return { path: file.path, size: file.stat.size, mtime: file.stat.mtime }; } } };
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename });
  runtime = module.exports;
  return { plugin, runtime, file, logs, sent, messages, cached, completed, released, deleted, reads, storage, setBytes(value) { current = Buffer.from(value); }, setHash(value) { rollingHash = value; } };
}

export async function waitUntil(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("condition not reached");
}
