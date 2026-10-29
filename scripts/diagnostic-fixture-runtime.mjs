import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import crypto from 'node:crypto';

/** Execute the real TypeScript helpers/mapper without a handwritten wire codec. */
export function loadDiagnosticRuntime() {
  const result = buildSync({
    stdin: { contents: 'export * from "./src/lib/utils/diagnostics.ts"; export * from "./src/pb/protobuf_mapper.ts"; export { proto } from "./src/pb/v1/sync.js";', resolveDir: new URL('..', import.meta.url).pathname },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: createRequire(import.meta.url), crypto: crypto.webcrypto,
    Uint8Array, TextEncoder, TextDecoder, ArrayBuffer, console,
  });
  return module.exports;
}
