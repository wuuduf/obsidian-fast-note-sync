import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { test } from "node:test";

function harness(options = {}) {
  const sockets = [];
  const timers = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }
  const sourcePath = path.resolve(import.meta.dirname, "../src/lib/sync/websocket_client.ts");
  const source = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, WebSocket: FakeWebSocket, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array,
    window: { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} },
    require(id) {
      if (id === "obsidian") return { moment: () => ({ format: () => "" }) };
      if (id === "../utils/helpers") return { dump() {}, dumpError() {}, isWsUrl: () => true, showSyncNotice() {} };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const client = new module.exports.WebSocketClient({ app: {
    vault: { getName: () => "Test" }, loadLocalStorage: () => null, saveLocalStorage() {},
  } }, { getWsUrl: () => "ws://example.test", ...options });
  return { client, sockets, timers, FakeWebSocket };
}

test("unregister cancels a pending pre-connect probe", async () => {
  let finishProbe;
  const { client, sockets } = harness({ preConnectProbe: () => new Promise((resolve) => { finishProbe = resolve; }) });
  const registration = client.register();
  client.unRegister(true);
  finishProbe(true);
  await registration;
  assert.equal(sockets.length, 0, "a paused client must not reconnect when an old probe completes");
});

test("a new registration does not wait for an obsolete probe", async () => {
  const probes = [];
  const { client, sockets } = harness({ preConnectProbe: () => new Promise((resolve) => probes.push(resolve)) });
  const oldRegistration = client.register();
  client.unRegister();
  const newRegistration = client.register();
  assert.equal(probes.length, 2);
  probes[1](true);
  await newRegistration;
  probes[0](true);
  await oldRegistration;
  assert.equal(sockets.length, 1, "only the current registration may open a socket");
});

test("finishing an obsolete probe cannot clear the active registration lock", async () => {
  const probes = [];
  const { client, sockets } = harness({ preConnectProbe: () => new Promise((resolve) => probes.push(resolve)) });
  const oldRegistration = client.register();
  client.unRegister();
  const currentRegistration = client.register();
  probes[0](true);
  await oldRegistration;
  const coalescedRegistration = client.register();
  assert.equal(probes.length, 2);
  probes[1](true);
  await Promise.all([currentRegistration, coalescedRegistration]);
  assert.equal(sockets.length, 1);
});

test("network and focus reconnects respect an explicit user pause", async () => {
  const { client, sockets } = harness();
  await client.register();
  client.unRegister(true);
  client.triggerReconnect();
  await Promise.resolve();
  assert.equal(sockets.length, 1);
  await client.register(); // the explicit Resume action still works
  assert.equal(sockets.length, 2);
});

for (const mode of ["closed", "unregistered", "replaced"]) {
  for (const format of ["text", "binary"]) {
    test(`${format} backpressure exits when the original socket is ${mode}`, async () => {
      const { client, sockets, timers, FakeWebSocket } = harness();
      await client.register();
      const original = client.ws;
      original.bufferedAmount = 6 * 1024 * 1024;
      const sending = format === "binary"
        ? client.SendBinary(new Uint8Array([1]), "00")
        : client.SendMessage("NoteModify", { path: "a.md" });
      assert.equal(timers.length, 1);
      if (mode === "closed") original.readyState = FakeWebSocket.CLOSED;
      if (mode === "unregistered") client.unRegister();
      if (mode === "replaced") client.ws = new FakeWebSocket();
      timers[0]();
      // Bound the regression: the old implementation either throws, sends to
      // the replacement, or schedules a second endless poll on the closed socket.
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(timers.length, 1, "disconnect must stop further buffer polling");
      const result = await sending;
      if (format === "binary") assert.equal(result, "closed");
      assert.equal(sockets.reduce((count, socket) => count + socket.sent.length, 0), 0);
    });
  }
}

for (const format of ["text", "binary"]) {
  test(`${format} sends once when the same connection drains normally`, async () => {
    const { client, sockets, timers } = harness();
    await client.register();
    client.ws.bufferedAmount = 6 * 1024 * 1024;
    const sending = format === "binary"
      ? client.SendBinary(new Uint8Array([1]), "00")
      : client.SendMessage("NoteModify", { path: "a.md" });
    client.ws.bufferedAmount = 0;
    timers[0]();
    const result = await sending;
    if (format === "binary") assert.equal(result, "sent");
    assert.equal(sockets[0].sent.length, 1);
  });
}

for (const format of ["text", "binary"]) {
  test(`${format} cancellation before the send continuation suppresses the write`, async () => {
    const { client, sockets } = harness();
    await client.register();
    let cancelled = false;
    let completed = 0;
    const before = () => cancelled;
    const after = () => { completed++; };
    const sending = format === "binary"
      ? client.SendBinary(new Uint8Array([1]), "00", before, after)
      : client.SendMessage("NoteModify", { path: "a.md" }, before, after);
    cancelled = true;
    const result = await sending;
    assert.equal(result, format === "binary" ? "cancelled" : true);
    assert.equal(sockets[0].sent.length, 0);
    assert.equal(completed, 0);
  });
}

for (const format of ["text", "binary"]) {
  test(`${format} cancellation interrupts backpressure without sending or calling after`, async () => {
    const { client, sockets, timers } = harness();
    await client.register();
    client.ws.bufferedAmount = 6 * 1024 * 1024;
    let cancelled = false;
    let completed = 0;
    const before = () => cancelled;
    const after = () => { completed++; };
    const sending = format === "binary"
      ? client.SendBinary(new Uint8Array([1]), "00", before, after)
      : client.SendMessage("NoteModify", { path: "a.md" }, before, after);
    assert.equal(timers.length, 1);
    cancelled = true;
    timers[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.length, 1, "cancelled writes must stop waiting even while the buffer remains full");
    const result = await sending;
    assert.equal(result, format === "binary" ? "cancelled" : true);
    assert.equal(sockets[0].sent.length, 0);
    assert.equal(completed, 0);
  });
}
