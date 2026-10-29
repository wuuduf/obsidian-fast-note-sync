/** Diagnostic IDs correlate work; they are never authentication credentials. */
export function validTraceId(value: unknown): string | undefined {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) ? value : undefined;
}

let fallbackSequence = 0;
export function createTraceId(): string {
    try {
        const generator = typeof crypto === 'undefined' ? undefined : crypto;
        const generated = validTraceId(generator?.randomUUID?.());
        if (generated) return generated;
        if (generator?.getRandomValues) {
            return Array.from(generator.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
        }
    } catch { /* Older/mobile runtimes may not expose Web Crypto. */ }
    return `trace-${Date.now().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export class DiagnosticRequestError extends Error {
    readonly traceId: string;
    constructor(error: unknown, traceId: string) {
        const message = error instanceof Error ? error.message : String(error);
        super(`${message} [诊断 ID: ${traceId}]`);
        this.name = 'DiagnosticRequestError';
        this.traceId = traceId;
    }
}

/** Keep old round identities for late local failures without unbounded retention. */
export class DiagnosticContexts {
    private readonly contexts = new Map<string, string>();
    constructor(private readonly limit = 128) {}
    begin(context: string, inherited?: string): string {
        const existing = this.contexts.get(context);
        if (existing) return existing;
        const traceId = validTraceId(inherited) || createTraceId();
        this.contexts.set(context, traceId);
        while (this.contexts.size > this.limit) {
            const oldest = this.contexts.keys().next();
            if (oldest.done) break;
            this.contexts.delete(oldest.value);
        }
        return traceId;
    }
    get(context?: string | null): string | undefined { return context ? this.contexts.get(context) : undefined; }
}

export function sourceTraceId(host: { diagnostics?: DiagnosticContexts }, context?: string | null, supplied?: unknown): string | undefined {
    return host.diagnostics?.get(context) || validTraceId(supplied);
}
