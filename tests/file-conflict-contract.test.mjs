import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createUploadRuntime, waitUntil } from './helpers/upload-runtime.mjs';
import { loadDiagnosticRuntime } from '../scripts/diagnostic-fixture-runtime.mjs';

test('real service conflict JSON and Protobuf preserve local attachment and report conflict', { skip: !process.env.FNS_FILE_CONFLICT_CONTRACT_PATH }, async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FNS_FILE_CONFLICT_CONTRACT_PATH, 'utf8'));
  assert.equal(fixture.fileConflictVerified, true);
  const mapper = loadDiagnosticRuntime();
  const failurePacket = Buffer.from(fixture.fileRePushFailure.protobufBase64, 'base64');
  assert.equal(failurePacket.subarray(0, 2).toString(), 'pb');
  const failureDecoded = mapper.deReceivePacket(failurePacket.subarray(2));
  for (const failure of [fixture.fileRePushFailure.json, failureDecoded]) {
    assert.equal(failure.status, false);
    assert.equal(failure.context, 'repush-failed');
    assert.equal(failure.data.path, 'guard.bin');
    const h = createUploadRuntime(Buffer.from('preserve'));
    h.runtime.receiveFileRePushFailed({ ...failure.data, context: 'A' }, h.plugin);
    assert.equal(h.deleted.length, 0);
    assert.deepEqual(Buffer.from(await h.plugin.app.vault.readBinary(h.file)), Buffer.from('preserve'));
  }
  const wire = Buffer.from(fixture.fileConflict.protobufBase64, 'base64');
  assert.equal(wire.subarray(0, 2).toString(), 'pb');
  const decoded = mapper.deReceivePacket(wire.subarray(2));
  for (const response of [fixture.fileConflict.json, decoded]) {
    const h = createUploadRuntime(Buffer.from('device-two'));
    const data = response.data;
    assert.equal(data.path, 'persist.bin');
    assert.ok(data.conflictPath);
    assert.ok(data.sessionId);
    h.runtime.receiveFileConflict({ ...data, context: 'A' }, h.plugin);
    await waitUntil(() => h.logs.length > 0);
    assert.equal(h.deleted.length, 0);
    assert.equal(h.cached.length, 0);
    assert.deepEqual(Buffer.from(await h.plugin.app.vault.readBinary(h.file)), Buffer.from('device-two'));
    assert.ok(h.logs.some(log => String(log).includes('FileConflict')));
  }
});
