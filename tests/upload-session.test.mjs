import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createUploadRuntime, waitUntil } from "./helpers/upload-runtime.mjs";

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const request = (sessionId, bytes) => ({ path: "a.bin", pathHash: "pathhash", sessionId, context: "A", chunkSize: 3,
  requiresPrepare: true, expectedContentHash: "42", expectedSha256: createHash("sha256").update(bytes).digest("hex"),
  expectedSize: bytes.length, expectedMtime: 10, expectedCtime: 9 });

test("unchanged local conflict is not uploaded again, but later edits can be submitted", async () => {
  const baselineSource = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/attachment_baseline.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(baselineSource, { module, exports: module.exports, encodeURIComponent });
  const baseline = module.exports;
  const h = createUploadRuntime(Buffer.from("one"), { baseline });
  const sha = createHash("sha256").update("one").digest("hex");
  h.runtime.receiveFileConflict({ path: "a.bin", remoteSha256: "a".repeat(64), incomingSha256: sha, context: "A", pageIndex: 2 }, h.plugin);
  assert.deepEqual(h.completed[0], ['file', 2, 'A']);
  await h.runtime.fileModify(h.file, h.plugin);
  await h.runtime.fileModify(h.file, h.plugin);
  assert.equal(h.messages.length, 0);
  h.setBytes(Buffer.from("two"));
  await h.runtime.fileModify(h.file, h.plugin);
  assert.equal(h.messages.filter(m => m.action === "FileUploadCheck").length, 1);
  assert.equal(h.messages[0].data.snapshotSha256, createHash("sha256").update("two").digest("hex"));
});

test("a remote-deleted conflict remains protected after reload and local edits", async () => {
  const source = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/attachment_baseline.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, encodeURIComponent });
  const baseline = module.exports;
  const h = createUploadRuntime(Buffer.from("one"), { baseline });
  h.runtime.receiveFileConflict({ path: "a.bin", reason: "remote_deleted", incomingSha256: createHash("sha256").update("one").digest("hex"), context: "A", pageIndex: 3 }, h.plugin);
  assert.equal(baseline.getAttachmentConflict(h.plugin, "a.bin").deleted, true);
  assert.deepEqual(h.completed[0], ['file', 3, 'A']);
  await h.runtime.fileModify(h.file, h.plugin);
  h.setBytes(Buffer.from("two"));
  await h.runtime.fileModify(h.file, h.plugin);
  assert.equal(h.messages.length, 0);
});

test("a service without attachment conflict capability cannot send or receive attachment writes", async () => {
  const h = createUploadRuntime(); h.plugin.syncState.attachmentConflictSupported = false;
  await h.runtime.fileModify(h.file, h.plugin);
  await h.runtime.receiveFileUpload(request(id(1), Buffer.from("one")), h.plugin);
  await h.runtime.receiveFileSyncUpdate({ path: 'a.bin', pathHash: 'pathhash', context: 'A' }, h.plugin);
  assert.equal(h.messages.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.reads.length, 0);
});

test("explicit keep-local resolution sends the chosen remote SHA as the CAS base", async () => {
  const h = createUploadRuntime(Buffer.from('one'), { baseline: { getAttachmentConflict: () => ({ remoteVersion: 'version-1' }) } });
  await h.runtime.fileModify(h.file, h.plugin, false, "a".repeat(64));
  const check = h.messages.find(message => message.action === "FileUploadCheck");
  assert.equal(check.data.baseSha256, "a".repeat(64));
  assert.equal(check.data.baseVersion, 'version-1');
  assert.notEqual(check.data.baseHashMissing, true);
  assert.equal(check.data.snapshotSha256, createHash("sha256").update("one").digest("hex"));
});

test('legacy SHA-only upload base stays unknown until a server version is confirmed', async () => {
  const source = ts.transpileModule(fs.readFileSync(new URL('../src/lib/sync/attachment_baseline.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; vm.runInNewContext(source, { module, exports: module.exports, encodeURIComponent });
  const baseline = module.exports, h = createUploadRuntime(Buffer.from('one'), { baseline });
  h.plugin.fileHashManager.getPathHash = () => '42';
  baseline.setAttachmentBaseSha(h.plugin, 'a.bin', '42', 'a'.repeat(64));
  await h.runtime.fileModify(h.file, h.plugin);
  let check = h.messages.at(-1).data;
  assert.equal(check.versionGuard, true); assert.equal(check.baseHashMissing, true); assert.equal(check.baseVersion, undefined); assert.equal(check.baseSha256, undefined);
  baseline.setAttachmentBaseSha(h.plugin, 'a.bin', '42', 'a'.repeat(64), 'test', 'version-1');
  await h.runtime.fileModify(h.file, h.plugin); check = h.messages.at(-1).data;
  assert.equal(check.baseVersion, 'version-1'); assert.equal(check.baseSha256, 'a'.repeat(64));
});

test('queued upload check is cancelled if version capability disappears', async () => {
  const h = createUploadRuntime(); let proceed, entered;
  const wait = new Promise(resolve => { proceed = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let sent = false;
  h.plugin.websocket.SendMessage = async (_action, _data, before, after) => { entered(); await wait; if (!before()) { sent = true; after(); } };
  const pending = h.runtime.fileModify(h.file, h.plugin); await ready;
  h.plugin.syncState.attachmentVersionCASSupported = false; proceed(); await pending;
  assert.equal(sent, false); assert.equal(h.plugin.pendingUploadHashes.has('a.bin'), false);
});

test("server baseline confirmation verifies the current bytes and remains scoped to its vault", async () => {
  const stored = []; let conflict = false;
  const baseline = { getAttachmentBaseSha: () => undefined, setAttachmentBaseSha: (...args) => stored.push(args), getAttachmentConflict: () => conflict ? {} : undefined, setAttachmentConflict() {}, setAttachmentResolution() {}, finishAttachmentResolution() {} };
  const h = createUploadRuntime(Buffer.from("one"), { baseline });
  const sha = createHash("sha256").update("one").digest("hex");
  await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, context: "A" }, h.plugin);
  assert.equal(stored.length, 0, 'a legacy baseline response cannot initialize a version');
  await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, fileVersion: 'version-1', context: "A" }, h.plugin);
  assert.equal(stored.length, 1);
  assert.equal(stored[0][3], sha);
  assert.equal(stored[0][5], 'version-1');
  conflict = true;
  await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, context: "A" }, h.plugin);
  conflict = false;
  h.setBytes(Buffer.from("two"));
  await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, context: "A" }, h.plugin);
  assert.equal(stored.length, 1, "conflicts and changed bytes cannot advance the base");
  let resume; const gate = new Promise(resolve => { resume = resolve; });
  h.plugin.app.vault.readBinary = async () => { await gate; return Uint8Array.from(Buffer.from("one")).buffer; };
  const pending = h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, context: "A" }, h.plugin);
  await new Promise(resolve => setTimeout(resolve, 0));
  h.plugin.settings.vault = "other"; resume(); await pending;
  assert.equal(stored.length, 1, "an old vault confirmation cannot update the new vault");
});

test("paged baseline confirmations complete once on success, refusal and read failure", async () => {
  for (const mode of ["success", "invalid", "failure"]) {
    const h = createUploadRuntime();
    if (mode === "failure") h.plugin.app.vault.readBinary = async () => { throw new Error("read failed"); };
    const sha = mode === "invalid" ? "invalid" : createHash("sha256").update("one").digest("hex");
    await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: sha, context: "A", pageIndex: 4 }, h.plugin);
    assert.equal(h.completed.length, 1, mode);
    assert.deepEqual(h.completed[0], ['file', 4, 'A']);
  }
  const h = createUploadRuntime();
  await h.runtime.receiveFileBaseline({ path: "a.bin", pathHash: "pathhash", snapshotSha256: createHash("sha256").update("one").digest("hex"), context: "A" }, h.plugin);
  assert.equal(h.completed.length, 0, "unpaged checks do not affect page accounting");
});

test("readiness gates chunks and mismatched SHA triggers recheck without sending", async () => {
  const h = createUploadRuntime(Buffer.from("new"));
  await h.runtime.receiveFileUpload(request(id(1), Buffer.from("old")), h.plugin);
  await waitUntil(() => h.completed.length === 1);
  assert.equal(h.sent.length, 0);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadCheck"));
  assert.equal(h.messages.find(m => m.action === "FileUploadCheck").data.snapshotSha256, createHash("sha256").update("new").digest("hex"));
  await h.runtime.receiveFileUpload(request(id(2), Buffer.from("new")), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  assert.equal(h.sent.length, 0, "no chunks before ready");
  h.runtime.receiveFileUploadReady({ sessionId: id(1) }, h.plugin);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.sent.length, 0, "wrong session cannot release the waiter");
  h.runtime.receiveFileUploadReady({ sessionId: id(2) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  assert.equal(h.sent[0].subarray(40).toString(), "new");
});

test("late acknowledgement cannot apply or clear a newer session", async () => {
  const h = createUploadRuntime();
  const a = request(id(1), Buffer.from("one"));
  await h.runtime.receiveFileUpload(a, h.plugin);
  await waitUntil(() => h.messages.length === 1);
  h.runtime.receiveFileUploadReady({ sessionId: id(1) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  h.setBytes(Buffer.from("two"));
  const b = request(id(2), Buffer.from("two"));
  await h.runtime.receiveFileUpload(b, h.plugin);
  await waitUntil(() => h.messages.length === 2);
  h.runtime.receiveFileUploadReady({ sessionId: id(2) }, h.plugin);
  await waitUntil(() => h.sent.length === 2);
  h.storage.set("fns-test-uploadSession-pathhash", JSON.stringify({ sessionId: id(2) }));
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(1), contentHash: "42" }, h.plugin);
  assert.equal(h.cached.length, 0);
  assert.equal(h.plugin.pendingUploadHashes.get("a.bin"), "42");
  assert.ok(h.storage.get("fns-test-uploadSession-pathhash"));
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(2), contentHash: "wrong" }, h.plugin);
  assert.equal(h.cached.length, 0);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(2), contentHash: "42" }, h.plugin);
  assert.equal(h.cached.length, 1);
  assert.equal(h.plugin.pendingUploadHashes.has("a.bin"), false);
  assert.equal(h.storage.get("fns-test-uploadSession-pathhash"), null);
});

test("legacy servers cannot silently accept unverified uploads; disconnect unblocks preparation", async () => {
  const h = createUploadRuntime();
  await h.runtime.receiveFileUpload({ path: "a.bin", pathHash: "pathhash", sessionId: id(1), chunkSize: 3, context: "A" }, h.plugin);
  await waitUntil(() => h.completed.length === 1);
  assert.equal(h.sent.length, 0);
  assert.match(h.logs.at(-1).message, /升级同步服务/);
  await h.runtime.receiveFileUpload(request(id(2), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  h.runtime.clearUploadQueue();
  await waitUntil(() => h.completed.length === 2);
  assert.equal(h.sent.length, 0);
});

test("a stale preparation failure and late 463 cannot release the newer session", async () => {
  const h = createUploadRuntime();
  await h.runtime.receiveFileUpload(request(id(1), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.length === 1);
  await h.runtime.receiveFileUpload(request(id(2), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.length === 2);
  h.storage.set("fns-test-uploadSession-pathhash", JSON.stringify({ sessionId: id(2) }));
  h.runtime.receiveFileUploadReady({ sessionId: id(1) }, h.plugin);
  await waitUntil(() => h.logs.some(log => log.status === "error"));
  h.runtime.receiveFileUploadSessionNotFound(id(1), h.plugin);
  assert.deepEqual(h.released, [`upload-session:${id(1)}`]);
  assert.ok(h.storage.get("fns-test-uploadSession-pathhash"));
  h.runtime.receiveFileUploadReady({ sessionId: id(2) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(2), contentHash: "42" }, h.plugin);
  assert.deepEqual(h.released, [`upload-session:${id(1)}`, `upload-session:${id(2)}`]);
});

test("a late conflict for an older session cannot release or acknowledge the newer upload", async () => {
  const h = createUploadRuntime();
  await h.runtime.receiveFileUpload(request(id(1), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.length === 1);
  h.runtime.receiveFileUploadReady({ sessionId: id(1) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  await h.runtime.receiveFileUpload(request(id(2), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.length === 2);
  h.runtime.receiveFileConflict({ path: "a.bin", sessionId: id(1), remoteSha256: "a".repeat(64), context: "A" }, h.plugin);
  assert.deepEqual(h.released, [`upload-session:${id(1)}`]);
  assert.equal(h.cached.length, 0);
  h.runtime.receiveFileUploadReady({ sessionId: id(2) }, h.plugin);
  await waitUntil(() => h.sent.length === 2);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(2), contentHash: "42" }, h.plugin);
  assert.equal(h.cached.length, 1);
});

test("unpaged conflict checks do not affect page accounting; paged conflicts settle their page", () => {
  const h = createUploadRuntime();
  h.runtime.receiveFileConflict({ path: "a.bin", context: "A" }, h.plugin);
  assert.equal(h.completed.length, 0);
  h.runtime.receiveFileConflict({ path: "a.bin", context: "A", pageIndex: 3 }, h.plugin);
  assert.equal(h.completed.length, 1);
  assert.deepEqual(h.completed[0], ['file', 3, 'A']);
});

test("check-to-session transition and NeedPush work with one real concurrency slot", async () => {
  const h = createUploadRuntime();
  const source = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/concurrency_limiter.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: () => ({ dump() {} }) });
  h.plugin.settings.concurrencyControlEnabled = true;
  h.plugin.settings.maxConcurrentUploads = 1;
  const limiter = new module.exports.ConcurrencyLimiter(h.plugin);
  h.plugin.concurrencyLimiter = limiter;
  h.plugin.websocket.SendMessage = async (action, data) => {
    h.messages.push({ action, data });
    if (action === "FileUploadCheck") {
      await h.runtime.receiveFileUpload({ ...request(id(1), Buffer.from("one")), expectedContentHash: data.contentHash, expectedSha256: data.snapshotSha256 }, h.plugin);
    } else if (action === "FileUploadPrepare") h.runtime.receiveFileUploadReady({ sessionId: data.sessionId }, h.plugin);
  };
  await h.runtime.fileModify(h.file, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(1), contentHash: "42" }, h.plugin);
  assert.equal(limiter.activeKeys.size, 0);
  await limiter.waitForSlot("unrelated");
  await h.runtime.receiveFileUpload(request(id(2), Buffer.from("one")), h.plugin);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.sent.length, 1, "NeedPush waits for its own slot");
  limiter.releaseSlot("unrelated");
  await waitUntil(() => h.sent.length === 2);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(2), contentHash: "42" }, h.plugin);
  assert.equal(limiter.activeKeys.size, 0);
});

test("only a complete matching checkpoint is offered and used for reconnect resume", async () => {
  const bytes = Buffer.from("abcde");
  const h = createUploadRuntime(bytes);
  let sends = 0;
  h.plugin.websocket.SendBinary = async (frame, _prefix, before, after) => {
    if (before()) return "cancelled";
    sends++;
    if (sends === 2) return "closed";
    h.sent.push(Buffer.from(frame)); after(); return "sent";
  };
  const upload = { ...request(id(3), bytes), chunkSize: 2 };
  await h.runtime.receiveFileUpload(upload, h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  h.runtime.receiveFileUploadReady({ sessionId: id(3) }, h.plugin);
  await waitUntil(() => h.logs.some(log => log.message?.includes("连接已断开")));
  h.runtime.clearUploadQueue();
  await h.runtime.fileModify(h.file, h.plugin);
  const check = h.messages.find(m => m.action === "FileUploadCheck");
  assert.equal(check.data.resumeSessionId, id(3));
  await h.runtime.receiveFileUpload(upload, h.plugin);
  await waitUntil(() => h.messages.filter(m => m.action === "FileUploadPrepare").length === 2);
  h.runtime.receiveFileUploadReady({ sessionId: id(3) }, h.plugin);
  await waitUntil(() => h.sent.length === 3);
  assert.deepEqual(h.sent.map(frame => frame.readUInt32BE(36)), [0, 1, 2]);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(3), contentHash: "42" }, h.plugin);

  h.storage.set("fns-test-uploadSession-pathhash", JSON.stringify({ sessionId: id(4), lastChunkIndex: 0, contentHash: "42" }));
  await h.runtime.fileModify(h.file, h.plugin);
  assert.equal(h.messages.filter(m => m.action === "FileUploadCheck").at(-1).data.resumeSessionId, undefined, "old checkpoints lack a complete digest");
  const old = { sessionId: id(5), lastChunkIndex: 0, contentHash: "42", sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtime: 10, ctime: 9 };
  h.storage.set("fns-test-uploadSession-pathhash", JSON.stringify(old));
  h.setBytes(Buffer.from("vwxyz"));
  await h.runtime.fileModify(h.file, h.plugin);
  assert.equal(h.messages.filter(m => m.action === "FileUploadCheck").at(-1).data.resumeSessionId, undefined, "same-size sampled hash collision must not resume");
});

test('upload checkpoint resume requires the same server version', () => {
  const h = createUploadRuntime();
  const snapshot = { contentHash: '42', snapshotSha256: 'a'.repeat(64), size: 3, mtime: 10, ctime: 9 };
  h.storage.set('fns-test-uploadSession-pathhash', JSON.stringify({ sessionId: id(3), lastChunkIndex: 0, sha256: snapshot.snapshotSha256, contentHash: '42', size: 3, mtime: 10, ctime: 9, baseVersion: 'version-1' }));
  assert.equal(h.runtime.matchingUploadCheckpoint(h.plugin, 'pathhash', snapshot, 'version-1'), id(3));
  assert.equal(h.runtime.matchingUploadCheckpoint(h.plugin, 'pathhash', snapshot, 'version-2'), undefined);
  assert.equal(h.runtime.matchingUploadCheckpoint(h.plugin, 'pathhash', snapshot), undefined);
});

test("prepare timeout releases its session and ignores a late Ready", async () => {
  const h = createUploadRuntime(Buffer.from("one"), { prepareTimeoutMs: 10 });
  await h.runtime.receiveFileUpload(request(id(6), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.completed.length === 1);
  assert.match(h.logs.at(-1).message, /准备超时/);
  assert.deepEqual(h.released, [`upload-session:${id(6)}`]);
  h.runtime.receiveFileUploadReady({ sessionId: id(6) }, h.plugin);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.sent.length, 0);
});

test("an acknowledgement after deletion does not resurrect the file baseline", async () => {
  const h = createUploadRuntime();
  await h.runtime.receiveFileUpload(request(id(7), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  h.runtime.receiveFileUploadReady({ sessionId: id(7) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  h.plugin.pendingFileDeleteAcks.add("a.bin");
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(7), contentHash: "42" }, h.plugin);
  assert.equal(h.cached.length, 0);
  assert.deepEqual(h.released, [`upload-session:${id(7)}`]);
});

test("attachment snapshot reads are globally bounded and carry a full digest", async () => {
  const h = createUploadRuntime();
  let active = 0, maximum = 0, started = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.plugin.app.vault.readBinary = async () => {
    active++; started++; maximum = Math.max(maximum, active);
    await gate; active--;
    return Uint8Array.from(Buffer.from("one")).buffer;
  };
  const work = Array.from({ length: 5 }, () => h.runtime.captureAttachmentSnapshot(h.plugin, h.file));
  await waitUntil(() => started === 2);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, 2);
  release();
  const snapshots = await Promise.all(work);
  assert.equal(maximum, 2);
  for (const snapshot of snapshots) assert.equal(snapshot.snapshotSha256, createHash("sha256").update("one").digest("hex"));
});

test("cancelled attachment readers leave the queue without releasing active reads", { timeout: 2000 }, async () => {
  const h = createUploadRuntime();
  let started = 0, active = 0, maximum = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  h.plugin.app.vault.readBinary = async () => {
    started++; active++; maximum = Math.max(maximum, active);
    await gate; active--;
    return Uint8Array.from(Buffer.from("one")).buffer;
  };
  const first = h.runtime.captureAttachmentSnapshot(h.plugin, h.file);
  const second = h.runtime.captureAttachmentSnapshot(h.plugin, h.file);
  await waitUntil(() => started === 2);
  const timeoutSource = ts.transpileModule(fs.readFileSync(new URL("../src/lib/sync/hash_timeout.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const timeoutModule = { exports: {} };
  vm.runInNewContext(timeoutSource, { module: timeoutModule, exports: timeoutModule.exports, AbortController, window: { setTimeout, clearTimeout } });
  const waiting = timeoutModule.exports.withHashTimeout(signal => h.runtime.captureAttachmentSnapshot(h.plugin, h.file, signal), 10);
  await assert.rejects(waiting, /Hash timeout/);
  assert.equal(started, 2, "aborting a waiter must not start or release an active read");
  const next = h.runtime.captureAttachmentSnapshot(h.plugin, h.file);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(started, 2);
  release();
  await Promise.all([first, second, next]);
  assert.equal(started, 3, "cancelled waiters never start after capacity returns");
  assert.equal(maximum, 2);
});

test("cloud auto-delete waits for the matching ack and refuses changed bytes", async () => {
  const h = createUploadRuntime();
  h.plugin.settings.cloudPreviewEnabled = true;
  h.plugin.settings.cloudPreviewAutoDeleteLocal = true;
  const upload = request(id(8), Buffer.from("one"));
  await h.runtime.receiveFileUpload(upload, h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  h.runtime.receiveFileUploadReady({ sessionId: id(8) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  assert.equal(h.deleted.length, 0, "no deletion before server acknowledgement");
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(9), contentHash: "42" }, h.plugin);
  assert.equal(h.deleted.length, 0, "unmatched ack cannot delete");
  h.setBytes(Buffer.from("two")); // Same size and metadata, different full SHA.
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(8), contentHash: "42", fileVersion: 'version-1' }, h.plugin);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.deleted.length, 0);

  h.setBytes(Buffer.from("one"));
  await h.runtime.receiveFileUpload(request(id(10), Buffer.from("one")), h.plugin);
  await waitUntil(() => h.messages.filter(m => m.action === "FileUploadPrepare").length === 2);
  h.runtime.receiveFileUploadReady({ sessionId: id(10) }, h.plugin);
  await waitUntil(() => h.sent.length === 2);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: id(10), contentHash: "42", fileVersion: 'version-2' }, h.plugin);
  await waitUntil(() => h.deleted.length === 1);
});
