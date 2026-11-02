import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

test('mutation retry modal validates input, submits the original path and reports errors', async () => {
  let change, click, closed = false; const notices = [], calls = [];
  class Modal { constructor() { this.titleEl = { setText() {} }; this.contentEl = { createEl() {}, empty() {} }; } close() { closed = true; } }
  class Setting {
    setName() { return this; }
    addText(fn) { const input = { setPlaceholder() { return this; }, onChange(callback) { change = callback; return this; } }; fn(input); return this; }
    addButton(fn) { const button = { setButtonText() { return this; }, setCta() { return this; }, onClick(callback) { click = callback; return this; } }; fn(button); return this; }
  }
  const filename = path.resolve(import.meta.dirname, '../src/views/retry-attachment-mutation-modal.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require(id) {
    if (id === 'obsidian') return { Modal, Setting };
    if (id.endsWith('/operator_file')) return { retryAttachmentMutationConflict: async (...args) => { calls.push(args); throw new Error('offline'); } };
    if (id.endsWith('/helpers')) return { showSyncNotice: message => notices.push(message) };
    throw new Error(id);
  } });
  const plugin = {}; const modal = new module.exports.RetryAttachmentMutationModal({}, plugin); modal.onOpen();
  click(); assert.match(notices[0], /请输入/); assert.equal(closed, false); assert.equal(calls.length, 0);
  change('  文件/图.png  '); click(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true); assert.equal(calls[0][0], '文件/图.png'); assert.equal(calls[0][1], plugin);
  assert.match(notices.at(-1), /offline/);
});
