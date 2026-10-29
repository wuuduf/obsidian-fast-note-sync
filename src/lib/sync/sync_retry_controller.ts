import type { SyncLog } from "./sync_log_manager";

export type RetryType = 'note' | 'file' | 'setting' | 'folder';
type RetryPatch = Pick<Partial<SyncLog>, 'status' | 'retryState' | 'retryMessage' | 'retryAttempts' | 'retryable'>;
interface RetryHost {
  getLog(id: string): SyncLog | undefined;
  update(id: string, patch: RetryPatch): void;
  vault(): string;
  context(): string | null;
  connected(): boolean;
  failures(type?: RetryType): number;
  covers?(type?: RetryType): boolean;
  sendPage(type: RetryType, context: string, page: number, traceId?: string): void;
  restart(traceId?: string): void;
}
interface Attempt {
  id: string; key: string; vault: string; context: string; type?: RetryType; page?: number;
  mode: 'page' | 'restart'; received: boolean; failedBefore: number; timer?: number;
}

/** The log row owns an attempt. Sending or receiving a page is not recovery:
 * only local page application or a successfully completed new round settles it. */
export class SyncRetryController {
  private attempts = new Map<string, Attempt>();
  private restarting = false;
  constructor(private readonly host: RetryHost, private readonly replyTimeout = 30_000, private readonly applyTimeout = 300_000) {}

  retry(id: string): boolean {
    const log = this.host.getLog(id);
    if (!log || (!log.retryable && log.retryState !== 'restart-required') || log.retryState === 'recovered' || [...this.attempts.values()].some((a) => a.id === id || a.mode === 'restart')) return false;
    if (log.vault && log.vault !== this.host.vault()) {
      this.host.update(id, { retryMessage: '请先切换到此日志对应的笔记库。' }); return false;
    }
    if (!this.host.connected()) {
      this.host.update(id, { retryState: 'restart-required', retryMessage: '连接已断开，请连接后重新同步。' }); return false;
    }
    if (this.host.covers?.(log.retryType) === false) {
      this.host.update(id, { retryState: 'restart-required', retryMessage: '此类同步当前未启用，请检查同步范围后重试。' }); return false;
    }
    const pageAvailable = log.retryState !== 'restart-required' && log.retryType && log.retryContext
      && Number.isSafeInteger(log.retryPageIndex) && log.retryPageIndex! >= 0 && this.host.context() === log.retryContext;
    const mode = pageAvailable ? 'page' : 'restart';
    if (mode === 'restart' && this.host.context() && this.host.context() !== log.retryContext) {
      this.host.update(id, { retryState: 'restart-required', retryMessage: '另一轮同步正在进行，请完成后再重新同步。' }); return false;
    }
    const key = JSON.stringify([this.host.vault(), log.retryContext, log.retryType, log.retryPageIndex]);
    if (this.attempts.has(key)) return false;
    const attempt: Attempt = { id, key, vault: this.host.vault(), context: log.retryContext ?? '', type: log.retryType, page: log.retryPageIndex, mode, received: false, failedBefore: this.host.failures(log.retryType) };
    this.attempts.set(key, attempt);
    this.host.update(id, { retryState: 'retrying', retryMessage: mode === 'page' ? '已请求失败页，等待本地处理完成。' : '正在重新同步，完成后更新恢复结果。', retryAttempts: (log.retryAttempts ?? 0) + 1 });
    this.arm(attempt, mode === 'page' ? this.replyTimeout : this.applyTimeout);
    try {
      if (mode === 'page') this.host.sendPage(attempt.type!, attempt.context, attempt.page!, log.traceId);
      else {
        // cancelSync is synchronous; ignore that deliberate cancellation only.
        this.restarting = true;
        try { this.host.restart(log.traceId); } finally { this.restarting = false; }
      }
    } catch (error) { this.finish(attempt, 'failed', error instanceof Error ? error.message : String(error)); }
    return true;
  }

  started(context: string, vault: string): void {
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.mode === 'restart' && attempt.vault === vault && !attempt.received) {
        attempt.context = context; attempt.received = true; this.arm(attempt, this.applyTimeout);
      } else if (attempt.context !== context || attempt.vault !== vault) {
        this.finish(attempt, 'restart-required', '同步会话已变化，请重新同步。');
      }
    }
  }

  acceptsContext(): boolean {
    return ![...this.attempts.values()].some((attempt) => attempt.mode === 'restart' && !attempt.received);
  }

  pageReceived(type: RetryType, context: string, page: number): void {
    for (const attempt of this.attempts.values()) {
      if (this.matches(attempt, type, context, page)) {
        attempt.received = true; this.arm(attempt, this.applyTimeout);
        this.host.update(attempt.id, { retryMessage: '失败页已收到，正在本地处理。' });
      }
    }
  }

  pageApplied(type: RetryType, context: string, page: number): void {
    for (const attempt of [...this.attempts.values()]) {
      if (!attempt.received || !this.matches(attempt, type, context, page)) continue;
      if (this.host.failures(type) > attempt.failedBefore) this.finish(attempt, 'restart-required', '本地处理仍有失败，请修复原因后重新同步。');
      else this.finish(attempt, 'recovered', '失败页已在本地处理完成。');
    }
  }

  error(data: { code: number; context?: string; vault?: string; message?: string; data?: Record<string, unknown> | null }): boolean {
    let consumed = false;
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.vault !== this.host.vault() || (data.vault && data.vault !== attempt.vault) || data.context !== attempt.context) continue;
      const payload = data.data;
      if (attempt.mode === 'page' && data.code === 439 && payload && payload.resourceType === attempt.type && payload.pageIndex === attempt.page) {
        const expired = payload.restartRequired === true || payload.reason === 'download_cache_expired';
        this.finish(attempt, expired ? 'restart-required' : 'failed', expired ? '下载缓存已过期，请重新同步获取最新数据。' : (data.message || '失败页重试仍未成功，可以再次重试。'));
        consumed = true;
      } else if (attempt.mode === 'restart' && data.code >= 300) {
        this.finish(attempt, 'restart-required', data.message || '重新同步仍有错误，请处理后重试。');
      }
    }
    return consumed;
  }

  completed(context: string, failed: number, partial = false): void {
    for (const attempt of [...this.attempts.values()]) {
      if (attempt.context !== context || attempt.vault !== this.host.vault()) continue;
      const complete = failed === 0 && !partial && this.host.covers?.(attempt.type) !== false;
      if (attempt.mode === 'restart' && attempt.received) this.finish(attempt, complete ? 'recovered' : 'restart-required', complete ? '重新同步已完成，失败条目已恢复。' : '本轮同步仍有失败或未处理项，请检查后重试。');
      else this.finish(attempt, 'restart-required', '本页尚未确认处理完成，请重新同步。');
    }
  }

  interrupt(message: string): void {
    if (this.restarting) return;
    for (const attempt of [...this.attempts.values()]) this.finish(attempt, 'restart-required', message);
  }

  clear(): void {
    for (const attempt of this.attempts.values()) if (attempt.timer) window.clearTimeout(attempt.timer);
    this.attempts.clear();
  }
  private matches(a: Attempt, type: RetryType, context: string, page: number) {
    return a.mode === 'page' && a.type === type && a.context === context && a.page === page && a.vault === this.host.vault();
  }
  private arm(attempt: Attempt, delay: number) {
    if (attempt.timer) window.clearTimeout(attempt.timer);
    attempt.timer = window.setTimeout(() => {
      if (this.attempts.get(attempt.key) === attempt) this.finish(attempt, 'restart-required', '重试未完成或缓存已失效，请重新同步。');
    }, delay);
  }
  private finish(attempt: Attempt, state: NonNullable<SyncLog['retryState']>, message: string) {
    if (this.attempts.get(attempt.key) !== attempt) return;
    if (attempt.timer) window.clearTimeout(attempt.timer);
    this.attempts.delete(attempt.key);
    this.host.update(attempt.id, { retryState: state, retryMessage: message, status: state === 'recovered' ? 'success' : 'error', retryable: state !== 'recovered' });
  }
}
