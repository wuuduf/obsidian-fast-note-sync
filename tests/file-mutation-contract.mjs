import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createUploadRuntime } from './helpers/upload-runtime.mjs';
import { loadDiagnosticRuntime } from '../scripts/diagnostic-fixture-runtime.mjs';

test('real Go mutation envelopes and plugin handlers preserve versions and settle pages', { skip: !process.env.FNS_MUTATION_CONTRACT_PATH }, async () => {
  const fixture = JSON.parse(fs.readFileSync(process.env.FNS_MUTATION_CONTRACT_PATH, 'utf8'));
  assert.equal(fixture.mutationVerified, true);
  const mapper = loadDiagnosticRuntime();
  const decode = (message) => {
    const packet = Buffer.from(message.protobufBase64, 'base64');
    assert.equal(packet.subarray(0, 2).toString(), 'pb');
    return mapper.deReceivePacket(packet.subarray(2));
  };
  for (const response of [fixture.uploadAck.json, decode(fixture.uploadAck)]) {
    assert.ok(response.data.fileVersion, 'actual upload ACK must carry the confirmed version');
  }
  const makeHarness = (envelope) => {
    const conflicts = new Map();
    const baseline = {
      getAttachmentBaseSha: () => undefined, setAttachmentBaseSha() {},
      getAttachmentConflict: (_p, path) => conflicts.get(path),
      setAttachmentMutationConflict: (_p, path, operation, remoteSha256, targetPath, _vault, remoteVersion) => conflicts.set(path, { mutation: operation, remoteSha256, targetPath, remoteVersion }),
      clearAttachmentMutationConflict() {}, setAttachmentConflict() {},
      setAttachmentPendingConflict() {}, clearAttachmentPendingConflict() {},
      shouldDeferAttachmentConflict: () => false, setAttachmentDeletedConflict() {},
      setAttachmentResolution() {}, finishAttachmentResolution() {},
    };
    const h = createUploadRuntime(Buffer.from('local-version'), { baseline });
    h.plugin.settings.vault = envelope.vault;
    h.plugin.syncState.activeSyncContext = envelope.context;
    h.plugin.syncState.attachmentMutationCASSupported = true;
    h.plugin.syncState.attachmentRePushSafeSupported = true;
    h.plugin.pendingFileRenames = [];
    h.plugin.pendingDeleteFilePaths = new Set();
    h.plugin.syncState.pendingFileDeleteOperations = new Map();
    h.plugin.websocket.SendMessage = async (action, data, before, after) => {
      if (before?.()) return false;
      h.messages.push({ action, data });
      after?.();
      return true;
    };
    return { ...h, conflicts };
  };
  for (const [key, expectedOperation] of [['deleteConflict', 'delete'], ['renameConflict', 'rename']]) {
    const message = fixture[key];
    for (const response of [message.json, decode(message)]) {
      assert.equal(response.status, false);
      assert.equal(response.data.operation, expectedOperation);
      assert.equal(response.data.operationId, `${expectedOperation}-stale-op`);
      assert.match(response.data.remoteSha256, /^[a-f0-9]{64}$/);
      assert.ok(response.data.remoteVersion, 'real conflict must include remote version');
      if (expectedOperation === 'rename') assert.equal(response.data.targetPath, 'renamed.bin');
      const h = makeHarness(response);
      if (expectedOperation === 'delete') {
        h.plugin.pendingFileDeleteAcks.add(response.data.path);
        h.plugin.syncState.pendingFileDeleteOperations.set(response.data.operationId, { path: response.data.path, vault: response.vault, slotKey: 'slot' });
      } else h.plugin.pendingFileRenames.push({ oldPath: response.data.path, newPath: response.data.targetPath, contentHash: 'old', operationId: response.data.operationId, vault: response.vault, slotKey: 'slot' });
      await h.runtime.receiveFileMutationConflict({ ...response.data, context: response.context }, h.plugin);
      assert.equal(h.conflicts.get(response.data.path)?.mutation, expectedOperation);
      assert.equal(h.conflicts.get(response.data.path)?.remoteVersion, response.data.remoteVersion);
      assert.equal(h.deleted.length, 0);
      assert.deepEqual(Buffer.from(await h.plugin.app.vault.readBinary(h.file)), Buffer.from('local-version'));
      assert.equal(h.messages.filter(item => item.action === 'FileRePush').length, 1);
      assert.equal(h.completed.length, 0, 'direct conflict must not complete an unrelated page');
      const newer = makeHarness(response);
      if (expectedOperation === 'delete') {
        newer.plugin.pendingFileDeleteAcks.add(response.data.path);
        newer.plugin.syncState.pendingFileDeleteOperations.set('newer', { path: response.data.path, vault: response.vault, slotKey: 'new-slot' });
      } else newer.plugin.pendingFileRenames.push({ oldPath: response.data.path, newPath: response.data.targetPath, contentHash: 'new', operationId: 'newer', vault: response.vault, slotKey: 'new-slot' });
      await newer.runtime.receiveFileMutationConflict({ ...response.data, context: response.context }, newer.plugin);
      assert.equal(newer.conflicts.size, 0, 'old conflict must not overwrite current operation state');
      assert.equal(newer.messages.length, 0);
      assert.deepEqual(newer.released, []);
      if (expectedOperation === 'delete') assert.equal(newer.plugin.syncState.pendingFileDeleteOperations.has('newer'), true);
      else assert.equal(newer.plugin.pendingFileRenames.length, 1);
    }
  }
  for (const response of [fixture.abaConflict.json, decode(fixture.abaConflict)]) {
    assert.equal(response.data.operationId, 'aba-stale');
    assert.ok(response.data.remoteVersion);
    const h = makeHarness(response);
    h.plugin.pendingFileDeleteAcks.add(response.data.path);
    h.plugin.syncState.pendingFileDeleteOperations.set('aba-stale', { path: response.data.path, vault: response.vault, slotKey: 'aba-slot' });
    await h.runtime.receiveFileMutationConflict({ ...response.data, context: response.context }, h.plugin);
    assert.equal(h.conflicts.get(response.data.path)?.remoteVersion, response.data.remoteVersion);
    assert.deepEqual(h.released, ['aba-slot']);
    assert.equal(h.deleted.length, 0);
  }
  for (const response of [fixture.offlineConflict.json, decode(fixture.offlineConflict)]) {
    assert.equal(response.status, true, 'paged conflicts are action-specific success envelopes');
    assert.equal(response.pageIndex, 1);
    assert.ok(response.data.remoteVersion, 'paged conflict must include remote version');
    const h = makeHarness(response);
    h.plugin.pendingDeleteFilePaths.add(response.data.path);
    const data = { ...response.data, context: response.context, pageIndex: response.pageIndex - 1 };
    await h.runtime.receiveFileMutationConflict(data, h.plugin);
    await h.runtime.receiveFileMutationConflict(data, h.plugin);
    assert.equal(h.messages.filter(item => item.action === 'FileRePush').length, 1, 'page replay must not duplicate a retry');
    assert.equal(h.completed.length, 0, 'the page waits for the retained version or its failed lookup');
    h.runtime.receiveFileRePushFailed({ path: data.path, context: data.context }, h.plugin);
    assert.deepEqual(h.completed, [['file', 0, data.context]]);
    assert.equal(h.deleted.length, 0);
  }
  for (const [key, opId, operation] of [['directDeleteAck', 'delete-matched-op', 'delete'], ['directRenameAck', 'rename-matched-op', 'rename'], ['directFailed', 'delete-failure-op', 'failed']]) {
    for (const response of [fixture[key].json, decode(fixture[key])]) {
      assert.equal(response.data.operationId, opId, `${key} operation ID must survive the wire`);
      const h = makeHarness(response);
      const path = operation === 'rename' ? 'rename.bin' : response.data.path;
      const newId = `${opId}-newer`;
      const removed = [];
      h.plugin.fileHashManager.removeFileHash = value => removed.push(value);
      if (operation === 'rename') {
        h.plugin.pendingFileRenames.push({ oldPath: path, newPath: response.data.path, contentHash: 'new', operationId: newId, vault: response.vault, slotKey: 'new-slot' });
        h.runtime.receiveFileRenameAck(response.data, h.plugin);
        assert.equal(h.plugin.pendingFileRenames.length, 1);
      } else {
        h.plugin.pendingFileDeleteAcks.add(path);
        h.plugin.syncState.pendingFileDeleteOperations.set(newId, { path, vault: response.vault, slotKey: 'new-slot' });
        if (operation === 'delete') h.runtime.receiveFileDeleteAck({ ...response.data, context: response.context }, h.plugin);
        else h.runtime.receiveFileMutationFailed({ ...response.data, context: response.context }, h.plugin);
        assert.equal(h.plugin.syncState.pendingFileDeleteOperations.has(newId), true);
        assert.equal(h.plugin.pendingFileDeleteAcks.has(path), true);
      }
      assert.deepEqual(h.released, [], 'old response must not release the newer operation slot');
      assert.deepEqual(removed, [], 'old response must not change the newer baseline');
    }
  }
  // A direct event may outlive the sync round that issued it. The operation
  // ID still owns its slot, while old paged messages must remain isolated.
  for (const key of ['directDeleteAck', 'directRenameAck', 'deleteConflict', 'renameConflict', 'directFailed']) {
    for (const response of [fixture[key].json, decode(fixture[key])]) {
      const h = makeHarness(response);
      h.plugin.syncState.activeSyncContext = null;
      const isRename = key === 'directRenameAck' || key === 'renameConflict';
      const path = key === 'directRenameAck' ? 'rename.bin' : response.data.path;
      const target = key === 'directRenameAck' ? response.data.path : response.data.targetPath;
      if (isRename) {
        h.plugin.pendingFileRenames.push({ oldPath: path, newPath: target, contentHash: 'old', operationId: response.data.operationId, vault: response.vault, slotKey: 'late-slot' });
      } else {
        h.plugin.pendingFileDeleteAcks.add(path);
        h.plugin.syncState.pendingFileDeleteOperations.set(response.data.operationId, { path, vault: response.vault, slotKey: 'late-slot' });
      }
      const data = { ...response.data, context: response.context };
      if (key === 'directDeleteAck') h.runtime.receiveFileDeleteAck(data, h.plugin);
      else if (key === 'directRenameAck') h.runtime.receiveFileRenameAck(data, h.plugin);
      else if (key === 'directFailed') h.runtime.receiveFileMutationFailed(data, h.plugin);
      else await h.runtime.receiveFileMutationConflict(data, h.plugin);
      assert.deepEqual(h.released, ['late-slot'], `${key} must release its own pending operation after the round`);
      if (isRename) assert.equal(h.plugin.pendingFileRenames.length, 0);
      else assert.equal(h.plugin.syncState.pendingFileDeleteOperations.size, 0);
      if (key.endsWith('Conflict')) assert.equal(h.conflicts.get(path)?.mutation, isRename ? 'rename' : 'delete');
      assert.deepEqual(h.completed, [], 'direct responses must not settle an old page');
    }
  }
  for (const key of ['offlineAck', 'offlineConflict', 'offlineFailed']) {
    for (const response of [fixture[key].json, decode(fixture[key])]) {
      const h = makeHarness(response);
      h.plugin.syncState.activeSyncContext = null;
      h.plugin.pendingDeleteFilePaths.add(response.data.path);
      const data = { ...response.data, context: response.context, pageIndex: response.pageIndex - 1 };
      if (key === 'offlineAck') h.runtime.receiveFileDeleteAck(data, h.plugin);
      else if (key === 'offlineFailed') h.runtime.receiveFileMutationFailed(data, h.plugin);
      else await h.runtime.receiveFileMutationConflict(data, h.plugin);
      assert.equal(h.plugin.pendingDeleteFilePaths.has(data.path), true, `${key} must ignore old paged context`);
      assert.deepEqual(h.completed, []);
      assert.equal(h.conflicts.size, 0);
      assert.equal(h.messages.length, 0);
    }
  }
  for (const response of [fixture.pathMismatch.json, decode(fixture.pathMismatch)]) {
    assert.equal(response.data.reason, 'path_mismatch');
    const h = makeHarness(response);
    h.plugin.syncState.pendingFileDeleteOperations.set(response.data.operationId, { path: response.data.path, vault: response.vault, slotKey: 'slot' });
    await h.runtime.receiveFileMutationConflict({ ...response.data, context: response.context }, h.plugin);
    assert.equal(h.conflicts.get(response.data.path)?.mutation, 'delete');
    assert.equal(h.messages.filter(item => item.action === 'FileRePush').length, 0, 'a colliding hash must not download the other path');
    assert.equal(h.deleted.length, 0);
  }
  for (const response of [fixture.offlineAck.json, decode(fixture.offlineAck)]) {
    const h = makeHarness(response); const removed = [];
    h.plugin.app.vault.getFileByPath = () => null;
    h.plugin.fileHashManager.removeFileHash = path => removed.push(path);
    h.plugin.pendingDeleteFilePaths.add(response.data.path);
    const data = { ...response.data, context: response.context, pageIndex: response.pageIndex - 1 };
    h.runtime.receiveFileDeleteAck(data, h.plugin);
    h.runtime.receiveFileDeleteAck(data, h.plugin);
    assert.deepEqual(removed, [data.path]);
    assert.deepEqual(h.completed, [['file', 1, data.context]]);
  }
  for (const response of [fixture.offlineFailed.json, decode(fixture.offlineFailed)]) {
    const h = makeHarness(response);
    h.plugin.pendingDeleteFilePaths.add(response.data.path);
    const data = { ...response.data, context: response.context, pageIndex: response.pageIndex - 1 };
    h.runtime.receiveFileMutationFailed(data, h.plugin);
    h.runtime.receiveFileMutationFailed(data, h.plugin);
    assert.deepEqual(h.completed, [['file', 2, data.context]]);
    assert.equal(h.deleted.length, 0);
    assert.equal(h.cached.length, 0);
  }
});
