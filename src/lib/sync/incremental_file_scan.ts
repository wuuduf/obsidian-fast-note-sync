/** Older timestamps alone cannot prove that the local content was synced. */
export function shouldSkipIncrementalFile(
  incremental: boolean,
  mtime: number,
  lastSyncTime: number,
  baseHash: string | null,
  cachedHash: string | null,
  pendingUpload: boolean,
): boolean {
  return incremental && mtime < lastSyncTime && baseHash !== null && cachedHash === baseHash && !pendingUpload;
}
