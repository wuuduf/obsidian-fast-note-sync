import { sourceTraceId } from "../utils/diagnostics";
import { TFile, TAbstractFile, normalizePath, Platform } from "obsidian";

import { ReceiveFileSyncUpdateMessage, FileUploadMessage, FileSyncChunkDownloadMessage, FileDownloadSession, ReceiveMtimeMessage, ReceivePathMessage, SyncEndData } from "../utils/types";
import { hashContent, hashArrayBuffer, generateUUID, getPluginDir, dump, dumpError, sleep, isPathExcluded, getSafeCtime, isLargeBinarySyncRisk, describeBinarySyncLimit, showSyncNotice, checkAndNotifyCaseConflict, logMemorySnapshot, hashFileAsync, vaultDelete } from "../utils/helpers";
import { FileCloudPreview } from "../storage/file_cloud_preview";
import { SyncLogManager } from "./sync_log_manager";
import { HttpApiService } from "../api/http_api_service";
import { withHashTimeout } from "./hash_timeout";
import { getAttachmentBaseSha, getAttachmentBaseVersion, validAttachmentVersion, setAttachmentBaseSha, getAttachmentConflict, setAttachmentConflict, setAttachmentMutationConflict, clearAttachmentMutationConflict, setAttachmentPendingConflict, clearAttachmentPendingConflict, shouldDeferAttachmentConflict, setAttachmentDeletedConflict, setAttachmentResolution, finishAttachmentResolution } from "./attachment_baseline";
import { saveAttachmentConflictCopy } from "./attachment_conflict_copy";
import type FastSync from "../../main";


// 下载内存缓冲控制 (20MB 阈值防止 OOM)
let currentDownloadBufferBytes = 0
const MAX_DOWNLOAD_BUFFER_BYTES = 20 * 1024 * 1024

// 上传中的文件追踪，用于删除时取消上传
const activeUploadsMap = new Map<string, { path: string; cancelled: boolean; context: string; reported?: boolean }>()
const cancelUploads = (path: string) => {
  let found = false;
  for (const upload of activeUploadsMap.values()) if (upload.path === path) { upload.cancelled = true; found = true; }
  return found;
};

type UploadSession = { path: string; pathHash: string; hash: string; sha256?: string; size?: number; mtime?: number; ctime?: number; vault: string; context: string; slotKey: string; pageIndex?: number };
type UploadState = { sessions: Map<string, UploadSession>; latest: Map<string, string>; ready: Map<string, { resolve: () => void; reject: (error: Error) => void }>; retries: Map<string, number> };
const uploadStates = new Map<FastSync, UploadState>();
const pendingUploadPreparations = new Set<(error: Error) => void>();
export async function sha256Bytes(content: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("无法计算上传快照 SHA-256");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", content);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

let attachmentReaders = 0;
type AttachmentWaiter = { resolve: () => void; cancel: () => void };
const attachmentWaiters: AttachmentWaiter[] = [];
async function acquireAttachmentReader(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Attachment snapshot cancelled");
  if (attachmentReaders < 2) { attachmentReaders++; return; }
  await new Promise<void>((resolve, reject) => {
    const waiter: AttachmentWaiter = {
      resolve: () => { signal?.removeEventListener("abort", waiter.cancel); resolve(); },
      cancel: () => {
        const index = attachmentWaiters.indexOf(waiter);
        if (index >= 0) attachmentWaiters.splice(index, 1);
        reject(signal?.reason ?? new Error("Attachment snapshot cancelled"));
      },
    };
    attachmentWaiters.push(waiter);
    signal?.addEventListener("abort", waiter.cancel, { once: true });
  });
}
function releaseAttachmentReader(): void {
  const next = attachmentWaiters.shift();
  if (next) next.resolve(); else attachmentReaders--;
}

/** Hash both protocol fingerprints from one bounded attachment snapshot. */
export async function captureAttachmentSnapshot(plugin: FastSync, file: TFile, signal?: AbortSignal) {
  await acquireAttachmentReader(signal);
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("Attachment snapshot cancelled");
    const stat = { size: file.stat.size, mtime: file.stat.mtime, ctime: getSafeCtime(file.stat) };
    const content = await plugin.app.vault.readBinary(file);
    if (signal?.aborted) throw signal.reason ?? new Error("Attachment snapshot cancelled");
    const [contentHash, snapshotSha256] = await Promise.all([hashArrayBuffer(content), sha256Bytes(content)]);
    if (content.byteLength !== stat.size || file.stat.size !== stat.size || file.stat.mtime !== stat.mtime || getSafeCtime(file.stat) !== stat.ctime)
      throw new Error("文件在计算上传快照时发生变化");
    return { ...stat, contentHash, snapshotSha256 };
  } finally {
    releaseAttachmentReader();
  }
}

export function matchingUploadCheckpoint(plugin: FastSync, pathHash: string, snapshot: { contentHash: string; snapshotSha256: string; size: number; mtime: number; ctime: number }, baseVersion?: string): string | undefined {
  try {
    const key = `fns-${plugin.app.vault.getName()}-uploadSession-${pathHash}`;
    const raw = plugin.app.loadLocalStorage(key) as string | undefined;
    const cp = raw ? JSON.parse(raw) : null;
    if (cp && typeof cp.sessionId === "string" && cp.sessionId && cp.contentHash === snapshot.contentHash &&
        cp.sha256 === snapshot.snapshotSha256 && cp.baseVersion === (baseVersion ?? '') && cp.size === snapshot.size && cp.mtime === snapshot.mtime && cp.ctime === snapshot.ctime &&
        Number.isSafeInteger(cp.lastChunkIndex) && cp.lastChunkIndex >= 0) return cp.sessionId;
  } catch { /* Invalid or old checkpoints are never resumed. */ }
  return undefined;
}
function uploadState(plugin: FastSync): UploadState {
  let state = uploadStates.get(plugin);
  if (!state) { state = { sessions: new Map(), latest: new Map(), ready: new Map(), retries: new Map() }; uploadStates.set(plugin, state); }
  return state;
}
function finishUploadSession(state: UploadState, id: string, path: string) {
  state.sessions.delete(id);
  if (![...state.sessions.values()].some(session => session.path === path)) {
    state.latest.delete(path);
  }
}
function clearUploadCheckpoint(plugin: FastSync, key: string, sessionId: string) {
  try {
    const raw = plugin.app.loadLocalStorage(key) as string | undefined;
    if (raw && JSON.parse(raw).sessionId === sessionId) plugin.app.saveLocalStorage(key, null);
  } catch { /* Invalid or unavailable local storage must not affect cleanup. */ }
}

export const receiveFileUploadReady = (data: { sessionId?: string }, plugin: FastSync) => {
  if (data.sessionId) uploadState(plugin).ready.get(data.sessionId)?.resolve();
};

/** A server-confirmed matching snapshot can safely initialize a missing base. */
export const receiveFileBaseline = async (data: { path?: string; pathHash?: string; snapshotSha256?: string; fileVersion?: string; context?: string; pageIndex?: number }, plugin: FastSync) => {
  const vault = plugin.settings.vault;
  const context = data.context;
  try {
    if (!data.path || data.pathHash !== hashContent(data.path) || !data.snapshotSha256 || !/^[a-f0-9]{64}$/.test(data.snapshotSha256) || !validAttachmentVersion(data.fileVersion)) return;
    const path = normalizePath(data.path);
    if (isPathExcluded(path, plugin) || getAttachmentConflict(plugin, path, vault) || !ownsCurrentContext(plugin, context)) return;
    await plugin.lockManager.withLock(path, async () => {
      const file = plugin.app.vault.getFileByPath(path);
      if (!file || plugin.settings.vault !== vault || !ownsCurrentContext(plugin, context)) return;
      const snapshot = await withHashTimeout(signal => captureAttachmentSnapshot(plugin, file, signal));
      if (snapshot.snapshotSha256 !== data.snapshotSha256 || plugin.settings.vault !== vault || !ownsCurrentContext(plugin, context) || getAttachmentConflict(plugin, path, vault) || plugin.app.vault.getFileByPath(path) !== file) return;
      setAttachmentBaseSha(plugin, path, snapshot.contentHash, snapshot.snapshotSha256, vault, data.fileVersion);
      plugin.fileHashManager.setFileHash(path, snapshot.contentHash, -1, -1);
    }, { maxRetries: 5, retryInterval: 50 });
  } catch (error) { dump("Unable to confirm attachment baseline", error); }
  finally {
    if (data.pageIndex !== undefined && plugin.settings.vault === vault && ownsCurrentContext(plugin, context))
      plugin.recordSyncCompleted('file', data.pageIndex, context);
  }
};

type FileCompletionOwner = { pageIndex?: number; context: string; vault: string; traceId?: string; untracked?: boolean; failureRecorded?: boolean };
const pendingFileRePush = new Map<string, FileCompletionOwner[]>();
const mutationPages = new WeakMap<FastSync, { vault: string; context: string; keys: Set<string> }>();
function firstMutationPageMessage(plugin: FastSync, context: string, pageIndex: number | undefined, path: string): boolean {
  if (pageIndex === undefined) return true;
  let state = mutationPages.get(plugin);
  if (!state || state.context !== context || state.vault !== plugin.settings.vault) {
    state = { context, vault: plugin.settings.vault, keys: new Set() };
    mutationPages.set(plugin, state);
  }
  const key = JSON.stringify([pageIndex, normalizePath(path)]);
  if (state.keys.has(key)) return false;
  state.keys.add(key);
  return true;
}
const rePushKey = (context: string, path: string, vault: string) => JSON.stringify([vault, context, normalizePath(path)]);
export const clearPendingFileRePush = () => pendingFileRePush.clear();
const ownsCurrentContext = (plugin: FastSync, context?: string) => context === undefined || context === (plugin.syncState.activeSyncContext ?? "");
const ownsFileSession = (plugin: FastSync, session: { context?: string; vault?: string }) =>
  (!session.vault || session.vault === plugin.settings.vault) && ownsCurrentContext(plugin, session.context);
const prunePendingFileRePush = (plugin: FastSync) => {
  const current = plugin.syncState.activeSyncContext ?? "";
  for (const [key, owners] of pendingFileRePush)
    if (owners[0]?.context !== current || owners[0]?.vault !== plugin.settings.vault) pendingFileRePush.delete(key);
};
const reportFileCompletion = (plugin: FastSync, session: Pick<FileDownloadSession, "pageIndex" | "context" | "vault" | "completionOwners" | "completionState">, failed = false) => {
  if (session.completionState?.reported) return;
  if (session.completionState) session.completionState.reported = true;
  if (!ownsFileSession(plugin, session)) return;
  const owners = session.completionOwners;
  if (failed && ownsCurrentContext(plugin, session.context) &&
      (!owners?.length || owners.some(owner => !owner.untracked && !owner.failureRecorded))) plugin.fileSyncTasks.failed++;
  if (owners?.length) {
    for (const owner of owners) if (!owner.untracked) plugin.recordSyncCompleted('file', owner.pageIndex, owner.context);
  } else plugin.recordSyncCompleted('file', session.pageIndex, session.context);
};

// 全局中止信号，用于插件卸载时
export let isPluginUnloading = false;

// 会话 ID 到文件路径的映射，用于处理 463 会话不存在错误
const sessionIdToPathMap = new Map<string, string>()

// 大文件跳过同步通知去重：本会话内已提示过的 "path|size"，避免同一文件每轮同步重复弹 toast
const sessionLargeFileNotified = new Set<string>()

/**
 * 大文件跳过同步的通知去重：同一 (path, size) 组合本会话或历史设置中已提示过则只 dump，不再弹 toast
 * Dedup notice for large-file-skip: only dump (no toast) if this (path, size) pair was already notified
 * either in this session or recorded in settings history
 */
function notifyLargeFileSkipped(plugin: FastSync, path: string, size: number, message: string): void {
  const key = `${path}|${size}`
  const shown = plugin.settings.largeFileNoticeShown ?? []
  if (sessionLargeFileNotified.has(key) || shown.includes(key)) {
    dump(`Large file skip notice suppressed (already shown): ${key}`)
    return
  }
  showSyncNotice(message, 5000)
  sessionLargeFileNotified.add(key)
  // 重新赋值而非 push：settings 可能与 DEFAULT_SETTINGS 浅拷贝共享同一数组引用，原地 push 会污染默认值
  const next = [...shown, key]
  if (next.length > 200) next.shift()
  plugin.settings.largeFileNoticeShown = next
  void plugin.saveSettings()
}

/**
 * 获取临时分片目录路径
 */
export const getTempChunksDir = (plugin: FastSync, sessionId?: string) => {
  const base = normalizePath(`${getPluginDir(plugin)}/temp-chunks`)
  return sessionId ? normalizePath(`${base}/${sessionId}`) : base
}

/**
 * 清理指定会话的临时目录
 */
export const clearTempChunksDir = async (plugin: FastSync, sessionId: string) => {
  const path = getTempChunksDir(plugin, sessionId)
  if (await plugin.app.vault.adapter.exists(path)) {
    await plugin.app.vault.adapter.rmdir(path, true)
  }
}

const shouldUseMemoryDownload = (size: number) => Platform.isMobile && size <= MAX_DOWNLOAD_BUFFER_BYTES

const createDownloadStorage = (plugin: FastSync, sessionId: string, size: number): Pick<FileDownloadSession, "chunks" | "downloadedChunks" | "tempDir"> => {
  if (shouldUseMemoryDownload(size)) {
    return { chunks: new Map<number, ArrayBuffer>() }
  }
  return {
    downloadedChunks: new Set<number>(),
    tempDir: getTempChunksDir(plugin, sessionId),
  }
}

const getCompletedDownloadChunks = (session: FileDownloadSession) => {
  return session.tempDir ? session.downloadedChunks?.size || 0 : session.chunks?.size || 0
}

const getSessionMemoryBytes = (session: FileDownloadSession) => {
  if (session.tempDir) return 0
  return Array.from(session.chunks?.values() || []).reduce((sum, c) => sum + c.byteLength, 0)
}

const releaseSessionMemory = (session: FileDownloadSession) => {
  const sessionSize = getSessionMemoryBytes(session)
  if (sessionSize > 0) {
    currentDownloadBufferBytes = Math.max(0, currentDownloadBufferBytes - sessionSize)
  }
}

const formatDownloadError = (e: unknown) => {
  return e instanceof Error ? e.message : String(e)
}

// failed=true 表示本次会话是因下载/写盘失败而清理，需计入 fileSyncTasks.failed，
// 与 completed（驱动完成判定/翻页 ACK，语义不变）区分开，避免失败被状态栏当作成功展示
// failed=true means this session is being cleaned up due to a download/write failure and
// should count toward fileSyncTasks.failed, kept separate from completed (which still drives
// completion detection / page ACK unchanged), so failures aren't surfaced as success in the status bar
const cleanupFileDownloadSession = async (plugin: FastSync, session: FileDownloadSession, failed = false) => {
  releaseSessionMemory(session)
  for (const [key, current] of plugin.fileDownloadSessions) if (current === session) plugin.fileDownloadSessions.delete(key)
  if (session.tempDir) await clearTempChunksDir(plugin, session.sessionId)
  reportFileCompletion(plugin, session, failed)
}

const failFileDownloadSession = async (plugin: FastSync, session: FileDownloadSession, message: string, releaseSlot = true) => {
  dumpError(`File download failed: ${session.path} (${session.sessionId}) - ${message}`)
  const completedCount = getCompletedDownloadChunks(session)
  SyncLogManager.getInstance().addOrUpdateLog({
    id: session.sessionId,
    type: 'receive',
    action: 'FileDownload',
    path: session.path,
    traceId: session.traceId,
    vault: session.vault,
    status: 'error',
    progress: session.totalChunks === 0 ? 0 : Math.floor((completedCount / session.totalChunks) * 100),
    message
  });
  await cleanupFileDownloadSession(plugin, session, true)
  if (releaseSlot) {
    plugin.concurrencyLimiter.releaseSlot(`download_${session.path}`)
  }
}

const storeMemoryChunk = (session: FileDownloadSession, chunkIndex: number, chunkData: ArrayBuffer) => {
  if (!session.chunks) session.chunks = new Map<number, ArrayBuffer>()
  const existingChunk = session.chunks.get(chunkIndex)
  session.chunks.set(chunkIndex, chunkData)
  if (existingChunk) {
    currentDownloadBufferBytes = Math.max(0, currentDownloadBufferBytes - existingChunk.byteLength + chunkData.byteLength)
    return false
  }
  currentDownloadBufferBytes += chunkData.byteLength
  return true
}

const fallbackFileDownloadSessionToMemory = async (plugin: FastSync, session: FileDownloadSession, chunkIndex: number, chunkData: ArrayBuffer) => {
  const oldTempDir = session.tempDir
  const downloadedChunks = Array.from(session.downloadedChunks || [])
  session.chunks = new Map<number, ArrayBuffer>()

  if (oldTempDir) {
    for (const index of downloadedChunks) {
      const chunkPath = normalizePath(`${oldTempDir}/${index}.bin`)
      if (await plugin.app.vault.adapter.exists(chunkPath)) {
        const chunk = await plugin.app.vault.adapter.readBinary(chunkPath)
        storeMemoryChunk(session, index, chunk)
      }
    }
  }

  const wasNewChunk = storeMemoryChunk(session, chunkIndex, chunkData)
  session.tempDir = undefined
  session.downloadedChunks = undefined
  if (oldTempDir) await clearTempChunksDir(plugin, session.sessionId)
  return wasNewChunk
}

/**
 * 清理所有残留的临时目录
 */
export const clearAllTempChunks = async (plugin: FastSync) => {
  clearPendingFileRePush();
  const path = getTempChunksDir(plugin)
  if (await plugin.app.vault.adapter.exists(path)) {
    dump(`Cleaning all temp chunks: ${path}`)
    await plugin.app.vault.adapter.rmdir(path, true)
  }
  // 确保基础目录在清理后立即存在 (Ensure base dir exists immediately after cleanup)
  if (!(await plugin.app.vault.adapter.exists(path))) {
    await plugin.app.vault.adapter.mkdir(path)
  }
}

export const clearUploadQueue = () => {
  for (const reject of pendingUploadPreparations) reject(new Error("上传连接已断开"));
  pendingUploadPreparations.clear();
  for (const upload of activeUploadsMap.values()) upload.cancelled = true;
  sessionIdToPathMap.clear();
  uploadStates.clear();
}

/**
 * 中止所有进行中的文件操作 (插件卸载时调用)
 */
export const abortAllFileOperations = () => {
  clearPendingFileRePush();
  clearUploadQueue();
  isPluginUnloading = true;
  for (const upload of activeUploadsMap.values()) {
    upload.cancelled = true;
  }
  dump("All file operations aborted.");
}

/**
 * 重置文件操作状态 (插件加载时调用)
 */
export const resetFileOperations = () => {
  clearPendingFileRePush();
  isPluginUnloading = false;
}

export const BINARY_PREFIX_FILE_SYNC = "00"

/**
 * 文件（非笔记）修改事件处理
 */
export const fileModify = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false, resolutionBaseSha?: string) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!plugin.syncState.attachmentConflictSupported) { showSyncNotice("同步服务不支持安全的附件冲突检测，请升级同步服务。", 6000); return; }
  if (!plugin.syncState.attachmentVersionCASSupported) { showSyncNotice("同步服务不支持附件版本保护，请升级同步服务。", 6000); return; }
  if (!(file instanceof TFile)) return
  if (file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return
  const sourceVault = plugin.settings.vault, sourcePath = file.path, sourceConnection = plugin.websocket.count;

  if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
    dump(`Skip file modify for large attachment (${describeBinarySyncLimit()} limit): ${file.path}`, file.stat.size)
    notifyLargeFileSkipped(plugin, file.path, file.stat.size, `Fast Note Sync skipped large file: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    plugin.addIgnoredFile(file.path)
    try {
      const baseHash = plugin.fileHashManager.getPathHash(file.path)
      const baseSha256 = resolutionBaseSha ?? getAttachmentBaseSha(plugin, file.path, baseHash)
      const baseVersion = resolutionBaseSha ? getAttachmentConflict(plugin, file.path)?.remoteVersion : getAttachmentBaseVersion(plugin, file.path, baseHash);
      if (resolutionBaseSha && !validAttachmentVersion(baseVersion)) throw new Error("缺少可确认的远端附件版本，请先重新获取冲突版本。");
      const snapshot = await withHashTimeout(signal => captureAttachmentSnapshot(plugin, file, signal));
      if (plugin.settings.vault !== sourceVault || file.path !== sourcePath || !plugin.syncState.attachmentVersionCASSupported) return;
      if (!resolutionBaseSha && shouldDeferAttachmentConflict(plugin, file.path, snapshot.snapshotSha256)) {
        dump(`Attachment conflict unchanged; waiting for user resolution: ${file.path}`);
        return;
      }
      if (resolutionBaseSha) setAttachmentResolution(plugin, file.path, resolutionBaseSha, snapshot.snapshotSha256, plugin.settings.vault, baseVersion);
      const contentHash = snapshot.contentHash;
      const pathHash = hashContent(file.path);
      const resumeSessionId = matchingUploadCheckpoint(plugin, pathHash, snapshot, baseVersion);
      logMemorySnapshot(`after modify hash ${file.path}`)

      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash,
        contentHash: contentHash,
        snapshotSha256: snapshot.snapshotSha256,
        versionGuard: true,
        mtime: snapshot.mtime,
        ctime: snapshot.ctime,
        size: snapshot.size,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        // 始终传递 baseHash 信息，如果不可用则标记 baseHashMissing
        ...(baseVersion && baseSha256 ? { baseHash, baseSha256, baseVersion } : { baseHashMissing: true }),
      }
      // 将 hash 暂存到 pending map，等待服务端 FileUploadAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server FileUploadAck
      // 新建操作覆盖删除意图，清除 pending 防止晚到的 Ack 错误删除新文件 hash
      // New upload supersedes delete intent; clear pending to prevent stale Ack from removing new hash
      plugin.pendingFileDeleteAcks.delete(file.path)
      plugin.pendingUploadHashes.set(file.path, contentHash)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      const checkSlot = `upload-check:${generateUUID()}`;
      await plugin.concurrencyLimiter.waitForSlot(checkSlot)
      let sent = false;
      try {
        await plugin.websocket.SendMessage("FileUploadCheck", data,
          () => plugin.settings.vault !== sourceVault || file.path !== sourcePath || plugin.websocket.count !== sourceConnection || !plugin.syncState.attachmentVersionCASSupported,
          () => { sent = true; });
      } finally {
        plugin.concurrencyLimiter.releaseSlot(checkSlot)
        if (!sent && plugin.pendingUploadHashes.get(sourcePath) === contentHash) {
          plugin.pendingUploadHashes.delete(sourcePath);
          plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes);
        }
      }
      dump(`File modify check sent`, data.path, data.contentHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 文件删除事件处理
 */
export function attachmentMutationBase(plugin: FastSync, path: string): { baseSha256: string; baseVersion: string } | { baseHashMissing: true } {
  const hash = plugin.fileHashManager.getPathHash(path);
  const base = getAttachmentBaseSha(plugin, path, hash), version = getAttachmentBaseVersion(plugin, path, hash);
  return base && version ? { baseSha256: base, baseVersion: version } : { baseHashMissing: true };
}

/** An offline-deleted path stays protected until its conflict is resolved. */
export function offlineAttachmentDeletion(plugin: FastSync, path: string): { path: string; pathHash: string; versionGuard: true; baseSha256?: string; baseVersion?: string; baseHashMissing?: boolean } | undefined {
  if ((!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported) || !plugin.syncState.attachmentVersionCASSupported || getAttachmentConflict(plugin, path)?.mutation) return undefined;
  return { path, pathHash: hashContent(path), versionGuard: true, ...attachmentMutationBase(plugin, path) };
}

/** Drop only local ownership on reconnect; later sync retries from confirmed bases. */
export function clearPendingFileMutations(plugin: FastSync): void {
  for (const pending of plugin.syncState.pendingFileDeleteOperations?.values() ?? [])
    plugin.concurrencyLimiter.releaseSlot(pending.slotKey);
  plugin.syncState.pendingFileDeleteOperations?.clear();
  for (const pending of plugin.pendingFileRenames ?? [])
    if (pending.slotKey) plugin.concurrencyLimiter.releaseSlot(pending.slotKey);
  plugin.pendingFileRenames = [];
  plugin.pendingFileDeleteAcks?.clear();
}

export const fileDelete = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (!plugin.syncState.attachmentConflictSupported || !plugin.syncState.attachmentVersionCASSupported) { showSyncNotice("同步服务不支持安全的附件版本保护，请升级同步服务。", 6000); return; }
  if ((!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) { showSyncNotice("同步服务不支持安全的附件删除，请升级同步服务。", 6000); return; }
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  const path = file.path;
  const sourceVault = plugin.settings.vault, sourceConnection = plugin.websocket.count;
  if (file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return
  if (getAttachmentConflict(plugin, file.path)?.mutation) { showSyncNotice("附件仍有未处理的删除或重命名冲突。", 6000); return; }


  // --- 新增：删除拦截 ---
  if (plugin.lastSyncPathDeleted.has(file.path)) {
    dump(`File delete intercepted: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(path, async () => {
    if (plugin.settings.vault !== sourceVault || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) return;
    // 如果该文件正在上传或在队列中，则标记为取消，且不再发送服务端删除消息
    if (cancelUploads(path)) {
      dump(`Upload cancelled due to file deletion: ${path}`);
      // 仅清理本地状态
      plugin.pendingUploadHashes.delete(path)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      return
    }

    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending upload record to avoid pending map memory leak
    plugin.pendingUploadHashes.delete(path)
    plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)

    plugin.addIgnoredFile(path)
    try {
      const operationId = generateUUID(), slotKey = `mutation-delete:${operationId}`;
      const data = {
        vault: plugin.settings.vault,
        path,
        pathHash: hashContent(path),
        operationId,
        versionGuard: true,
        ...attachmentMutationBase(plugin, path),
      }
      await plugin.concurrencyLimiter.waitForSlot(slotKey)
      let sent = false;
      try {
        await plugin.websocket.SendMessage("FileDelete", data, () => plugin.settings.vault !== sourceVault || plugin.websocket.count !== sourceConnection || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported) || file.path !== path, () => {
          plugin.syncState.pendingFileDeleteOperations.set(operationId, { path, vault: sourceVault, slotKey });
          plugin.pendingFileDeleteAcks.add(path); sent = true;
        });
      } finally { if (!sent) plugin.concurrencyLimiter.releaseSlot(slotKey); }
      dump(`File delete send`, path)
    } finally {
      plugin.removeIgnoredFile(path)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 按路径字符串发送文件删除消息（用于无法获取 TFile 对象的场景，如 rename 后旧路径已不存在）
 * Send file delete message by path string (for scenarios where TFile object is unavailable, e.g., old path after rename)
 */
export const fileDeleteByPath = async function (filePath: string, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) { showSyncNotice("同步服务不支持安全的附件冲突检测，请升级同步服务。", 6000); return; }
  if ((!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) { showSyncNotice("同步服务不支持安全的附件删除，请升级同步服务。", 6000); return; }
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (filePath.endsWith(".md")) return
  if (isPathExcluded(filePath, plugin)) return
  if (getAttachmentConflict(plugin, filePath)?.mutation) { showSyncNotice("附件仍有未处理的删除或重命名冲突。", 6000); return; }

  if (plugin.lastSyncPathDeleted.has(filePath)) return
  const sourceVault = plugin.settings.vault, sourceConnection = plugin.websocket.count;

  await plugin.lockManager.withLock(filePath, async () => {
    if (plugin.settings.vault !== sourceVault || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) return;
    // 如果该文件正在上传或在队列中，则标记为取消，且不再发送服务端删除消息
    // If the file is being uploaded or in the queue, cancel and skip server delete
    if (cancelUploads(filePath)) {
      plugin.pendingUploadHashes.delete(filePath)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      return
    }

    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending upload record to avoid pending map memory leak
    plugin.pendingUploadHashes.delete(filePath)
    plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)

    plugin.addIgnoredFile(filePath)
    try {
      const operationId = generateUUID(), slotKey = `mutation-delete:${operationId}`;
      await plugin.concurrencyLimiter.waitForSlot(slotKey)
      let sent = false;
      try {
        await plugin.websocket.SendMessage("FileDelete", {
          vault: sourceVault, path: filePath, pathHash: hashContent(filePath), operationId, versionGuard: true,
          ...attachmentMutationBase(plugin, filePath),
        }, () => plugin.settings.vault !== sourceVault || plugin.websocket.count !== sourceConnection || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported), () => {
          plugin.syncState.pendingFileDeleteOperations.set(operationId, { path: filePath, vault: sourceVault, slotKey });
          plugin.pendingFileDeleteAcks.add(filePath); sent = true;
        });
      } finally { if (!sent) plugin.concurrencyLimiter.releaseSlot(slotKey); }
      dump(`File delete by path send`, filePath)
    } finally {
      plugin.removeIgnoredFile(filePath)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 文件重命名事件处理
 */
export const fileRename = async function (file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter: boolean = false) {
  if (!plugin.syncState.attachmentConflictSupported) { showSyncNotice("同步服务不支持安全的附件冲突检测，请升级同步服务。", 6000); return; }
  if ((!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) { showSyncNotice("同步服务不支持安全的附件重命名，请升级同步服务。", 6000); return; }
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (file.path.endsWith(".md")) return
  if (getAttachmentConflict(plugin, oldfile)?.mutation) { showSyncNotice("附件仍有未处理的删除或重命名冲突。", 6000); return; }
  if (plugin.isIgnoredFile(file.path) && eventEnter) return
  const newExcluded = isPathExcluded(file.path, plugin)
  const oldExcluded = isPathExcluded(oldfile, plugin)

  // Cross-exclusion-boundary rename handling
  // 跨排除边界重命名处理
  if (newExcluded && !oldExcluded) {
    // Moving from normal folder to excluded folder: delete old path on server
    // 从正常文件夹移至排除文件夹：删除服务端旧路径
    void fileDeleteByPath(oldfile, plugin)
    return
  }
  if (!newExcluded && oldExcluded) {
    // Moving from excluded folder to normal folder: create new file on server
    // 从排除文件夹移至正常文件夹：在服务端创建新文件
    void fileModify(file, plugin, true)
    return
  }
  if (newExcluded && oldExcluded) {
    // Both paths excluded: do nothing
    // 两个路径均被排除：不处理
    return
  }

  if (!(file instanceof TFile)) return
  const newPath = file.path;
  const sourceVault = plugin.settings.vault, sourceConnection = plugin.websocket.count;

  // --- 新增：重命名拦截 ---
  if (plugin.lastSyncPathRenamed.has(file.path)) {
    dump(`File rename intercepted: ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(newPath, async () => {
    if (plugin.settings.vault !== sourceVault || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported)) return;
    plugin.addIgnoredFile(newPath)
    try {
      dump(`File rename`, oldfile, file.path)

      // 如果旧文件正在上传，则取消上传且不发送删除消息
      if (cancelUploads(oldfile)) {
        // 重新上传
        void fileModify(file, plugin)
        dump(`Upload cancelled due to file rename: ${oldfile}`);
      } else {

        let contentHash = plugin.fileHashManager.getPathHash(oldfile)
        if (contentHash == null) {
          // 尝试新路径哈希缓存 (Try new path cache)
          contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
          if (contentHash == null) {
            if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
              dump(`Skip rename hash for large attachment (${describeBinarySyncLimit()} limit): ${file.path}`, file.stat.size)
              return
            }
            contentHash = await hashFileAsync(plugin.app, file.path)
          }
        }

        const baseline = attachmentMutationBase(plugin, oldfile);
        const operationId = generateUUID(), slotKey = `mutation-rename:${operationId}`;
        const data = {
          vault: plugin.settings.vault,
          oldPath: oldfile,
          oldPathHash: hashContent(oldfile),
          path: newPath,
          pathHash: hashContent(newPath),
          operationId,
          versionGuard: true,
          ...baseline,
        }
        // 将重命名推入待确认队列，等待服务端 FileRenameAck 后再更新 hashManager
        // Push rename to pending queue; hashManager will be updated after server FileRenameAck
        await plugin.concurrencyLimiter.waitForSlot(slotKey)
        let sent = false;
        try {
          await plugin.websocket.SendMessage("FileRename", data, () => plugin.settings.vault !== sourceVault || plugin.websocket.count !== sourceConnection || (!plugin.syncState.attachmentMutationCASSupported || !plugin.syncState.attachmentVersionCASSupported) || file.path !== newPath, () => {
            plugin.pendingFileRenames.push({ oldPath: oldfile, newPath, contentHash, vault: sourceVault, operationId, slotKey, baseSha256: 'baseSha256' in baseline ? baseline.baseSha256 : undefined }); sent = true;
          });
        } finally { if (!sent) plugin.concurrencyLimiter.releaseSlot(slotKey); }
      }
    } finally {
      plugin.removeIgnoredFile(newPath)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}


/**
 * 接收服务端文件上传指令 (FileUpload)
 */
export const receiveFileUpload = async function (data: FileUploadMessage, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported || !plugin.syncState.attachmentVersionCASSupported) { showSyncNotice("同步服务不支持附件版本保护，请升级同步服务。", 6000); return; }
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return

  if (plugin.settings.readonlySyncEnabled) {
    dump(`Read-only mode: Intercepted file upload request for ${data.path}`)
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
    return
  }
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
    return
  }
  dump(`Receive file need upload (queued): `, data.path, data.sessionId)

  const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
  if (!file) {
    dump(`File not found for upload: ${data.path} `)
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
    return
  }
  if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
    dump(`Skip file upload for large attachment (${describeBinarySyncLimit()} limit): ${data.path}`, file.stat.size)
    notifyLargeFileSkipped(plugin, data.path, file.stat.size, `Fast Note Sync skipped large file upload: ${data.path}`)
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
    return
  }
  // Validate wire values before using them for progress accounting or
  // registering this session as the latest one for the path. In particular,
  // Infinity/NaN or a zero chunk size must not poison the progress counters.
  const chunkSize = data.chunkSize === undefined ? 1024 * 1024 : data.chunkSize;
  if (data.requiresPrepare !== true || !data.expectedContentHash ||
      typeof data.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.expectedSha256) ||
      !Number.isSafeInteger(data.expectedSize) || data.expectedSize! < 0 ||
      !Number.isSafeInteger(data.expectedMtime) || !Number.isSafeInteger(data.expectedCtime) ||
      !Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    SyncLogManager.getInstance().addOrUpdateLog({ id: data.sessionId, type: 'send', action: 'FileUpload', path: data.path, traceId, vault: sourceVault, status: 'error', message: "同步服务版本过旧或上传会话参数无效，无法安全校验上传快照，请升级同步服务" });
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
    return;
  }
  const upload = uploadState(plugin);
  if (upload.sessions.has(data.sessionId)) return;
  upload.latest.set(data.path, data.sessionId);
  const slotKey = `upload-session:${data.sessionId}`;
  upload.sessions.set(data.sessionId, { path: data.path, pathHash: data.pathHash, hash: "", vault: sourceVault, context: sourceContext, slotKey, pageIndex: data.pageIndex });
  sessionIdToPathMap.set(data.sessionId, data.path)

  // NeedPush(FileUpload) 驱动的上传-回执往返：FileUploadAck 本身不带 pageIndex，按 path 记下所属页
  // 供 Ack 到达时查表归账（见 sync_state.ts pendingFilePushPageIndex 注释）
  // NeedPush(FileUpload)-driven upload/ack round trip: FileUploadAck carries no pageIndex; record
  // the owning page by path for the Ack to look up on arrival (see sync_state.ts
  // pendingFilePushPageIndex comment)
  const expectedSize = data.expectedSize!;
  const matchesFileAtScheduling = file.stat.size === expectedSize && file.stat.mtime === data.expectedMtime && getSafeCtime(file.stat) === data.expectedCtime;
  const actualTotalChunks = matchesFileAtScheduling ? (expectedSize === 0 ? 1 : Math.ceil(expectedSize / chunkSize)) : 0;

  // 始终在进入并发队列前就累加待上传分片总数，以精确驱动进度条
  plugin.totalChunksToUpload += actualTotalChunks

  const runUpload = async () => {
    // 标记该路径进入活跃上传状态
    activeUploadsMap.set(data.sessionId, { path: data.path, cancelled: false, context: sourceContext });
    await plugin.concurrencyLimiter.waitForSlot(slotKey, false, 10) // 优先级设为 10，优先处理上传

    // 断点续传 checkpoint key，提升到 try 外以便 catch 块中也能清除
    // Resume checkpoint key hoisted outside try so the catch block can also remove it
    const vaultName = plugin.app.vault.getName()
    const checkpointKey = `fns-${vaultName}-uploadSession-${data.pathHash}`

    try {
      // Reject obsolete or impossible instructions before reading potentially
      // large attachments. A matching instruction still needs a fresh read and
      // full SHA-256: metadata cannot prove that the file is unchanged.
      if (isPluginUnloading || activeUploadsMap.get(data.sessionId)?.cancelled || uploadState(plugin).latest.get(data.path) !== data.sessionId)
        throw new Error("上传会话已被更新的会话取代");
      if (!matchesFileAtScheduling || file.stat.size !== data.expectedSize || file.stat.mtime !== data.expectedMtime || getSafeCtime(file.stat) !== data.expectedCtime)
        throw new Error("文件在创建上传会话后发生变化，请重新同步");

      // 延迟到任务排到时才读取文件内容, 减少内存积压
      const readStat = { size: file.stat.size, mtime: file.stat.mtime, ctime: getSafeCtime(file.stat) };
      let content: ArrayBuffer | null = null;
      try {
        logMemorySnapshot(`before upload read ${data.path}`)
        content = await plugin.app.vault.readBinary(file)
      } catch (e) {
        dump(`Failed to read file for upload: ${data.path}`, e)
      }
      if (!content) {
        plugin.totalChunksToUpload -= actualTotalChunks
        plugin.concurrencyLimiter.releaseSlot(slotKey)
        finishUploadSession(uploadState(plugin), data.sessionId, data.path);
        sessionIdToPathMap.delete(data.sessionId);
        plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
        return;
      }

      // Hash the same snapshot used for the chunks. A second disk read can
      // observe a newer version and associate its hash with older bytes.
      const contentHash = await hashArrayBuffer(content)
      if (contentHash !== data.expectedContentHash || content.byteLength !== data.expectedSize ||
          readStat.size !== data.expectedSize || readStat.mtime !== data.expectedMtime || readStat.ctime !== data.expectedCtime ||
          file.stat.size !== readStat.size || file.stat.mtime !== readStat.mtime || getSafeCtime(file.stat) !== readStat.ctime) {
        throw new Error("文件在创建上传会话后发生变化，请重新同步");
      }
      const sha256 = await sha256Bytes(content);
      if (sha256 !== data.expectedSha256) throw new Error("文件在创建上传会话后发生变化，请重新同步");
      const state = uploadState(plugin);
      if (state.latest.get(data.path) !== data.sessionId) throw new Error("上传会话已被更新的会话取代");
      Object.assign(state.sessions.get(data.sessionId)!, { hash: contentHash, sha256, size: data.expectedSize, mtime: data.expectedMtime, ctime: data.expectedCtime });
      // Install the listener before sending to avoid losing an immediate reply.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        rejectReady = reject;
        state.ready.set(data.sessionId, { resolve, reject });
        pendingUploadPreparations.add(reject);
        timer = setTimeout(() => reject(new Error("上传会话准备超时")), 15000);
      });
      try {
        const send = plugin.websocket.SendMessage("FileUploadPrepare", {
          sessionId: data.sessionId, sha256, contentHash, size: content.byteLength, baseVersion: data.baseVersion ?? '', versionGuard: true,
          mtime: data.expectedMtime, ctime: data.expectedCtime, context: sourceContext,
        });
        await Promise.all([ready, send]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        pendingUploadPreparations.delete(rejectReady);
        state.ready.delete(data.sessionId);
      }
      if (state.latest.get(data.path) !== data.sessionId) throw new Error("上传会话已被更新的会话取代");
      state.retries.delete(data.path);
      logMemorySnapshot(`after upload hash ${data.path}`)
      // 将 hash 暂存到 pending map，等待服务端 FileUploadAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server FileUploadAck
      plugin.pendingUploadHashes.set(data.path, contentHash)
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes)
      // Do not change the synced base or cache before the server acknowledges.

      // 使用外层计算好的 actualTotalChunks

      // 断点续传：从 localStorage 读取上次中断的 checkpoint
      // Resume upload: read checkpoint from localStorage for the last interrupted upload
      let startChunkIndex = 0
      try {
        const cpRaw = plugin.app.loadLocalStorage(checkpointKey) as string | undefined;
        if (cpRaw) {
          const cp = JSON.parse(cpRaw) as { sessionId?: string; lastChunkIndex?: number; contentHash?: string; sha256?: string; baseVersion?: string; size?: number; mtime?: number; ctime?: number }
          if (cp.sessionId === data.sessionId &&
            cp.contentHash === contentHash &&
            cp.sha256 === sha256 && cp.baseVersion === (data.baseVersion ?? '') && cp.size === data.expectedSize && cp.mtime === data.expectedMtime && cp.ctime === data.expectedCtime &&
            typeof cp.lastChunkIndex === 'number' &&
            cp.lastChunkIndex >= 0 &&
            cp.lastChunkIndex < actualTotalChunks - 1) {
            startChunkIndex = cp.lastChunkIndex + 1
            dump(`Resume upload from chunk ${startChunkIndex}/${actualTotalChunks}: ${data.path}`)
          }
        }
      } catch (e) {
        dump(`Failed to read upload checkpoint for ${data.path}`, e)
      }

      // 如从断点恢复，则同步累加已上传计数以对齐进度
      if (startChunkIndex > 0) {
        plugin.uploadedChunksCount += startChunkIndex
      }

      // 打印上传信息表格
      dump([
        {
          操作: "文件上传",
          路径: data.path,
          文件大小: `${(content.byteLength / 1024 / 1024).toFixed(2)} MB`,
          分片大小: `${(chunkSize / 1024).toFixed(0)} KB`,
          分片数量: actualTotalChunks,
          SessionID: data.sessionId.substring(0, 8) + "...",
        },
      ])

      const sleepTime = Platform.isMobile ? 10 : 2;

      for (let i = startChunkIndex; i < actualTotalChunks; i++) {
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, content.byteLength)
        const length = end - start;

        // 使用 Uint8Array 视图代替 slice 拷贝，减少内存翻倍
        const chunk = new Uint8Array(content, start, length)

        const sessionIdBytes = new TextEncoder().encode(data.sessionId)
        const chunkIndexBytes = new Uint8Array(4)
        const view = new DataView(chunkIndexBytes.buffer)
        view.setUint32(0, i, false)

        const frame = new Uint8Array(36 + 4 + chunk.byteLength)
        frame.set(sessionIdBytes, 0)
        frame.set(chunkIndexBytes, 36)
        frame.set(chunk, 40)

        // 在 before 回调中检查是否已被取消,这样可以在数据真正进入 WebSocket 缓冲区之前拦截
        const sendResult = await plugin.websocket.SendBinary(
          frame,
          BINARY_PREFIX_FILE_SYNC,
          () => {
            // before: 检查是否已被取消(例如由于文件在上传过程中被删除)
            if (isPluginUnloading || activeUploadsMap.get(data.sessionId)?.cancelled || uploadState(plugin).latest.get(data.path) !== data.sessionId) {
              dump(`Upload aborted for ${data.path} (cancelled before send)`);
              return true; // 返回 true 表示应该取消发送
            }
            return false;
          },
          () => {
            // after: 发送成功后更新计数和日志
            plugin.uploadedChunksCount++
            const currentProgress = Math.floor(((i + 1) / actualTotalChunks) * 100);
            const isLastChunk = (i + 1) === actualTotalChunks;

            // 更新断点续传 checkpoint（发送成功后，非最后一块）
            // Update resume checkpoint after successful send (not the last chunk)
            if (!isLastChunk) {
              try {
                plugin.app.saveLocalStorage(checkpointKey, JSON.stringify({
                  sessionId: data.sessionId,
                  lastChunkIndex: i,
                  contentHash: contentHash,
                  sha256,
                  baseVersion: data.baseVersion ?? '',
                  size: data.expectedSize,
                  mtime: data.expectedMtime,
                  ctime: data.expectedCtime,
                  timestamp: Date.now(),
                }))
              } catch (e) {
                dump(`Failed to save upload checkpoint for ${data.path}`, e)
              }
            }

            // 更新日志进度
            SyncLogManager.getInstance().addOrUpdateLog({
              id: data.sessionId,
              type: 'send',
              action: 'FileUpload',
              path: data.path,
              traceId,
              vault: sourceVault,
              status: isLastChunk ? 'success' : 'pending',
              progress: currentProgress
            });
          }
        )

        // 连接不可用：分片未真正发出，立即中断循环，保留断点续传 checkpoint（不清除、不标记完成任务数），
        // 等重连后由后续同步轮次从 checkpoint 处续传，避免"分片假成功"（空转跑完循环但数据未真正传完）
        // Connection unavailable: the chunk was never actually sent. Break immediately and keep the
        // resume checkpoint intact (don't clear it, don't bump the completed counter) so the next
        // sync round can resume from the checkpoint after reconnect.
        if (sendResult === 'closed') {
          dump(`Upload interrupted for ${data.path} at chunk ${i}/${actualTotalChunks} (connection closed), will resume after reconnect`);
          SyncLogManager.getInstance().addOrUpdateLog({
            id: data.sessionId,
            type: 'send',
            action: 'FileUpload',
            path: data.path,
            traceId,
            vault: sourceVault,
            status: 'pending',
            message: '连接已断开，等待重连后续传'
          });
          plugin.concurrencyLimiter.releaseSlot(slotKey);
          finishUploadSession(uploadState(plugin), data.sessionId, data.path);
          sessionIdToPathMap.delete(data.sessionId);
          return;
        }

        // 如果被取消,立即退出循环并释放槽位
        if (sendResult === 'cancelled' || isPluginUnloading) {
          // 取消时清除 checkpoint，避免使用已失效的会话
          // Clear checkpoint on cancel to avoid stale session reuse
          clearUploadCheckpoint(plugin, checkpointKey, data.sessionId);
          finishUploadSession(uploadState(plugin), data.sessionId, data.path);
          sessionIdToPathMap.delete(data.sessionId);
          plugin.concurrencyLimiter.releaseSlot(slotKey)
          if (!activeUploadsMap.get(data.sessionId)?.reported) plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
          return;
        }

        // 让出主线程，手机端给更多呼吸时间
        await sleep(sleepTime)
      }

      // 手动置空辅助 GC
      content = null;

      // Local cloud-preview deletion is scheduled only after the matching Ack.
    } catch (e) {
      dump(`Upload process error for ${data.path}`, e);
      // Retain the latest marker while older sessions are outstanding.
      const state = uploadState(plugin);
      SyncLogManager.getInstance().addOrUpdateLog({ id: data.sessionId, type: 'send', action: 'FileUpload', path: data.path, traceId, vault: sourceVault, status: 'error', message: e instanceof Error ? e.message : String(e) });
      // 异常退出时清除 checkpoint，避免下次用无效的 sessionId 继续
      clearUploadCheckpoint(plugin, checkpointKey, data.sessionId);
      plugin.totalChunksToUpload -= actualTotalChunks
      plugin.concurrencyLimiter.releaseSlot(slotKey);
      plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
      sessionIdToPathMap.delete(data.sessionId);
      if (e instanceof Error && e.message.includes("文件在创建上传会话后发生变化") && ownsCurrentContext(plugin, sourceContext)) {
        const attempts = state.retries.get(data.path) ?? 0;
        if (attempts < 2 && state.latest.get(data.path) === data.sessionId) {
          state.retries.set(data.path, attempts + 1);
          if (state.retries.size > 1024) state.retries.delete(state.retries.keys().next().value!);
          plugin.fileHashManager.setFileHashes([[data.path, ""]], () => ({ mtime: -1, size: -1 }));
          void fileModify(file, plugin).catch(error => dump(`Failed to recheck upload ${data.path}`, error));
        }
      }
      finishUploadSession(state, data.sessionId, data.path);
    } finally {
      // 任务结束（完成或取消/失败），移除活跃标记
      activeUploadsMap.delete(data.sessionId);
    }
  }

  // 任务立即执行，受外部 ConcurrencyLimiter 控制
  void runUpload()
}

/**
 * 接收服务端文件更新通知 (FileSyncUpdate)
 */
export const receiveFileSyncUpdate = async function (data: ReceiveFileSyncUpdateMessage, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) return;
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return
  prunePendingFileRePush(plugin);
  if (!ownsCurrentContext(plugin, sourceContext)) return;
  const pendingKey = rePushKey(sourceContext, data.path, sourceVault);
  const deferred = pendingFileRePush.get(pendingKey);
  pendingFileRePush.delete(pendingKey);
  const completion = {
    context: sourceContext,
    traceId,
    vault: sourceVault,
    pageIndex: deferred?.[0]?.pageIndex ?? data.pageIndex,
    completionOwners: deferred ? [
      ...(data.pageIndex !== undefined ? [{ pageIndex: data.pageIndex, context: sourceContext }] : []),
      ...deferred,
    ] : undefined,
    completionState: { reported: false },
  };

  // 服务端推送说明该路径已有新内容，清除可能残留的 deleteAck pending 防止 Ack 删除新 hash
  // Server push means path has new content; clear stale deleteAck pending to protect newly-written hash
  plugin.pendingFileDeleteAcks.delete(data.path)
  if (isPathExcluded(data.path, plugin)) {
    reportFileCompletion(plugin, completion);
    return
  }
  if (isLargeBinarySyncRisk(data.size, plugin)) {
    dump(`Skip file download for large attachment (${describeBinarySyncLimit()} limit): ${data.path}`, data.size)
    notifyLargeFileSkipped(plugin, data.path, data.size, `Fast Note Sync skipped large file download: ${data.path}`)
    reportFileCompletion(plugin, completion);
    return
  }

  // 如果开启了云预览，且是初始化同步阶段，由于云预览可以按需加载，跳过所有附件下载
  if (plugin.localStorageManager.getMetadata("isInitSync") && plugin.settings.cloudPreviewEnabled) {
    if (plugin.settings.cloudPreviewTypeRestricted) {
      // 开启了类型限制：仅跳过受限类型 (图片、视频、音频、PDF)
      const ext = data.path.substring(data.path.lastIndexOf(".")).toLowerCase();
      if (FileCloudPreview.isRestrictedType(ext)) {
        dump(`Cloud Preview: Skipping restricted file download: ${data.path}`);
        reportFileCompletion(plugin, completion);
        return;
      }
    } else {
      // 未开启类型限制：由于启用了云预览，跳过所有附件下载
      dump(`Cloud Preview: Skipping all file downloads: ${data.path}`);
      reportFileCompletion(plugin, completion);
      return;
    }
  }

  // 等待并发槽位，防止大量并发下载导致内存耗尽
  const slotKey = `download_${data.path}`
  const tempKey = `temp_${data.path}`
  let tempSession: FileDownloadSession | undefined;

  try {
    await plugin.concurrencyLimiter.waitForSlot(slotKey, false, -10) // 优先级设为 -10，延后处理下载
    if (!ownsCurrentContext(plugin, sourceContext)) { plugin.concurrencyLimiter.releaseSlot(slotKey); return; }
    // 下载内存缓冲控制：如果当前内存中待写盘的分块过多，由于下载是异步触发的，此处等待
    while (currentDownloadBufferBytes > MAX_DOWNLOAD_BUFFER_BYTES) {
      await sleep(200);
    }
    if (!ownsCurrentContext(plugin, sourceContext)) { plugin.concurrencyLimiter.releaseSlot(slotKey); return; }

    dump(`Receive file sync update(download): `, data.path)
    tempSession = {
      ...completion,
      path: data.path,
      contentHash: data.contentHash,
      fileVersion: data.fileVersion,
      ctime: data.ctime,
      mtime: data.mtime,
      lastTime: data.lastTime,
      sessionId: "",
      totalChunks: 0,
      size: data.size,
      initialSlotKey: slotKey,
      ...createDownloadStorage(plugin, `init_${data.pathHash}`, data.size),
    }
    plugin.fileDownloadSessions.set(tempKey, tempSession)

    const requestData = {
      context: sourceContext,
      traceId,
      vault: plugin.settings.vault,
      path: data.path,
      pathHash: data.pathHash,
    }
    await plugin.websocket.SendMessage("FileChunkDownload", requestData)
    plugin.totalFilesToDownload++

    // 更新同步时间
    // Update sync time
    if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
      plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
    }
  } catch (e) {
    plugin.concurrencyLimiter.releaseSlot(slotKey)
    if (tempSession) await cleanupFileDownloadSession(plugin, tempSession, true);
    else reportFileCompletion(plugin, completion, true);
    SyncLogManager.getInstance().addLog('receive', 'FileDownload', formatDownloadError(e), 'error', data.path, sourceVault, { traceId });
  }
}

/**
 * 接收服务端文件删除通知
 */
export const receiveFileSyncDelete = async function (data: ReceivePathMessage, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) return;
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return
  prunePendingFileRePush(plugin);
  if (!ownsCurrentContext(plugin, sourceContext)) return;
  const pendingKey = rePushKey(sourceContext, data.path, sourceVault);
  const deferred = pendingFileRePush.get(pendingKey);
  pendingFileRePush.delete(pendingKey);
  const completion = {
    context: sourceContext, vault: sourceVault, pageIndex: deferred?.[0]?.pageIndex ?? data.pageIndex,
    completionOwners: deferred ? [
      ...(data.pageIndex !== undefined ? [{ pageIndex: data.pageIndex, context: sourceContext }] : []),
      ...deferred,
    ] : undefined,
    completionState: { reported: false },
  };

  if (isPathExcluded(data.path, plugin)) {
    reportFileCompletion(plugin, completion);
    return
  }

  if (plugin.localStorageManager.getMetadata("isInitSync") && plugin.settings.cloudPreviewEnabled) {
    if (plugin.settings.cloudPreviewTypeRestricted) {
      const ext = data.path.substring(data.path.lastIndexOf(".")).toLowerCase();
      if (FileCloudPreview.isRestrictedType(ext)) {
        dump(`Cloud Preview: Skipping restricted file delete: ${data.path}`);
        reportFileCompletion(plugin, completion);
        return;
      }
    } else {
      dump(`Cloud Preview: Skipping all file deletes: ${data.path}`);
      reportFileCompletion(plugin, completion);
      return;
    }
  }

  dump(`Receive file delete: `, data.path)
  const normalizedPath = normalizePath(data.path)

  let acquired = false;
  let reportedFailure = false;
  await plugin.lockManager.withLock(normalizedPath, async () => {
    acquired = true;
    if (plugin.settings.vault !== sourceVault || !ownsCurrentContext(plugin, sourceContext)) return;
    const file = plugin.app.vault.getFileByPath(normalizedPath)
    if (file instanceof TFile) {
      const base = getAttachmentBaseSha(plugin, normalizedPath, plugin.fileHashManager.getPathHash(normalizedPath), sourceVault);
      const version = getAttachmentBaseVersion(plugin, normalizedPath, plugin.fileHashManager.getPathHash(normalizedPath), sourceVault);
      let safe = false;
      try {
        if (base && version && validAttachmentVersion(data.previousVersion) && version === data.previousVersion && !getAttachmentConflict(plugin, normalizedPath, sourceVault)) {
          const snapshot = await withHashTimeout(signal => captureAttachmentSnapshot(plugin, file, signal));
          const current = plugin.app.vault.getFileByPath(normalizedPath);
          safe = snapshot.snapshotSha256 === base && current === file && current.stat.size === snapshot.size && current.stat.mtime === snapshot.mtime && getSafeCtime(current.stat) === snapshot.ctime && plugin.settings.vault === sourceVault && ownsCurrentContext(plugin, sourceContext) && getAttachmentBaseVersion(plugin, normalizedPath, plugin.fileHashManager.getPathHash(normalizedPath), sourceVault) === version;
        }
      } catch (error) { dump("Unable to verify attachment before remote deletion", error); }
      if (!safe) {
        try {
          if (!getAttachmentConflict(plugin, normalizedPath, sourceVault)?.mutation)
            setAttachmentDeletedConflict(plugin, normalizedPath, sourceVault);
        } catch (error) { dump("Unable to persist attachment conflict record", error); }
        SyncLogManager.getInstance().addLog('receive', 'FileConflict', '远端已删除附件，本地文件有修改或基准未知，已保留本地文件。', 'error', normalizedPath, sourceVault, { traceId });
        showSyncNotice(`附件冲突：远端已删除，已保留本地文件 ${normalizedPath}`, 10000);
        if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++;
        return;
      }
      plugin.addIgnoredFile(normalizedPath)
      // 记录待删除路径
      plugin.lastSyncPathDeleted.add(normalizedPath)
      try {
        await vaultDelete(plugin.app.vault, file)
        // 服务端推送删除,从哈希表中移除
        plugin.fileHashManager.removeFileHash(normalizedPath)
        plugin.lastSyncMtime.delete(normalizedPath)
        // 更新同步时间
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
          plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
        }
      } finally {
        // 延时 500ms 清理
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
          plugin.lastSyncPathDeleted.delete(normalizedPath)
        }, 500);
      }
    }
  }, { maxRetries: 5, retryInterval: 100 }).catch(e => {
    reportedFailure = true;
    dumpError(`[FastSync] Failed to receiveFileSyncDelete: ${normalizedPath}`, e);
    SyncLogManager.getInstance().addLog('receive', 'FileDelete', e instanceof Error ? e.message : String(e), 'error', data.path, sourceVault, { traceId });
    if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++
  });
  if (!acquired && !reportedFailure && ownsCurrentContext(plugin, sourceContext)) {
    plugin.fileSyncTasks.failed++;
    SyncLogManager.getInstance().addLog('receive', 'FileDelete', '附件删除等待锁超时，原文件已保留。', 'error', normalizedPath, sourceVault, { traceId });
  }
  reportFileCompletion(plugin, completion)
}

/**
 * 接收服务端文件元数据(mtime)更新通知
 */
export const receiveFileSyncMtime = async function (data: ReceiveMtimeMessage, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) return;
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return

  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
    return
  }

  if (plugin.localStorageManager.getMetadata("isInitSync") && plugin.settings.cloudPreviewEnabled) {
    if (plugin.settings.cloudPreviewTypeRestricted) {
      const ext = data.path.substring(data.path.lastIndexOf(".")).toLowerCase();
      if (FileCloudPreview.isRestrictedType(ext)) {
        dump(`Cloud Preview: Skipping restricted file mtime update: ${data.path}`);
        plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
        return;
      }
    } else {
      dump(`Cloud Preview: Skipping all file mtime updates: ${data.path}`);
      plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
      return;
    }
  }

  dump(`Receive file sync mtime: `, data.path, data.mtime)
  const normalizedPath = normalizePath(data.path)

  await plugin.lockManager.withLock(normalizedPath, async () => {
    const file = plugin.app.vault.getFileByPath(normalizedPath)
    if (file) {
      if (isLargeBinarySyncRisk(file.stat.size, plugin)) {
        dump(`Skip binary mtime rewrite for large attachment (${describeBinarySyncLimit()} limit): ${normalizedPath}`, file.stat.size)
        plugin.lastSyncMtime.set(data.path, data.mtime)
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
          plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
        }
        return
      }
      const content = await plugin.app.vault.readBinary(file)
      plugin.addIgnoredFile(normalizedPath)
      try {
        await plugin.app.vault.modifyBinary(file, content, { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) })
        // 记录 mtime
        plugin.lastSyncMtime.set(data.path, data.mtime)
        // 更新同步时间
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
          plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
        }
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }
    }
  }, { maxRetries: 5, retryInterval: 100 }).catch(e => {
    dumpError(`[FastSync] Failed to receiveFileSyncMtime: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FileMtime', traceId, sourceVault)) {
      SyncLogManager.getInstance().addLog('receive', 'FileMtime', e instanceof Error ? e.message : String(e), 'error', data.path, sourceVault, { traceId });
    }
    if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++
  });

  // FileSyncMtime 表示文件已在服务端存在（无需上传），释放 fileModify 中获取的并发槽位
  // FileSyncMtime indicates file already exists on server (no upload needed), release slot acquired by fileModify
  if (data.path) plugin.concurrencyLimiter.releaseSlot(data.path)
  plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
}

/**
 * 接收服务端分片下载响应 (FileSyncChunkDownload)
 */
export const receiveFileSyncChunkDownload = async function (data: FileSyncChunkDownloadMessage, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) return;
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return
  if (!ownsCurrentContext(plugin, sourceContext)) return;

  dump(`Receive file chunk download: `, data.path, data.sessionId, `totalChunks: ${data.totalChunks}`)

  // 打印下载信息 (Print download info)
  dump(
    "文件下载",
    {
      路径: data.path,
      文件大小: `${(data.size / 1024 / 1024).toFixed(2)} MB`,
      分片大小: `${(data.chunkSize / 1024).toFixed(0)} KB`,
      分片数量: data.totalChunks,
      SessionID: data.sessionId.substring(0, 8) + "...",
    }
  )

  const tempKey = `temp_${data.path}`
  const tempSession = plugin.fileDownloadSessions.get(tempKey)
  let session: FileDownloadSession

  if (tempSession && (tempSession.context === undefined || tempSession.context === sourceContext)) {
    session = {
      context: tempSession.context ?? sourceContext,
      traceId: tempSession.traceId || traceId,
      vault: tempSession.vault || sourceVault,
      completionOwners: tempSession.completionOwners,
      completionState: tempSession.completionState,
      path: data.path,
      contentHash: data.contentHash,
      fileVersion: data.fileVersion,
      ctime: data.ctime,
      mtime: data.mtime,
      lastTime: tempSession.lastTime,
      sessionId: data.sessionId,
      totalChunks: data.totalChunks,
      size: data.size,
      pageIndex: tempSession.pageIndex,
      initialSlotKey: tempSession.initialSlotKey,
      ...createDownloadStorage(plugin, data.sessionId, data.size),
    }
    plugin.fileDownloadSessions.set(data.sessionId, session)
    plugin.fileDownloadSessions.delete(tempKey)
  } else {
    session = {
      context: sourceContext,
      traceId,
      vault: sourceVault,
      completionState: { reported: false },
      path: data.path,
      contentHash: data.contentHash,
      fileVersion: data.fileVersion,
      ctime: data.ctime,
      mtime: data.mtime,
      lastTime: 0,
      sessionId: data.sessionId,
      totalChunks: data.totalChunks,
      size: data.size,
      initialSlotKey: `download_${data.path}`,
      ...createDownloadStorage(plugin, data.sessionId, data.size),
    }
    plugin.fileDownloadSessions.set(data.sessionId, session)
  }

  // 确保临时目录存在 (Ensure temp directory exists)
  // 并发下多个下载会话可能同时 mkdir 同一目录而抛错：catch 后复验是否已存在（并发创建属正常，吞掉）；
  // 真正未创建成功则不在此处兜底，交给首个分片写入时的既有失败路径处理（handleFileChunkDownload 的内存 fallback / failFileDownloadSession）
  if (data.totalChunks > 0 && session.tempDir) {
    const baseDir = getTempChunksDir(plugin)
    try {
      if (!(await plugin.app.vault.adapter.exists(baseDir))) {
        await plugin.app.vault.adapter.mkdir(baseDir)
      }
      if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
        await plugin.app.vault.adapter.mkdir(session.tempDir)
      }
    } catch (e) {
      if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
        dumpError(`Temp dir creation failed for session ${session.sessionId}, will retry on first chunk`, e)
      }
    }
  }

  // 仅在非同步期间(实时监听时)手动增加分片计数。同步期间由 SyncEnd 包装器统一预估
  if (!plugin.isSyncing) {
    plugin.totalChunksToDownload += data.totalChunks
  }

  // 创建初始日志记录
  const isTotalChunksZero = data.totalChunks === 0
  SyncLogManager.getInstance().addOrUpdateLog({
    id: data.sessionId,
    type: 'receive',
    action: 'FileDownload',
    path: data.path,
    traceId,
    vault: sourceVault,
    status: isTotalChunksZero ? 'success' : 'pending',
    progress: isTotalChunksZero ? 100 : 0
  });

  // 如果分片数为 0（空文件），立即触发完成逻辑1
  if (data.totalChunks === 0) {
    const finalSession = plugin.fileDownloadSessions.get(data.sessionId);
    if (finalSession) {
      await handleFileChunkDownloadComplete(finalSession, plugin);
    }
  }
}



/**
 * 接收文件同步结束通知
 */
export const receiveFileSyncEnd = async function (data: unknown, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  dump(`Receive file sync end:`, data)

  const syncData = data as SyncEndData
  // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
  plugin.fileSyncTasks.needUpload = syncData.needUploadCount || 0
  plugin.fileSyncTasks.needModify = syncData.needModifyCount || 0
  plugin.fileSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
  plugin.fileSyncTasks.needDelete = syncData.needDeleteCount || 0

  // 无条件更新 lastFileSyncTime，确保包含服务端本轮同步后的所有异步操作（如 SyncResourceFID）
  // Unconditionally update lastFileSyncTime to cover all async server-side ops after this sync round (e.g., SyncResourceFID)
  plugin.localStorageManager.setMetadata("lastFileSyncTime", syncData.lastTime)
  plugin.syncTypeCompleteCount++
}

/**
 * 检查并上传附件 (用于开启云预览后的首次同步后)
 */
export const checkAndUploadAttachments = async function (plugin: FastSync) {
  if (!plugin.settings.cloudPreviewEnabled || plugin.settings.readonlySyncEnabled) return;

  const apiService = new HttpApiService(plugin);
  const files = plugin.app.vault.getFiles();

  dump(`Cloud Preview: Start checking ${files.length} files for server status...`);

  let checkedCount = 0;
  let uploadCount = 0;

  for (const file of files) {
    if (file.extension === "md") continue;
    if (isPathExcluded(file.path, plugin)) continue;

    checkedCount++;
    try {
      const res = await apiService.getFileInfo(file.path);

      // 如果没有数据，说明服务端不存在
      if (!res) {
        dump(`Cloud Preview: File missing on server, starting upload: ${file.path}`);
        await fileModify(file, plugin, false);
        uploadCount++;
      }
    } catch (e) {
      dump(`Cloud Preview: Failed to check file status for ${file.path}`, e);
    }

    // 适当延迟，避免接口频率过高
    if (checkedCount % 10 === 0) {
      await sleep(50);
    }
  }

  dump(`Cloud Preview: Check complete. Total attachment files: ${checkedCount}, Uploaded: ${uploadCount}`);
}

/**
 * 处理接收到的二进制文件分片
 */
export const handleFileChunkDownload = async function (buf: ArrayBuffer | Blob, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false || isPluginUnloading) return

  const binaryData = buf instanceof Blob ? await buf.arrayBuffer() : buf
  if (binaryData.byteLength < 40 || isPluginUnloading) {
    dump(`File chunk download dropped: invalid payload length ${binaryData.byteLength}`)
    return
  }

  const sessionIdBytes = new Uint8Array(binaryData, 0, 36)
  const sessionId = new TextDecoder().decode(sessionIdBytes)
  const chunkIndexBytes = new Uint8Array(binaryData, 36, 4)
  const view = new DataView(chunkIndexBytes.buffer, chunkIndexBytes.byteOffset, 4)
  const chunkIndex = view.getUint32(0, false)
  const chunkData = binaryData.slice(40)

  const session = plugin.fileDownloadSessions.get(sessionId)
  if (!session) {
    const message = `File download chunk dropped: session not found (${sessionId}), chunk ${chunkIndex}`
    dumpError(message)
    SyncLogManager.getInstance().addOrUpdateLog({
      id: sessionId,
      type: 'receive',
      action: 'FileDownload',
      status: 'error',
      progress: 0,
      message
    });
    return
  }
  if (!ownsFileSession(plugin, session)) {
    await cleanupFileDownloadSession(plugin, session);
    plugin.concurrencyLimiter.releaseSlot(session.initialSlotKey || `download_${session.path}`);
    return;
  }

  try {
    if (chunkIndex >= session.totalChunks) {
      await failFileDownloadSession(plugin, session, `Invalid chunk index ${chunkIndex}, total chunks ${session.totalChunks}`)
      return
    }

    let isNewChunk = false

    if (session.tempDir) {
      try {
        if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
          const baseDir = getTempChunksDir(plugin)
          try {
            if (!(await plugin.app.vault.adapter.exists(baseDir))) {
              await plugin.app.vault.adapter.mkdir(baseDir)
            }
            await plugin.app.vault.adapter.mkdir(session.tempDir)
          } catch (mkdirErr) {
            // 并发下多个分片会话可能同时 mkdir 同一目录：复验已存在则吞掉；
            // 仍不存在说明是真实创建失败，交给外层 catch 走既有失败路径（内存 fallback / failFileDownloadSession）
            if (!(await plugin.app.vault.adapter.exists(session.tempDir))) {
              throw mkdirErr
            }
          }
        }
        const chunkPath = normalizePath(`${session.tempDir}/${chunkIndex}.bin`)
        isNewChunk = !session.downloadedChunks?.has(chunkIndex)
        await plugin.app.vault.adapter.writeBinary(chunkPath, chunkData)
        session.downloadedChunks?.add(chunkIndex)
      } catch (e) {
        if (session.size <= MAX_DOWNLOAD_BUFFER_BYTES) {
          dumpError(`File chunk temp write failed, fallback to memory: ${session.path} chunk ${chunkIndex}`, e)
          isNewChunk = await fallbackFileDownloadSessionToMemory(plugin, session, chunkIndex, chunkData)
        } else {
          await failFileDownloadSession(plugin, session, `Failed to write temp chunk ${chunkIndex}: ${formatDownloadError(e)}`)
          return
        }
      }
    } else {
      isNewChunk = storeMemoryChunk(session, chunkIndex, chunkData)
    }

    if (isNewChunk) {
      plugin.downloadedChunksCount++
    }

    // 更新日志进度
    const completedCount = getCompletedDownloadChunks(session)
    SyncLogManager.getInstance().addOrUpdateLog({
      id: sessionId,
      type: 'receive',
      action: 'FileDownload',
      path: session.path,
      traceId: session.traceId,
      vault: session.vault,
      status: completedCount === session.totalChunks ? 'success' : 'pending',
      progress: session.totalChunks === 0 ? 100 : Math.floor((completedCount / session.totalChunks) * 100)
    });


    if (completedCount === session.totalChunks) {
      await handleFileChunkDownloadComplete(session, plugin)
    }
  } catch (e) {
    await failFileDownloadSession(plugin, session, `Failed to receive chunk ${chunkIndex}: ${formatDownloadError(e)}`)
  }
}

/**
 * 接收服务端文件重命名通知
 */
export const receiveFileSyncRename = async function (data: { traceId?: string; context?: string; oldPath: string; path: string; mtime?: number; ctime?: number; contentHash?: string; previousVersion?: string; fileVersion?: string; lastTime?: number; size?: number; pathHash?: string; pageIndex?: number }, plugin: FastSync) {
  if (!plugin.syncState.attachmentConflictSupported) return;
  const sourceContext = data.context ?? plugin.syncState.activeSyncContext ?? "";
  const traceId = sourceTraceId(plugin, sourceContext, data.traceId);
  const sourceVault = plugin.settings.vault;
  if (plugin.settings.syncEnabled == false) return
  if (!plugin.syncState.attachmentRePushSafeSupported) {
    showSyncNotice("同步服务不支持安全处理附件重命名，请升级同步服务。", 6000);
    if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++;
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
    return;
  }
  prunePendingFileRePush(plugin);
  if (!ownsCurrentContext(plugin, sourceContext)) return;
  const owner = { context: sourceContext, vault: sourceVault, pageIndex: data.pageIndex, traceId };
  let deferredRePush = false;

    if (isPathExcluded(data.path, plugin) || isPathExcluded(data.oldPath, plugin)) {
    plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
    return
  }

  dump(`Receive file rename:`, data.oldPath, "->", data.path)

  const normalizedOldPath = normalizePath(data.oldPath)
  const normalizedNewPath = normalizePath(data.path)
  const protectTarget = () => {
    setAttachmentPendingConflict(plugin, normalizedNewPath, sourceVault);
    if (!getAttachmentConflict(plugin, normalizedNewPath, sourceVault))
      throw new Error("无法保存附件重命名冲突保护状态");
  };
  const requestRePush = async () => {
    if (plugin.settings.vault !== sourceVault || !ownsCurrentContext(plugin, sourceContext)) return;
    const pendingKey = rePushKey(sourceContext, data.path, sourceVault);
    const owners = pendingFileRePush.get(pendingKey) ?? [];
    deferredRePush = true;
    // A retransmitted page shares the original pending download.
    if (owners.some((pending) => pending.pageIndex === owner.pageIndex)) return;
    owners.push(owner);
    pendingFileRePush.set(pendingKey, owners);
    try {
      await plugin.websocket.SendMessage("FileRePush", {
        context: sourceContext, traceId, vault: sourceVault,
        path: data.path, pathHash: data.pathHash,
      });
    } catch (error) {
      const retained = (pendingFileRePush.get(pendingKey) ?? []).filter((pending) => pending !== owner);
      if (retained.length) pendingFileRePush.set(pendingKey, retained);
      else pendingFileRePush.delete(pendingKey);
      deferredRePush = false;
      throw error;
    }
  };

  // Check if there is an active file download session for this old path
  // 检查本地是否存在该旧路径的活跃下载会话
  let downloadingSession: FileDownloadSession | undefined
  for (const sess of plugin.fileDownloadSessions.values()) {
    if (normalizePath(sess.path) === normalizedNewPath && ownsCurrentContext(plugin, sess.context) &&
        sess.completionOwners?.some(existing => existing.context === owner.context && existing.pageIndex === owner.pageIndex)) {
      // A retransmitted rename for a download already redirected to its target.
      return;
    }
    if (normalizePath(sess.path) === normalizedOldPath && ownsCurrentContext(plugin, sess.context)) {
      downloadingSession = sess
      break
    }
  }

  if (downloadingSession) {
    if (!validAttachmentVersion(data.previousVersion) || downloadingSession.fileVersion !== data.previousVersion || !validAttachmentVersion(data.fileVersion)) {
      try {
        if (!getAttachmentConflict(plugin, normalizedOldPath, sourceVault)) setAttachmentMutationConflict(plugin, normalizedOldPath, 'rename', '', normalizedNewPath, sourceVault);
        await requestRePush();
      }
      catch (error) {
        dumpError(`Unable to fetch renamed attachment ${normalizedNewPath}`, error);
        if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++;
        plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
      }
      return;
    }
    if (plugin.app.vault.getFileByPath(normalizedNewPath)) {
      try { protectTarget(); }
      catch (error) {
        dumpError(`Unable to protect rename target ${normalizedNewPath}`, error);
        SyncLogManager.getInstance().addLog('receive', 'FileRename', '无法保护已有目标附件，请检查本地存储后重试。', 'error', normalizedNewPath, sourceVault, { traceId });
        if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++;
        plugin.recordSyncCompleted('file', data.pageIndex, sourceContext);
        return;
      }
    }
    dump(`Redirecting active file download session: ${downloadingSession.path} -> ${data.path}`)
    downloadingSession.path = data.path
    downloadingSession.fileVersion = data.fileVersion;
    if (data.contentHash) {
      downloadingSession.contentHash = data.contentHash
    }
    // Session redirected, bypass the rename execution and skip RePush
    // 会话已成功重定向，直接跳过重命名执行和 RePush
    downloadingSession.completionOwners ??= [{ context: downloadingSession.context ?? sourceContext, pageIndex: downloadingSession.pageIndex }];
    if (!downloadingSession.completionOwners.some(existing => existing.context === owner.context && existing.pageIndex === owner.pageIndex))
      downloadingSession.completionOwners.push(owner);
    return
  }

  let acquired = false;
  let reportedFailure = false;
  await plugin.lockManager.withLock(normalizedNewPath, async () => {
    acquired = true;
    if (plugin.settings.vault !== sourceVault || !ownsCurrentContext(plugin, sourceContext)) return;
    const file = plugin.app.vault.getFileByPath(normalizedOldPath)
    const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
    if (targetFile) {
      const oldHash = plugin.fileHashManager.getPathHash(normalizedOldPath);
      const oldVersion = getAttachmentBaseVersion(plugin, normalizedOldPath, oldHash, sourceVault);
      if (file instanceof TFile && (!oldVersion || !validAttachmentVersion(data.previousVersion) || oldVersion !== data.previousVersion || !validAttachmentVersion(data.fileVersion)) && !getAttachmentConflict(plugin, normalizedOldPath, sourceVault))
        setAttachmentMutationConflict(plugin, normalizedOldPath, 'rename', '', normalizedNewPath, sourceVault);
      // A matching sampled hash does not establish that this is the server's
      // file. Protect the occupied path until the actual bytes are checked.
      protectTarget();
      await requestRePush();
      return;
    }
    if (file instanceof TFile) {
      const oldHash = plugin.fileHashManager.getPathHash(normalizedOldPath);
      const oldBase = getAttachmentBaseSha(plugin, normalizedOldPath, oldHash, sourceVault);
      const oldVersion = getAttachmentBaseVersion(plugin, normalizedOldPath, oldHash, sourceVault);
      if (!oldBase || !oldVersion || !validAttachmentVersion(data.previousVersion) || oldVersion !== data.previousVersion || !validAttachmentVersion(data.fileVersion)) {
        if (!getAttachmentConflict(plugin, normalizedOldPath, sourceVault)) setAttachmentMutationConflict(plugin, normalizedOldPath, 'rename', '', normalizedNewPath, sourceVault);
        SyncLogManager.getInstance().addLog('receive', 'FileRename', '附件版本已变化或未知，已保留原路径并获取目标版本。', 'error', normalizedOldPath, sourceVault, { traceId });
        await requestRePush();
        return;
      }
      if (getAttachmentConflict(plugin, normalizedOldPath, sourceVault))
        protectTarget();
      plugin.addIgnoredFile(normalizedNewPath)
      plugin.addIgnoredFile(normalizedOldPath)

      // 记录新路径
      plugin.lastSyncPathRenamed.add(normalizedNewPath)

      try {
        await plugin.app.vault.rename(file, normalizedNewPath)
        plugin.fileHashManager.removeFileHash(normalizedOldPath)
        plugin.fileHashManager.removeFileHash(normalizedNewPath)
        if (oldHash && oldBase) {
          try {
            // The old confirmed bytes remain the base, even when local edits
            // have travelled with the rename. Never infer a base from the
            // server's sampled contentHash in the rename notification.
            setAttachmentBaseSha(plugin, normalizedNewPath, oldHash, oldBase, sourceVault, data.fileVersion);
            plugin.fileHashManager.setFileHash(normalizedNewPath, oldHash, -1, -1);
          } catch (error) { dump("Unable to persist renamed attachment baseline", error); }
        }
        await requestRePush();
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedNewPath)
          plugin.removeIgnoredFile(normalizedOldPath)
          plugin.lastSyncPathRenamed.delete(normalizedNewPath)
        }, 500);
      }
    } else {
      dump(`Local attachment not found for rename, requesting RePush: ${data.oldPath} -> ${data.path}`)
      await requestRePush();
    }
  }, { maxRetries: 10, retryInterval: 100 }).catch(e => {
    reportedFailure = true;
    dumpError(`[FastSync] Failed to receiveFileSyncRename: ${normalizedOldPath} -> ${normalizedNewPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'FileRename', traceId, sourceVault)) {
      SyncLogManager.getInstance().addLog('receive', 'FileRename', e instanceof Error ? e.message : String(e), 'error', data.path, sourceVault, { traceId });
    }
    if (ownsCurrentContext(plugin, sourceContext)) plugin.fileSyncTasks.failed++
  });

  if (!acquired && !reportedFailure && plugin.settings.vault === sourceVault && ownsCurrentContext(plugin, sourceContext)) {
    plugin.fileSyncTasks.failed++;
    SyncLogManager.getInstance().addLog('receive', 'FileRename', '附件重命名等待锁超时，原文件已保留。', 'error', normalizedNewPath, sourceVault, { traceId });
  }

  if (!deferredRePush && plugin.settings.vault === sourceVault) plugin.recordSyncCompleted('file', data.pageIndex, sourceContext)
}

/** Retry the protected target after a rename download could not be requested. */
export async function retryPendingAttachmentConflict(path: string, plugin: FastSync): Promise<boolean> {
  const normalized = normalizePath(path);
  if (!getAttachmentConflict(plugin, normalized)?.pending) return false;
  if (!plugin.syncState.attachmentConflictSupported || !plugin.syncState.attachmentRePushSafeSupported || !plugin.settings.syncEnabled)
    throw new Error("请先连接支持附件冲突保护的同步服务。");
  if (plugin.syncState.activeSyncContext)
    throw new Error("请等待当前同步完成后重试。");
  await plugin.websocket.SendMessage("FileRePush", { vault: plugin.settings.vault, path: normalized, pathHash: hashContent(normalized), context: "" });
  return true;
}

/** Retry a persisted mutation conflict by its original path, even if absent locally. */
export async function retryAttachmentMutationConflict(path: string, plugin: FastSync): Promise<void> {
  const normalized = normalizePath(path), vault = plugin.settings.vault, socket = plugin.websocket;
  const conflict = getAttachmentConflict(plugin, normalized, vault);
  if (!conflict?.mutation || !/^[a-f0-9]{64}$/.test(conflict.remoteSha256))
    throw new Error("没有可安全获取的远端版本，请根据同步日志人工检查。");
  if (!plugin.settings.syncEnabled || !plugin.syncState.attachmentRePushSafeSupported || !socket.isConnected() || !socket.isAuth)
    throw new Error("请先连接支持附件冲突保护的同步服务。");
  if (plugin.syncState.activeSyncContext || plugin.retryRecovery?.acceptsContext() === false)
    throw new Error("请等待当前同步或重试完成。");
  const connection = socket.count; let sent = false;
  const key = rePushKey('', normalized, vault);
  const owner: FileCompletionOwner = { context: '', vault, untracked: true };
  const owners = pendingFileRePush.get(key) ?? [];
  owners.push(owner); pendingFileRePush.set(key, owners);
  try {
    await socket.SendMessage('FileRePush', { vault, path: normalized, pathHash: hashContent(normalized), context: '' },
      () => {
        const current = getAttachmentConflict(plugin, normalized, vault);
        return plugin.settings.vault !== vault || plugin.websocket !== socket || socket.count !== connection || !socket.isConnected() || !socket.isAuth ||
          !!plugin.syncState.activeSyncContext || plugin.retryRecovery?.acceptsContext() === false ||
          current?.mutation !== conflict.mutation || current?.targetPath !== conflict.targetPath || current?.remoteSha256 !== conflict.remoteSha256 || current?.remoteVersion !== conflict.remoteVersion;
      },
      () => { sent = true; });
    if (!sent) throw new Error("连接或冲突状态已变化，请重新检查后重试。");
  } catch (error) {
    const remaining = (pendingFileRePush.get(key) ?? []).filter(item => item !== owner);
    if (remaining.length) pendingFileRePush.set(key, remaining); else pendingFileRePush.delete(key);
    throw error;
  }
}

/** Settle an outstanding rename page on a genuine re-push lookup failure. */
export function receiveFileRePushFailed(data: { path?: string; context?: string; traceId?: string }, plugin: FastSync): void {
  if (!data.path) return;
  const context = data.context ?? plugin.syncState.activeSyncContext ?? "";
  prunePendingFileRePush(plugin);
  if (!ownsCurrentContext(plugin, context)) return;
  const key = rePushKey(context, data.path, plugin.settings.vault);
  const owners = pendingFileRePush.get(key);
  pendingFileRePush.delete(key);
  if (owners?.some(owner => !owner.untracked)) {
    if (owners.some(owner => !owner.untracked && !owner.failureRecorded)) plugin.fileSyncTasks.failed++;
    reportFileCompletion(plugin, { context, pageIndex: owners[0].pageIndex, completionOwners: owners, completionState: { reported: false } });
  }
  SyncLogManager.getInstance().addLog('receive', 'FileRename', '无法查询远端附件，本地文件已保留，请稍后重试。', 'error', data.path, plugin.settings.vault, { traceId: data.traceId });
  showSyncNotice(`无法查询远端附件 ${data.path}，可使用“重试获取冲突附件的远端版本”。`, 10000);
}

type FileMutationMessage = { operation?: string; operationId?: string; path?: string; targetPath?: string; remoteSha256?: string; remoteVersion?: string; reason?: string; context?: string; pageIndex?: number; traceId?: string };

function mutationConflictReason(reason?: string): string {
  switch (reason) {
    case 'base_changed': return '远端版本已变化，删除或重命名未执行';
    case 'base_unknown': return '缺少已确认的版本基准，删除或重命名未执行';
    case 'invalid_base': return '附件版本基准无效，删除或重命名未执行';
    case 'path_mismatch': return '路径哈希对应了其他附件，操作未执行';
    case 'target_exists': return '远端重命名目标已存在，操作未执行';
    case 'remote_deleted': return '远端附件已不存在，操作未执行';
    default: return '附件删除或重命名未执行，请检查本地与服务端';
  }
}

function releaseMutationPending(data: FileMutationMessage, plugin: FastSync, path: string): boolean {
  if (data.pageIndex !== undefined) {
    if (data.operation !== 'delete') return false;
    plugin.pendingDeleteFilePaths?.delete(path);
    return true;
  }
  if (!data.operationId) return false;
  if (data.operation === 'delete') {
    const pending = plugin.syncState.pendingFileDeleteOperations.get(data.operationId);
    if (!pending || normalizePath(pending.path) !== path || pending.vault !== plugin.settings.vault) return false;
    plugin.syncState.pendingFileDeleteOperations.delete(data.operationId);
    if (![...plugin.syncState.pendingFileDeleteOperations.values()].some(item => item.path === pending.path && item.vault === pending.vault))
      plugin.pendingFileDeleteAcks.delete(pending.path);
    plugin.concurrencyLimiter.releaseSlot(pending.slotKey);
    return true;
  }
  if (data.operation === 'rename' && data.targetPath) {
    const target = normalizePath(data.targetPath);
    const index = plugin.pendingFileRenames.findIndex(item => item.operationId === data.operationId && normalizePath(item.oldPath) === path && normalizePath(item.newPath) === target && item.vault === plugin.settings.vault);
    if (index < 0) return false;
    const [pending] = plugin.pendingFileRenames.splice(index, 1);
    plugin.concurrencyLimiter.releaseSlot(pending.slotKey);
    return true;
  }
  return false;
}

export function receiveFileMutationFailed(data: FileMutationMessage, plugin: FastSync): void {
  if (!data.path) return;
  const context = data.context ?? plugin.syncState.activeSyncContext ?? "";
  if (data.pageIndex !== undefined && !ownsCurrentContext(plugin, context)) return;
  const path = normalizePath(data.path);
  if (!firstMutationPageMessage(plugin, context, data.pageIndex, path)) return;
  if (!releaseMutationPending(data, plugin, path)) return;
  if (data.pageIndex !== undefined) plugin.fileSyncTasks.failed++;
  SyncLogManager.getInstance().addLog('receive', 'FileMutationFailed', '服务端未能完成附件操作，请检查服务端日志及文件后重试。', 'error', path, plugin.settings.vault, { traceId: data.traceId });
  showSyncNotice(`附件操作失败，请检查服务端日志及文件：${path}`, 10000);
  if (data.pageIndex !== undefined) plugin.recordSyncCompleted('file', data.pageIndex, context);
}

export async function receiveFileMutationConflict(data: FileMutationMessage, plugin: FastSync): Promise<void> {
  if (!data.path || (data.operation !== 'delete' && data.operation !== 'rename')) return;
  const context = data.pageIndex === undefined ? (plugin.syncState.activeSyncContext ?? "") : (data.context ?? plugin.syncState.activeSyncContext ?? "");
  const vault = plugin.settings.vault;
  if (data.pageIndex !== undefined && !ownsCurrentContext(plugin, context)) return;
  const path = normalizePath(data.path);
  if (!firstMutationPageMessage(plugin, context, data.pageIndex, path)) return;
  if (!releaseMutationPending(data, plugin, path)) return;
  if (data.pageIndex !== undefined) plugin.fileSyncTasks.failed++;
  try {
    const safeRemote = data.reason === 'base_changed' || data.reason === 'base_unknown' ? (data.remoteSha256 ?? "") : "";
    setAttachmentMutationConflict(plugin, path, data.operation, safeRemote, data.targetPath, vault, data.remoteVersion);
    if (!getAttachmentConflict(plugin, path, vault)?.mutation) throw new Error("无法保存冲突状态");
  } catch (error) {
    dumpError(`Unable to persist attachment mutation conflict: ${path}`, error);
    SyncLogManager.getInstance().addLog('receive', 'FileMutationConflict', '无法保存附件冲突状态；服务端原文件已保留，请检查本地存储。', 'error', path, vault, { traceId: data.traceId });
    if (data.pageIndex !== undefined) plugin.recordSyncCompleted('file', data.pageIndex, context);
    return;
  }
  const reason = mutationConflictReason(data.reason);
  SyncLogManager.getInstance().addLog('receive', 'FileMutationConflict', `${reason}：${path}`, 'error', path, vault, { traceId: data.traceId });
  if ((data.reason !== 'base_changed' && data.reason !== 'base_unknown') || !/^[a-f0-9]{64}$/.test(data.remoteSha256 ?? "")) {
    showSyncNotice(`${reason}，请人工检查：${path}`, 10000);
    if (data.pageIndex !== undefined) plugin.recordSyncCompleted('file', data.pageIndex, context);
    return;
  }
  if (data.pageIndex === undefined && plugin.retryRecovery?.acceptsContext() === false) {
    const socket = plugin.websocket, connection = socket.count;
    const conflictMatches = () => {
      const current = getAttachmentConflict(plugin, path, vault);
      return !!current && current.mutation === data.operation && current.targetPath === data.targetPath && current.remoteSha256 === data.remoteSha256 && current.remoteVersion === data.remoteVersion;
    };
    showSyncNotice(`${reason}，同步恢复后将获取远端版本：${path}`, 10000);
    const discarded = () => showSyncNotice(`附件冲突仍保留：${path}。请切回原仓库并使用“重试获取冲突附件的远端版本”。`, 10000);
    plugin.retryRecovery.whenContextAccepted(() => {
      if (plugin.settings.vault !== vault || plugin.websocket !== socket || socket.count !== connection || !socket.isConnected() || !socket.isAuth ||
          !conflictMatches()) {
        discarded();
        return;
      }
      void requestMutationRePush(data, plugin, path, vault, plugin.syncState.activeSyncContext ?? "", () => plugin.websocket === socket && socket.count === connection && socket.isConnected() && socket.isAuth && conflictMatches());
    }, discarded);
    return;
  }
  showSyncNotice(`${reason}，正在获取远端版本：${path}`, 10000);
  await requestMutationRePush(data, plugin, path, vault, context);
}

async function requestMutationRePush(data: FileMutationMessage, plugin: FastSync, path: string, vault: string, context: string, stillValid?: () => boolean): Promise<void> {
  // The conflict page is not complete until the retained server version has
  // been downloaded or its failure settled. An unpaged direct event is marked
  // untracked so it cannot accidentally ACK a concurrently active page.
  const key = rePushKey(context, path, vault);
  const owners = pendingFileRePush.get(key) ?? [];
  const owner: FileCompletionOwner = { context, vault, pageIndex: data.pageIndex, traceId: data.traceId, untracked: data.pageIndex === undefined, failureRecorded: data.pageIndex !== undefined };
  owners.push(owner);
  pendingFileRePush.set(key, owners);
  try {
    if (!plugin.syncState.attachmentRePushSafeSupported) throw new Error("同步服务不支持安全重推");
    let sent = false;
    await plugin.websocket.SendMessage('FileRePush', { vault, path, pathHash: hashContent(path), context, traceId: data.traceId },
      () => {
        const current = getAttachmentConflict(plugin, path, vault);
        return plugin.settings.vault !== vault || !ownsCurrentContext(plugin, context) || plugin.retryRecovery?.acceptsContext() === false || stillValid?.() === false ||
          current?.mutation !== data.operation || current?.targetPath !== data.targetPath || current?.remoteSha256 !== data.remoteSha256 || current?.remoteVersion !== data.remoteVersion;
      }, () => { sent = true; });
    if (!sent) throw new Error("连接不可用");
  } catch (error) {
    const remaining = (pendingFileRePush.get(key) ?? []).filter(item => item !== owner);
    if (remaining.length) pendingFileRePush.set(key, remaining); else pendingFileRePush.delete(key);
    dumpError(`Unable to request retained attachment: ${path}`, error);
    if (data.pageIndex === undefined) showSyncNotice(`未能获取冲突附件 ${path}，请使用“重试获取冲突附件的远端版本”。`, 10000);
    if (data.pageIndex !== undefined && plugin.settings.vault === vault && ownsCurrentContext(plugin, context))
      plugin.recordSyncCompleted('file', data.pageIndex, context);
  }
}

/**
 * 完成文件下载
 */
const handleFileChunkDownloadComplete = async function (session: FileDownloadSession, plugin: FastSync) {
  const slotKey = session.initialSlotKey || `download_${session.path}`;
  try {
    if (!ownsFileSession(plugin, session)) { await cleanupFileDownloadSession(plugin, session); return; }
    if (isLargeBinarySyncRisk(session.size, plugin)) {
      dump(`Skip assembling large downloaded attachment (${describeBinarySyncLimit()} limit): ${session.path}`, session.size)
      await cleanupFileDownloadSession(plugin, session)
      return
    }
    // 逐片读入后立即写入目标缓冲区并释放分片引用，避免 chunks 数组与整份 buffer 同时驻留内存 (2x 峰值)
    // Write each chunk into the target buffer as it is read, then drop the reference immediately,
    // instead of accumulating a chunks array alongside the full assembled buffer (avoids the 2x peak).
    const completeFile = new Uint8Array(session.size)
    let offset = 0
    for (let i = 0; i < session.totalChunks; i++) {
      let chunk: ArrayBuffer | undefined;
      if (session.tempDir) {
        const chunkPath = normalizePath(`${session.tempDir}/${i}.bin`)
        if (await plugin.app.vault.adapter.exists(chunkPath)) {
          chunk = await plugin.app.vault.adapter.readBinary(chunkPath)
        }
      } else {
        chunk = session.chunks?.get(i)
      }

      if (!chunk) {
        await failFileDownloadSession(plugin, session, `Missing downloaded chunk ${i}`, false)
        return
      }
      if (offset + chunk.byteLength > completeFile.byteLength) {
        await failFileDownloadSession(plugin, session, `Downloaded file size mismatch: exceeds expected ${session.size}`, false)
        return
      }
      completeFile.set(new Uint8Array(chunk), offset)
      offset += chunk.byteLength
    }

    if (offset !== session.size) {
      await failFileDownloadSession(plugin, session, `Downloaded file size mismatch: got ${offset}, expected ${session.size}`, false)
      return
    }

    const normalizedPath = normalizePath(session.path)
    let acquired = false;
    await plugin.lockManager.withLock(normalizedPath, async () => {
      acquired = true;
      if (!ownsFileSession(plugin, session)) return;
      plugin.addIgnoredFile(normalizedPath)
      try {
        const file = plugin.app.vault.getFileByPath(normalizedPath)
        if (file) {
          // A download can arrive after local edits or a check from another
          // device. Never replace local bytes whose confirmed base is unknown
          // or no longer matches. Preserve the incoming bytes as a visible copy.
          const remoteSha = await sha256Bytes(completeFile.buffer);
          const before = { size: file.stat.size, mtime: file.stat.mtime, ctime: file.stat.ctime };
          const local = await plugin.app.vault.readBinary(file);
          const localSha = await sha256Bytes(local);
          if (!ownsFileSession(plugin, session)) return;
          const current = plugin.app.vault.getFileByPath(normalizedPath);
          const changedDuringRead = current !== file || file.stat.size !== before.size || file.stat.mtime !== before.mtime || file.stat.ctime !== before.ctime || local.byteLength !== before.size;
          const baseHash = plugin.fileHashManager.getPathHash(normalizedPath);
          const baseSha = getAttachmentBaseSha(plugin, normalizedPath, baseHash, session.vault ?? plugin.settings.vault);
          const vaultName = session.vault ?? plugin.settings.vault;
          const existingConflict = getAttachmentConflict(plugin, normalizedPath, vaultName);
          if (changedDuringRead || (localSha !== remoteSha && (existingConflict || !baseSha || localSha !== baseSha))) {
            let copy: string | undefined;
            if (existingConflict?.remoteSha256 === remoteSha && existingConflict.copyPath) {
              const existing = plugin.app.vault.getFileByPath(normalizePath(existingConflict.copyPath));
              if (existing && await sha256Bytes(await plugin.app.vault.readBinary(existing)) === remoteSha) copy = existingConflict.copyPath;
            }
            if (!ownsFileSession(plugin, session)) return;
            copy ??= await saveAttachmentConflictCopy(plugin.app.vault, normalizedPath, completeFile.buffer, generateUUID);
            try { setAttachmentConflict(plugin, normalizedPath, remoteSha, copy, vaultName, undefined, session.fileVersion); }
            catch (error) { dump("Unable to persist attachment conflict record", error); }
            SyncLogManager.getInstance().addLog('receive', 'FileConflict', `附件存在本地修改，远端版本已保存至 ${copy}`, 'error', normalizedPath, session.vault ?? plugin.settings.vault, { traceId: session.traceId });
            showSyncNotice(`附件冲突：远端版本已保存至 ${copy}`, 10000);
            if (ownsCurrentContext(plugin, session.context) &&
                (!session.completionOwners?.length || session.completionOwners.some(owner => !owner.untracked && !owner.failureRecorded)))
              plugin.fileSyncTasks.failed++;
            return;
          }
          if (localSha !== remoteSha)
            await plugin.app.vault.modifyBinary(file, completeFile.buffer, { ...(session.ctime > 0 && { ctime: session.ctime }), ...(session.mtime > 0 && { mtime: session.mtime }) })
        } else {
          const folder = normalizedPath.split("/").slice(0, -1).join("/")
          if (folder != "") {
            const dirExists = plugin.app.vault.getFolderByPath(folder)
            if (dirExists == null) {
              try {
                await plugin.app.vault.createFolder(folder)
              } catch (e) {
                // 并发竞争时只有一个调用成功，另一方忽略"已存在"错误
                // In concurrent race only one call succeeds; ignore "already exists" error
                if (!plugin.app.vault.getFolderByPath(folder)) throw e
              }
            }
          }
          if (!ownsFileSession(plugin, session)) return;
          await plugin.app.vault.createBinary(normalizedPath, completeFile.buffer, { ...(session.ctime > 0 && { ctime: session.ctime }), ...(session.mtime > 0 && { mtime: session.mtime }) })
        }
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }

      if (!ownsFileSession(plugin, session)) return;

      if (Number(plugin.localStorageManager.getMetadata("lastFileSyncTime")) < session.lastTime) {
        plugin.localStorageManager.setMetadata("lastFileSyncTime", session.lastTime)
      }

      // 下载完成后自动计算哈希并更新缓存 (如果服务器传了内容哈希就直接使用，否则重新计算以兼容旧版本)
      let contentHash = session.contentHash
      if (!contentHash) {
        contentHash = await hashArrayBuffer(completeFile.buffer)
        dump(`Download complete: server missing hash, local calculated: ${session.path}`, contentHash)
      } else {
        dump(`Download complete: using server provided hash: ${session.path}`, contentHash)
      }
      try {
        const confirmedSha = await sha256Bytes(completeFile.buffer);
        if (!ownsFileSession(plugin, session)) return;
        const vault = session.vault ?? plugin.settings.vault;
        setAttachmentBaseSha(plugin, session.path, contentHash, confirmedSha, vault, session.fileVersion);
        plugin.fileHashManager.setFileHash(session.path, contentHash, session.mtime, session.size);
        const conflict = getAttachmentConflict(plugin, session.path, vault);
        if (conflict?.mutation) setAttachmentMutationConflict(plugin, session.path, conflict.mutation, confirmedSha, conflict.targetPath, vault, session.fileVersion);
        clearAttachmentPendingConflict(plugin, session.path, vault);
      } catch (error) { dump("Unable to persist confirmed attachment baseline", error); }
      // 记录同步后的 mtime
      plugin.lastSyncMtime.set(session.path, session.mtime)
      dump(`Download complete and hash updated for: ${session.path}`, contentHash)
    }, { maxRetries: 5, retryInterval: 100 });

    if (!acquired && ownsFileSession(plugin, session)) {
      await failFileDownloadSession(plugin, session, "Attachment write lock timed out", false);
      return;
    }

    // 释放内存计数
    releaseSessionMemory(session)

    plugin.fileDownloadSessions.delete(session.sessionId)
    if (session.tempDir) await clearTempChunksDir(plugin, session.sessionId)
    if (ownsFileSession(plugin, session)) {
      plugin.downloadedFilesCount++
      plugin.progressTracker.recordDownloadComplete('file');
    }
    reportFileCompletion(plugin, session)
  } catch (e) {
    dumpError(`Error completing file download for ${session.path}`, e)
    if (!checkAndNotifyCaseConflict(e, session.path, plugin, 'FileDownload', session.traceId, session.vault)) {
      SyncLogManager.getInstance().addOrUpdateLog({
        id: session.sessionId,
        type: 'receive',
        action: 'FileDownload',
        path: session.path,
        traceId: session.traceId,
        vault: session.vault,
        status: 'error',
        progress: session.totalChunks === 0 ? 0 : Math.floor((getCompletedDownloadChunks(session) / session.totalChunks) * 100),
        message: `Failed to complete download: ${formatDownloadError(e)}`
      });
    }
    await cleanupFileDownloadSession(plugin, session, true)
  } finally {
    plugin.concurrencyLimiter.releaseSlot(slotKey)
  }
}

/** Explicitly keep a fetched server version and abandon the old mutation. */
export async function acceptAttachmentMutationRemote(file: TFile, plugin: FastSync): Promise<void> {
  const path = normalizePath(file.path), vault = plugin.settings.vault;
  const initial = getAttachmentConflict(plugin, path, vault);
  if (!initial?.mutation || !/^[a-f0-9]{64}$/.test(initial.remoteSha256) || !validAttachmentVersion(initial.remoteVersion))
    throw new Error("尚未取得可验证的远端版本，请先重试同步。");
  let accepted = false;
  await plugin.lockManager.withLock(path, async () => {
    if (plugin.settings.vault !== vault || plugin.app.vault.getFileByPath(path) !== file)
      throw new Error("仓库或附件已变化，请重新确认。");
    const snapshot = await withHashTimeout(signal => captureAttachmentSnapshot(plugin, file, signal));
    const current = plugin.app.vault.getFileByPath(path);
    const latest = getAttachmentConflict(plugin, path, vault);
    if (plugin.settings.vault !== vault || current !== file || !latest?.mutation || latest.remoteSha256 !== initial.remoteSha256 || latest.remoteVersion !== initial.remoteVersion ||
        snapshot.snapshotSha256 !== initial.remoteSha256 || current.stat.size !== snapshot.size || current.stat.mtime !== snapshot.mtime || getSafeCtime(current.stat) !== snapshot.ctime)
      throw new Error("当前附件与保留的远端版本不一致，请先比较冲突副本。");
    setAttachmentBaseSha(plugin, path, snapshot.contentHash, snapshot.snapshotSha256, vault, initial.remoteVersion);
    plugin.fileHashManager.setFileHash(path, snapshot.contentHash, -1, -1);
    clearAttachmentMutationConflict(plugin, path, vault);
    accepted = true;
  }, { maxRetries: 5, retryInterval: 50 });
  if (!accepted) throw new Error("附件正忙，请稍后重试。");
}

// 收到 FileRenameAck，服务端确认后更新 hashManager（FIFO 出队）并更新 lastFileSyncTime
// Receive FileRenameAck, update hashManager after server confirmation (FIFO dequeue) and update lastFileSyncTime
export const receiveFileRenameAck = function (data: { lastTime?: number; path?: string; operationId?: string; fileVersion?: string }, plugin: FastSync) {
  // Match by destination: another device's late or out-of-order response must
  // never acknowledge a different pending rename.
  const index = data.path && data.operationId ? plugin.pendingFileRenames.findIndex(item => item.operationId === data.operationId && item.newPath === data.path && item.vault === plugin.settings.vault) : -1;
  if (index < 0) return;
  const [pending] = plugin.pendingFileRenames.splice(index, 1);
  if (pending) {
    // The ACK confirms the old baseline moved to the new path; it does not
    // confirm any local edit made after the rename request.
    const newer = plugin.pendingUploadHashes.has(pending.newPath) || plugin.pendingFileRenames.some(item => item.oldPath === pending.newPath || item.newPath === pending.newPath) || [...plugin.syncState.pendingFileDeleteOperations.values()].some(item => item.path === pending.newPath && item.vault === plugin.settings.vault);
    if (!newer && plugin.app.vault.getFileByPath(normalizePath(pending.newPath))) {
      plugin.fileHashManager.setFileHash(pending.newPath, pending.contentHash, -1, -1)
      if (pending.baseSha256) {
        try { setAttachmentBaseSha(plugin, pending.newPath, pending.contentHash, pending.baseSha256, pending.vault, data.fileVersion); }
        catch (error) { dump("Unable to persist renamed attachment baseline", error); }
      }
    }
    const oldInUse = plugin.pendingUploadHashes.has(pending.oldPath) || plugin.pendingFileRenames.some(item => item.oldPath === pending.oldPath || item.newPath === pending.oldPath) || [...plugin.syncState.pendingFileDeleteOperations.values()].some(item => item.path === pending.oldPath && item.vault === plugin.settings.vault);
    if (!oldInUse && !plugin.app.vault.getFileByPath(normalizePath(pending.oldPath))) plugin.fileHashManager.removeFileHash(pending.oldPath)
  }
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
    dump(`FileRenameAck: lastFileSyncTime updated to`, data.lastTime)
  }
  plugin.concurrencyLimiter.releaseSlot(pending.slotKey)
}

async function autoDeleteAcknowledgedUpload(plugin: FastSync, session: UploadSession): Promise<void> {
  if (!plugin.settings.cloudPreviewEnabled || !plugin.settings.cloudPreviewAutoDeleteLocal || !session.sha256) return;
  const ext = session.path.substring(session.path.lastIndexOf(".")).toLowerCase();
  if (plugin.settings.cloudPreviewTypeRestricted && !FileCloudPreview.isRestrictedType(ext)) return;
  await sleep(2000);
  if (isPluginUnloading || plugin.settings.vault !== session.vault) return;
  try {
    await plugin.lockManager.withLock(session.path, async () => {
      if (uploadState(plugin).latest.has(session.path) || plugin.pendingFileDeleteAcks.has(session.path)) return;
      const file = plugin.app.vault.getFileByPath(normalizePath(session.path));
      if (!file) return;
      const serverInfo = await new HttpApiService(plugin).getFileInfo(session.path);
      if (!serverInfo || serverInfo.path !== session.path || serverInfo.size !== session.size || serverInfo.mtime !== session.mtime) return;
      const snapshot = await withHashTimeout(signal => captureAttachmentSnapshot(plugin, file, signal));
      if (snapshot.snapshotSha256 !== session.sha256 || snapshot.size !== session.size || snapshot.mtime !== session.mtime || snapshot.ctime !== session.ctime) return;
      // Recheck immediately before deletion; the filesystem has no atomic
      // compare-and-delete operation for changes made outside Obsidian.
      const current = plugin.app.vault.getFileByPath(normalizePath(session.path));
      if (current !== file || current.stat.size !== snapshot.size || current.stat.mtime !== snapshot.mtime || getSafeCtime(current.stat) !== snapshot.ctime || uploadState(plugin).latest.has(session.path)) return;
      plugin.addIgnoredFile(session.path);
      try {
        await vaultDelete(plugin.app.vault, file);
        plugin.fileHashManager.removeFileHash(session.path);
      } finally {
        plugin.removeIgnoredFile(session.path);
      }
    }, { maxRetries: 5, retryInterval: 50 });
  } catch (error) {
    dump(`Cloud Preview: Auto delete failed for ${session.path}`, error);
  }
}

// 收到 FileUploadAck，将 pending hash 转移到正式 hashManager 并更新 lastFileSyncTime
// Receive FileUploadAck, move pending hash to formal hashManager and update lastFileSyncTime
export const receiveFileUploadAck = function (data: { traceId?: string; context?: string; lastTime?: number; path?: string; pathHash?: string; sessionId?: string; contentHash?: string; fileVersion?: string }, plugin: FastSync) {
  const state = uploadState(plugin);
  const session = data.sessionId ? state.sessions.get(data.sessionId) : undefined;
  if (!session || data.path !== session.path || data.pathHash !== session.pathHash || data.contentHash !== session.hash) {
    dump(`Ignoring unmatched FileUploadAck: ${data.path ?? ""}`);
    return;
  }
  // Compute ownership before removing the session; older acknowledgements are
  // never allowed to advance the newest path's baseline.
  const isLatest = state.latest.get(session.path) === data.sessionId;
  finishUploadSession(state, data.sessionId!, session.path);
  sessionIdToPathMap.delete(data.sessionId!);
  if (isLatest) {
    // A late ack must not recreate a baseline for a file deleted or renamed
    // while the server was processing its final chunk.
    if (plugin.app.vault.getFileByPath(normalizePath(session.path)) && !plugin.pendingFileDeleteAcks?.has(session.path)) {
      if (session.sha256) try {
        setAttachmentBaseSha(plugin, session.path, session.hash, session.sha256, session.vault, data.fileVersion);
        plugin.fileHashManager.setFileHash(session.path, session.hash, -1, -1);
        finishAttachmentResolution(plugin, session.path, session.sha256, session.vault);
      }
      catch (error) { dump("Unable to persist confirmed attachment baseline", error); }
    }
    if (plugin.pendingUploadHashes.get(session.path) === session.hash) {
      plugin.pendingUploadHashes.delete(session.path);
      plugin.localStorageManager.savePending('pendingUploadHashes', plugin.pendingUploadHashes);
    }
    if (validAttachmentVersion(data.fileVersion)) void autoDeleteAcknowledgedUpload(plugin, session);
  }
  // Never clear a checkpoint written by another session for this path.
  const vaultName = plugin.app.vault.getName();
  const checkpointKey = `fns-${vaultName}-uploadSession-${session.pathHash}`;
  clearUploadCheckpoint(plugin, checkpointKey, data.sessionId!);
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
    dump(`FileUploadAck: lastFileSyncTime updated to`, data.lastTime)
  }
  plugin.concurrencyLimiter.releaseSlot(session.slotKey);
  plugin.recordSyncCompleted('file', session.pageIndex, session.context)
}

// 收到 FileDeleteAck，仅当路径仍在 pending set 中时才从 hashManager 移除
// Receive FileDeleteAck; only remove from hashManager if path is still pending
export const receiveFileDeleteAck = function (data: { lastTime?: number; path?: string; operationId?: string; pageIndex?: number; context?: string }, plugin: FastSync) {
  const context = data.context ?? plugin.syncState.activeSyncContext ?? "";
  if (!data.path || (data.pageIndex !== undefined && !ownsCurrentContext(plugin, context)) || !firstMutationPageMessage(plugin, context, data.pageIndex, data.path)) return;
  let accepted = false;
  if (data.pageIndex !== undefined) {
    accepted = plugin.pendingDeleteFilePaths?.delete(data.path) ?? false;
  } else if (data.operationId) {
    const pending = plugin.syncState.pendingFileDeleteOperations.get(data.operationId);
    if (!pending || pending.path !== data.path || pending.vault !== plugin.settings.vault) return;
    plugin.syncState.pendingFileDeleteOperations.delete(data.operationId);
    plugin.concurrencyLimiter.releaseSlot(pending.slotKey);
    if (![...plugin.syncState.pendingFileDeleteOperations.values()].some(item => item.path === data.path && item.vault === pending.vault))
      plugin.pendingFileDeleteAcks.delete(data.path);
    accepted = true;
  }
  if (accepted) {
    // A recreated local file represents a later edit, not the deleted version.
    const newer = plugin.pendingUploadHashes.has(data.path) || plugin.pendingFileRenames.some(item => item.oldPath === data.path || item.newPath === data.path) || [...plugin.syncState.pendingFileDeleteOperations.values()].some(item => item.path === data.path && item.vault === plugin.settings.vault);
    if (!newer && !plugin.app.vault.getFileByPath(normalizePath(data.path))) plugin.fileHashManager.removeFileHash(data.path)
  }
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastFileSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastFileSyncTime", data.lastTime)
  }
  if (data.pageIndex !== undefined) plugin.recordSyncCompleted('file', data.pageIndex, context);
}

/**
 * 收到服务端 463 错误（上传附件会话不存在），清理该文件的活跃上传状态并增加完成计数
 */
export const receiveFileUploadSessionNotFound = function (sessionId: string, plugin: FastSync) {
  const waiting = uploadState(plugin).ready.get(sessionId);
  if (waiting) { waiting.reject(new Error("上传会话不存在")); return; }
  const path = sessionIdToPathMap.get(sessionId)
  if (path) {
    const active = activeUploadsMap.get(sessionId)
    if (active) {
      active.cancelled = true
    }
    const state = uploadState(plugin);
    const session = state.sessions.get(sessionId);
    if (session) plugin.concurrencyLimiter.releaseSlot(session.slotKey)
    finishUploadSession(state, sessionId, path);
    sessionIdToPathMap.delete(sessionId);
    if (session && ownsCurrentContext(plugin, session.context)) {
      if (active) active.reported = true;
      plugin.fileSyncTasks.failed++
      plugin.recordSyncCompleted('file', session.pageIndex, session.context)
    }
    dump(`FileUploadSessionNotFound: Cleaned active state and completed task for path: ${path} (${sessionId})`)
  }
}

/** Keep the local attachment intact when the server rejects a stale base. */
export const receiveFileConflict = function (data: { path?: string; sessionId?: string; reason?: string; conflictPath?: string; remoteSha256?: string; remoteVersion?: string; incomingSha256?: string; context?: string; pageIndex?: number; traceId?: string }, plugin: FastSync) {
  const path = data.path ? normalizePath(data.path) : "";
  if (!path) return;
  if (data.remoteSha256) try { setAttachmentConflict(plugin, path, data.remoteSha256, undefined, plugin.settings.vault, data.incomingSha256, data.remoteVersion); }
  catch (error) { dump("Unable to persist attachment conflict record", error); }
  else if (data.reason === "remote_deleted") try { setAttachmentDeletedConflict(plugin, path); }
  catch (error) { dump("Unable to persist attachment conflict record", error); }
  if (data.sessionId) receiveFileUploadSessionNotFound(data.sessionId, plugin);
  else if (data.pageIndex !== undefined) {
    plugin.fileSyncTasks.failed++;
    plugin.recordSyncCompleted('file', data.pageIndex, data.context);
  }
  const saved = data.conflictPath ? `；服务端冲突版本：${data.conflictPath}` : "";
  const message = `附件发生同步冲突，本地文件已保留${saved}`;
  SyncLogManager.getInstance().addLog('receive', 'FileConflict', message, 'error', path, plugin.settings.vault, { traceId: data.traceId });
  showSyncNotice(message, 10000);
};
