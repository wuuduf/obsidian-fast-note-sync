import fs from 'node:fs';
import path from 'node:path';
import { loadDiagnosticRuntime } from './diagnostic-fixture-runtime.mjs';

const destination = process.env.FNS_DIAGNOSTIC_REQUEST_PATH;
if (!destination) throw new Error('FNS_DIAGNOSTIC_REQUEST_PATH is required');
const { createTraceId, enSendDTOToProtobuf } = loadDiagnosticRuntime();
const traceId = createTraceId();
const context = 'diagnostic-contract-context';
const vault = 'Test';
const pageIndex = 2;
const request = enSendDTOToProtobuf('NoteSyncPageAck', { traceId, context, vault, pageIndex });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, JSON.stringify({ traceId, context, vault, pageIndex, requestBase64: Buffer.from(request).toString('base64') }, null, 2));
console.log(JSON.stringify({ status: 'pass', destination, traceId }));
