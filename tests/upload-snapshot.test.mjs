import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { diagnostics } from "./helpers/diagnostics.mjs";

test("upload hashes the exact bytes sent even if the file changes after the read", async () => {
  const first = Uint8Array.from([1, 2, 3]);
  const changed = Uint8Array.from([4, 5, 6]);
  let current = first;
  let secondReads = 0;
  let finish;
  const cached = [];
  const sent = new Promise((resolve) => { finish = resolve; });
  const file = { path: "image.bin", stat: { size: 3, mtime: 1, ctime: 1 } };
  const plugin = {
    settings: { syncEnabled: true, vault: "test", cloudPreviewEnabled: false },
    diagnostics: new diagnostics.DiagnosticContexts(),
    syncState: { activeSyncContext: "A", pendingFilePushPageIndex: new Map(), attachmentConflictSupported: true, attachmentVersionCASSupported: true },
    pendingUploadHashes: new Map(), totalChunksToUpload: 0, uploadedChunksCount: 0,
    localStorageManager: { savePending() {}, getMetadata() { return 0; }, setMetadata() {} }, fileHashManager: { setFileHash(...args) { cached.push(args); } },
    concurrencyLimiter: { async waitForSlot() {}, releaseSlot() {} },
    recordSyncCompleted() {},
    websocket: { async SendMessage(action, data) {
      assert.equal(action, "FileUploadPrepare");
      module.exports.receiveFileUploadReady({ sessionId: data.sessionId }, plugin);
    }, async SendBinary(frame, _prefix, before, after) {
      assert.equal(before(), false); after(); finish(Buffer.from(frame.subarray(40))); return "sent";
    } },
    app: { loadLocalStorage() {}, saveLocalStorage() {}, vault: {
      getName: () => "test", getFileByPath: () => file,
      async readBinary() { return current.slice().buffer; },
    } },
  };
  plugin.diagnostics.begin("A", "upload-test");
  const sourcePath = path.resolve(import.meta.dirname, "../src/lib/sync/operator_file.ts");
  const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    window: { setTimeout, clearTimeout }, setTimeout, clearTimeout, crypto: webcrypto,
    require(id) {
      if (id.endsWith("/diagnostics")) return diagnostics;
      if (id === "./hash_timeout") return { withHashTimeout: work => work() };
      if (id === "./attachment_baseline") return { getAttachmentBaseSha: () => undefined, getAttachmentBaseVersion: () => undefined, validAttachmentVersion: value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), setAttachmentBaseSha() {}, getAttachmentConflict: () => undefined, setAttachmentConflict() {}, shouldDeferAttachmentConflict: () => false, setAttachmentDeletedConflict() {}, setAttachmentResolution() {}, finishAttachmentResolution() {} };
      if (id === "./attachment_conflict_copy") return { saveAttachmentConflictCopy: async () => "conflict-copy" };
      if (id === "obsidian") return { TFile: class {}, TAbstractFile: class {}, normalizePath: (p) => p, Platform: { isMobile: false } };
      if (id === "../utils/helpers") return {
        dump() {}, logMemorySnapshot() {}, sleep: async () => {}, isPathExcluded: () => false, isLargeBinarySyncRisk: () => false, getSafeCtime: (stat) => stat.ctime,
        hashArrayBuffer: async (bytes) => Buffer.from(bytes).toString("hex"),
        hashFileAsync: async () => { secondReads++; return Buffer.from(current).toString("hex"); },
      };
      if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog() {} }) } };
      if (id === "../storage/file_cloud_preview") return { FileCloudPreview: class {} };
      if (id === "../api/http_api_service") return { HttpApiService: class {} };
      throw new Error(`Unexpected module: ${id}`);
    },
  }, { filename: sourcePath });
  const sessionId = "00000000-0000-0000-0000-000000000001";
  await module.exports.receiveFileUpload({ path: file.path, pathHash: "p", sessionId, chunkSize: 3, context: "A", requiresPrepare: true, expectedContentHash: "010203", expectedSha256: createHash("sha256").update(first).digest("hex"), expectedSize: 3, expectedMtime: 1, expectedCtime: 1 }, plugin);
  const bytes = await sent;
  assert.deepEqual(bytes, Buffer.from(first));
  assert.equal(plugin.pendingUploadHashes.get(file.path), bytes.toString("hex"));
  assert.equal(secondReads, 0);
  assert.equal(cached.length, 0, "sending does not advance the synced base before the acknowledgement");
  current = changed; file.stat.mtime = 3;
  module.exports.receiveFileUploadAck({ path: file.path, pathHash: "p", sessionId, contentHash: "010203", context: "A" }, plugin);
  assert.deepEqual(cached, [[file.path, "010203", -1, -1]], "acknowledgement must not cache the old snapshot under the new file metadata");
});
