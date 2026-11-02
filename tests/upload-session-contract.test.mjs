import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createUploadRuntime, waitUntil } from "./helpers/upload-runtime.mjs";
import { loadDiagnosticRuntime } from "../scripts/diagnostic-fixture-runtime.mjs";

test("real Go upload instructions and reverse acknowledgements round-trip through plugin JSON and Protobuf handlers", { skip: !process.env.FNS_UPLOAD_CONTRACT_PATH }, async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FNS_UPLOAD_CONTRACT_PATH, "utf8"));
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.sessions.length, 2);
  assert.equal(fixture.badShaRejected, true);
  assert.equal(fixture.unpreparedRejected, true);
  assert.equal(fixture.corruptChunkRejected, true);
  assert.equal(fixture.supersededRejected, true);
  const mapper = loadDiagnosticRuntime();
  const decode = message => {
    const bytes = Buffer.from(message.protobufBase64, "base64");
    assert.equal(bytes.subarray(0, 2).toString(), "pb");
    return mapper.deReceivePacket(bytes.subarray(2));
  };
  for (const mode of ["json", "protobuf"]) {
    const h = createUploadRuntime();
    h.plugin.syncState.activeSyncContext = "fixture";
    h.plugin.settings.vault = "Test";
    for (const [index, session] of fixture.sessions.entries()) {
      const wire = mode === "json" ? session.upload.json : decode(session.upload);
      const upload = { ...wire.data, context: wire.context };
      const bytes = Buffer.from(session.bytesBase64, "base64");
      h.file.path = upload.path;
      h.file.stat = { size: bytes.length, mtime: upload.expectedMtime, ctime: upload.expectedCtime };
      h.setBytes(bytes); h.setHash(upload.expectedContentHash);
      await h.runtime.receiveFileUpload(upload, h.plugin);
      await waitUntil(() => h.messages.length > index);
      const prepare = h.messages[index];
      assert.equal(prepare.action, "FileUploadPrepare");
      assert.equal(prepare.data.sessionId, upload.sessionId);
      assert.equal(prepare.data.sha256, upload.expectedSha256);
      assert.equal(h.sent.length, index, "chunks are gated on the matching ready response");
      const ready = mode === "json" ? session.ready.json : decode(session.ready);
      h.runtime.receiveFileUploadReady(ready.data, h.plugin);
      await waitUntil(() => h.sent.length > index);
      assert.deepEqual(h.sent[index].subarray(40), bytes);
    }
    for (const session of [...fixture.sessions].reverse()) {
      const wire = mode === "json" ? session.ack.json : decode(session.ack);
      h.runtime.receiveFileUploadAck({ ...wire.data, context: wire.context }, h.plugin);
    }
    assert.equal(h.cached.length, 1);
    assert.equal(h.cached[0][1], fixture.sessions[1].ack.json.data.contentHash);
    assert.equal(h.plugin.pendingUploadHashes.size, 0);
  }
});
