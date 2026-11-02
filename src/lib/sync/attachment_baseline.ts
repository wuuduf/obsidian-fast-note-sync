/** Only explicitly server-confirmed attachment bytes may become a strong base. */
type BaselinePlugin = { settings: { vault: string }; app: { loadLocalStorage(key: string): unknown; saveLocalStorage(key: string, value: string | null): void } };
const key = (vault: string) => `fns-attachment-base-sha256:${encodeURIComponent(vault)}`;
type Entry = { hash: string; sha256: string; version?: string };
export const validAttachmentVersion = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const cache = new WeakMap<BaselinePlugin, Map<string, { raw: string; data: Record<string, Entry> }>>();
function read(plugin: BaselinePlugin, vault: string): Record<string, Entry> {
  try {
    const raw = plugin.app.loadLocalStorage(key(vault));
    if (typeof raw === "string") {
      const prior = cache.get(plugin)?.get(vault);
      if (prior?.raw === raw) return prior.data;
    }
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    if (typeof raw === "string" && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = parsed as Record<string, Entry>;
      let vaults = cache.get(plugin);
      if (!vaults) { vaults = new Map(); cache.set(plugin, vaults); }
      vaults.set(vault, { raw, data: entries });
      return entries;
    }
  } catch { /* Invalid or unavailable state is treated as an unknown base. */ }
  return {};
}
export function getAttachmentBaseSha(plugin: BaselinePlugin, path: string, hash: string | null, vault = plugin.settings.vault): string | undefined {
  const value = read(plugin, vault)[path];
  return hash && value && value.hash === hash && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : undefined;
}
export function getAttachmentBaseVersion(plugin: BaselinePlugin, path: string, hash: string | null, vault = plugin.settings.vault): string | undefined {
  const entry = read(plugin, vault)[path];
  return getAttachmentBaseSha(plugin, path, hash, vault) && validAttachmentVersion(entry?.version) ? entry.version : undefined;
}
export function setAttachmentBaseSha(plugin: BaselinePlugin, path: string, hash: string, sha: string, vault = plugin.settings.vault, version?: string): void {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid confirmed attachment SHA-256");
  const data = { ...read(plugin, vault) };
  Object.defineProperty(data, path, { value: { hash, sha256: sha, ...(validAttachmentVersion(version) ? { version } : {}) }, enumerable: true, configurable: true, writable: true });
  const raw = JSON.stringify(data);
  plugin.app.saveLocalStorage(key(vault), raw);
  let vaults = cache.get(plugin);
  if (!vaults) { vaults = new Map(); cache.set(plugin, vaults); }
  vaults.set(vault, { raw, data });
}

const conflictKey = (vault: string, path: string) => `fns-attachment-conflict:${encodeURIComponent(vault)}:${encodeURIComponent(path)}`;
export function getAttachmentConflict(plugin: BaselinePlugin, path: string, vault = plugin.settings.vault): { remoteSha256: string; remoteVersion?: string; incomingSha256?: string; copyPath?: string; deleted?: boolean; pending?: boolean; mutation?: 'delete' | 'rename'; targetPath?: string } | undefined {
  try {
    const raw = plugin.app.loadLocalStorage(conflictKey(vault, path));
    const value = typeof raw === "string" ? JSON.parse(raw) : null;
    return value && typeof value.remoteSha256 === "string" && (/^[a-f0-9]{64}$/.test(value.remoteSha256) || ((value.deleted === true || value.pending === true || value.mutation === 'delete' || value.mutation === 'rename') && value.remoteSha256 === "")) ? value : undefined;
  } catch { return undefined; }
}
/** Keep a rejected local deletion/rename from being sent again on a later scan. */
export function setAttachmentMutationConflict(plugin: BaselinePlugin, path: string, mutation: 'delete' | 'rename', remoteSha256: string, targetPath?: string, vault = plugin.settings.vault, remoteVersion?: string): void {
  const remote = /^[a-f0-9]{64}$/.test(remoteSha256) ? remoteSha256 : "";
  const previous = getAttachmentConflict(plugin, path, vault);
  const copyPath = previous?.remoteSha256 === remote && previous.remoteVersion === remoteVersion ? previous.copyPath : undefined;
  plugin.app.saveLocalStorage(conflictKey(vault, path), JSON.stringify({ remoteSha256: remote, remoteVersion: validAttachmentVersion(remoteVersion) ? remoteVersion : undefined, mutation, targetPath, copyPath }));
}
export function clearAttachmentMutationConflict(plugin: BaselinePlugin, path: string, vault = plugin.settings.vault): void {
  if (getAttachmentConflict(plugin, path, vault)?.mutation)
    plugin.app.saveLocalStorage(conflictKey(vault, path), null);
}
/** Protect an occupied rename target until its remote bytes are verified. */
export function setAttachmentPendingConflict(plugin: BaselinePlugin, path: string, vault = plugin.settings.vault): void {
  if (!getAttachmentConflict(plugin, path, vault))
    plugin.app.saveLocalStorage(conflictKey(vault, path), JSON.stringify({ remoteSha256: "", pending: true }));
}
export function clearAttachmentPendingConflict(plugin: BaselinePlugin, path: string, vault = plugin.settings.vault): void {
  if (getAttachmentConflict(plugin, path, vault)?.pending)
    plugin.app.saveLocalStorage(conflictKey(vault, path), null);
}
export function setAttachmentDeletedConflict(plugin: BaselinePlugin, path: string, vault = plugin.settings.vault): void {
  plugin.app.saveLocalStorage(conflictKey(vault, path), JSON.stringify({ remoteSha256: "", deleted: true }));
}
export function setAttachmentConflict(plugin: BaselinePlugin, path: string, remoteSha256: string, copyPath?: string, vault = plugin.settings.vault, incomingSha256?: string, remoteVersion?: string): void {
  if (!/^[a-f0-9]{64}$/.test(remoteSha256)) return;
  const previous = getAttachmentConflict(plugin, path, vault);
  if (previous?.remoteSha256 === remoteSha256 && previous.remoteVersion === remoteVersion) {
    if (!copyPath) copyPath = previous.copyPath;
    if (!incomingSha256) incomingSha256 = previous.incomingSha256;
  }
  if (incomingSha256 && !/^[a-f0-9]{64}$/.test(incomingSha256)) incomingSha256 = undefined;
  plugin.app.saveLocalStorage(conflictKey(vault, path), JSON.stringify({ remoteSha256, remoteVersion: validAttachmentVersion(remoteVersion) ? remoteVersion : undefined, incomingSha256, copyPath, mutation: previous?.mutation, targetPath: previous?.targetPath }));
}
/** Preserve a recorded version without resubmitting it indefinitely. */
export function shouldDeferAttachmentConflict(plugin: BaselinePlugin, path: string, snapshotSha256: string, vault = plugin.settings.vault): boolean {
  const conflict = getAttachmentConflict(plugin, path, vault);
  return conflict?.deleted === true || conflict?.pending === true || !!conflict?.mutation || (!!conflict?.incomingSha256 && conflict.incomingSha256 === snapshotSha256);
}
const resolutionKey = (vault: string, path: string) => `fns-attachment-conflict-resolution:${encodeURIComponent(vault)}:${encodeURIComponent(path)}`;
export function setAttachmentResolution(plugin: BaselinePlugin, path: string, remoteSha256: string, snapshotSha256: string, vault = plugin.settings.vault, remoteVersion?: string): void {
  plugin.app.saveLocalStorage(resolutionKey(vault, path), JSON.stringify({ remoteSha256, snapshotSha256, remoteVersion }));
}
export function finishAttachmentResolution(plugin: BaselinePlugin, path: string, snapshotSha256: string, vault = plugin.settings.vault): void {
  try {
    const raw = plugin.app.loadLocalStorage(resolutionKey(vault, path));
    const pending = typeof raw === "string" ? JSON.parse(raw) : null;
    const conflict = getAttachmentConflict(plugin, path, vault);
    if (pending?.snapshotSha256 === snapshotSha256 && conflict?.remoteSha256 === pending.remoteSha256 && validAttachmentVersion(pending.remoteVersion) && conflict?.remoteVersion === pending.remoteVersion) {
      plugin.app.saveLocalStorage(conflictKey(vault, path), null);
      plugin.app.saveLocalStorage(resolutionKey(vault, path), null);
    }
  } catch { /* Unknown or unavailable state must remain unresolved. */ }
}
