import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createUploadRuntime, waitUntil } from "./helpers/upload-runtime.mjs";

const session = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const request = (id, bytes) => ({ path: "a.bin", pathHash: "pathhash", sessionId: session(id),
  context: "A", chunkSize: 1024 * 1024, requiresPrepare: true, expectedContentHash: "42",
  expectedSha256: createHash("sha256").update(bytes).digest("hex"), expectedSize: bytes.length,
  expectedMtime: 10, expectedCtime: 9 });

test("invalid or stale upload instructions do not read large attachments", async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 3);
  for (const overrides of [
    { requiresPrepare: false }, { expectedSha256: "malformed" },
    { expectedSize: bytes.length + 1 }, { expectedMtime: 11 }, { expectedCtime: 8 },
  ]) {
    const h = createUploadRuntime(bytes);
    h.plugin.syncState.activeSyncContext = "new-round"; // Suppress the separate automatic recheck.
    await h.runtime.receiveFileUpload({ ...request(1, bytes), ...overrides }, h.plugin);
    await waitUntil(() => h.completed.length === 1);
    assert.deepEqual(h.reads, [], "rejected upload must not read 16 MiB");
    assert.equal(h.sent.length, 0);
    assert.equal(h.messages.some(m => m.action === "FileUploadPrepare"), false);
  }
});

test("malformed sizes and chunk settings never corrupt upload progress", async () => {
  const bytes = Buffer.alloc(1024, 7);
  for (const overrides of [
    { expectedSize: Infinity }, { expectedSize: -1 }, { expectedSize: 0.5 },
    { chunkSize: 0 }, { chunkSize: -1 }, { chunkSize: 0.5 }, { chunkSize: Infinity },
  ]) {
    const h = createUploadRuntime(bytes);
    h.plugin.totalChunksToUpload = 3;
    h.plugin.syncState.activeSyncContext = "new-round";
    await h.runtime.receiveFileUpload({ ...request(3, bytes), ...overrides }, h.plugin);
    await waitUntil(() => h.completed.length === 1);
    assert.equal(h.plugin.totalChunksToUpload, 3, JSON.stringify(overrides));
    assert.deepEqual(h.reads, []);
    assert.equal(h.sent.length, 0);
  }
});

test("an invalid later session cannot supersede a valid active upload", async () => {
  const bytes = Buffer.from("abc");
  const h = createUploadRuntime(bytes);
  await h.runtime.receiveFileUpload(request(1, bytes), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  await h.runtime.receiveFileUpload({ ...request(2, bytes), chunkSize: 0 }, h.plugin);
  h.runtime.receiveFileUploadReady({ sessionId: session(1) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  assert.deepEqual(h.sent[0].subarray(40), bytes);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: session(1), contentHash: "42" }, h.plugin);
  assert.equal(h.cached.length, 1);
});

test("a valid empty file is sent as one empty chunk", async () => {
  const bytes = Buffer.alloc(0);
  const h = createUploadRuntime(bytes);
  await h.runtime.receiveFileUpload(request(1, bytes), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  h.runtime.receiveFileUploadReady({ sessionId: session(1) }, h.plugin);
  await waitUntil(() => h.sent.length === 1);
  assert.equal(h.sent[0].length, 40);
  assert.equal(h.plugin.totalChunksToUpload, 1);
  h.runtime.receiveFileUploadAck({ path: "a.bin", pathHash: "pathhash", sessionId: session(1), contentHash: "42" }, h.plugin);
});

test("an old upload superseded while queued cannot read the file", async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024, 4);
  const h = createUploadRuntime(bytes);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  h.plugin.concurrencyLimiter.waitForSlot = key => key.endsWith(session(1)) ? gate : Promise.resolve();
  await h.runtime.receiveFileUpload(request(1, bytes), h.plugin);
  await h.runtime.receiveFileUpload(request(2, bytes), h.plugin);
  await waitUntil(() => h.messages.some(m => m.action === "FileUploadPrepare"));
  release();
  await waitUntil(() => h.completed.length === 1);
  assert.deepEqual(h.reads, [bytes.length], "only the current session may read");
  h.runtime.receiveFileUploadReady({ sessionId: session(2) }, h.plugin);
  await waitUntil(() => h.sent.length === 16);
  assert.equal(h.sent.reduce((sum, frame) => sum + frame.length - 40, 0), bytes.length);
});

test("same-size and same-mtime changed bytes are still read and rejected by full SHA", async () => {
  const old = Buffer.alloc(16 * 1024 * 1024, 5);
  const newer = Buffer.from(old); newer[6 * 1024 * 1024] = 6;
  const h = createUploadRuntime(newer);
  await h.runtime.receiveFileUpload(request(1, old), h.plugin);
  await waitUntil(() => h.completed.length === 1);
  assert.equal(h.reads[0], old.length);
  assert.equal(h.sent.length, 0);
  assert.equal(h.messages.some(m => m.action === "FileUploadPrepare"), false);
});
