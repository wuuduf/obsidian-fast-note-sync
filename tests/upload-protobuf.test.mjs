import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDiagnosticRuntime } from '../scripts/diagnostic-fixture-runtime.mjs';

test('upload preparation is encoded by the production Protobuf mapper', () => {
  const { proto, enSendDTOToProtobuf } = loadDiagnosticRuntime();
  const packet = proto.v1.WSMessage.decode(enSendDTOToProtobuf('FileUploadPrepare', {
    sessionId: 'session-a', sha256: 'a'.repeat(64), contentHash: '-123',
    size: 42, mtime: 1700000000000, ctime: 1699999999000, context: 'round-a',
  }));
  assert.equal(packet.type, 'FileUploadPrepare');
  const data = proto.v1.FileUploadPrepareRequest.toObject(proto.v1.FileUploadPrepareRequest.decode(packet.data), { longs: Number });
  assert.equal(data.sessionId, 'session-a');
  assert.equal(data.sha256, 'a'.repeat(64));
  assert.equal(data.contentHash, '-123');
  assert.equal(data.size, 42);
  assert.equal(data.mtime, 1700000000000);
  assert.equal(data.ctime, 1699999999000);
  assert.equal(data.context, 'round-a');
  const check = proto.v1.WSMessage.decode(enSendDTOToProtobuf('FileUploadCheck', {
    path: 'a.png', snapshotSha256: 'c'.repeat(64), resumeSessionId: 'resume-a', baseHash: '-123', baseSha256: 'e'.repeat(64),
  }));
  assert.equal(proto.v1.FileUploadCheckRequest.decode(check.data).snapshotSha256, 'c'.repeat(64));
  assert.equal(proto.v1.FileUploadCheckRequest.decode(check.data).resumeSessionId, 'resume-a');
  assert.equal(proto.v1.FileUploadCheckRequest.decode(check.data).baseHash, '-123');
  assert.equal(proto.v1.FileUploadCheckRequest.decode(check.data).baseSha256, 'e'.repeat(64));
  const sync = proto.v1.WSMessage.decode(enSendDTOToProtobuf('FileSync', {
    files: [{ path: 'a.png', snapshotSha256: 'd'.repeat(64), resumeSessionId: 'resume-b', baseHashMissing: true, baseSha256: 'f'.repeat(64) }],
    protectedFiles: [{ path: 'pending.png', pathHash: 'protected-hash' }],
  }));
  assert.equal(proto.v1.FileSyncRequest.decode(sync.data).files[0].snapshotSha256, 'd'.repeat(64));
  assert.equal(proto.v1.FileSyncRequest.decode(sync.data).files[0].resumeSessionId, 'resume-b');
  assert.equal(proto.v1.FileSyncRequest.decode(sync.data).files[0].baseHashMissing, true);
  assert.equal(proto.v1.FileSyncRequest.decode(sync.data).files[0].baseSha256, 'f'.repeat(64));
  assert.equal(proto.v1.FileSyncRequest.decode(sync.data).protectedFiles[0].pathHash, 'protected-hash');
});

test('upload instructions, readiness and acknowledgements retain session data, including legacy messages', () => {
  const { proto, deReceivePacket } = loadDiagnosticRuntime();
  const receive = (action, type, data) => {
    const inner = type.encode(type.create(data)).finish();
    const response = proto.v1.WSResponse.encode(proto.v1.WSResponse.create({ code: 200, status: true, data: inner })).finish();
    return deReceivePacket(proto.v1.WSMessage.encode(proto.v1.WSMessage.create({ type: action, data: response })).finish()).data;
  };
  const instruction = receive('FileUpload', proto.v1.FileSyncUploadMessage, {
    path: 'a.png', sessionId: 'session-a', expectedContentHash: '-123', expectedSize: 42,
    expectedMtime: 1700000000000, expectedCtime: 1699999999000, expectedSha256: 'b'.repeat(64), requiresPrepare: true,
  });
  assert.equal(instruction.requiresPrepare, true);
  assert.equal(instruction.expectedContentHash, '-123');
  assert.equal(instruction.expectedSize, 42);
  assert.equal(instruction.expectedMtime, 1700000000000);
  assert.equal(instruction.expectedCtime, 1699999999000);
  assert.equal(instruction.expectedSha256, 'b'.repeat(64));
  const ready = receive('FileUploadReady', proto.v1.FileUploadReadyMessage, { sessionId: 'session-a' });
  assert.equal(ready.sessionId, 'session-a');
  const ack = receive('FileUploadAck', proto.v1.FileUploadAckMessage, { sessionId: 'session-a', contentHash: '-123' });
  assert.equal(ack.sessionId, 'session-a');
  assert.equal(ack.contentHash, '-123');
  const conflict = receive('FileConflict', proto.v1.FileConflictMessage, { path: 'a.png', pathHash: 'p', sessionId: 'session-a', remoteSha256: 'a'.repeat(64), incomingSha256: 'b'.repeat(64), reason: 'base_changed', conflictPath: 'a.conflict.png' });
  assert.equal(conflict.sessionId, 'session-a');
  assert.equal(conflict.remoteSha256, 'a'.repeat(64));
  assert.equal(conflict.incomingSha256, 'b'.repeat(64));
  assert.equal(conflict.reason, 'base_changed');
  assert.equal(conflict.conflictPath, 'a.conflict.png');
  const baseline = receive('FileBaseline', proto.v1.FileBaselineMessage, { path: 'a.png', pathHash: 'p', snapshotSha256: 'c'.repeat(64) });
  assert.equal(baseline.path, 'a.png');
  assert.equal(baseline.snapshotSha256, 'c'.repeat(64));
  const legacy = receive('FileUpload', proto.v1.FileSyncUploadMessage, { path: 'old', sessionId: 'old-session' });
  assert.equal(legacy.requiresPrepare, false);
});
