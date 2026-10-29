import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import crypto from 'node:crypto';

const file = new URL('../../src/lib/utils/diagnostics.ts', import.meta.url);
const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
export function loadDiagnostics(globals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, crypto: crypto.webcrypto, ...globals });
  return module.exports;
}
export const diagnostics = loadDiagnostics();
