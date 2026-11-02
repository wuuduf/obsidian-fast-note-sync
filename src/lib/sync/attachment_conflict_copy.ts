import { normalizePath } from "obsidian";

/** Store a conflict version beside the original without replacing any file. */
export async function saveAttachmentConflictCopy(
  vault: { createBinary(path: string, data: ArrayBuffer): Promise<unknown>; getAbstractFileByPath(path: string): unknown },
  originalPath: string,
  data: ArrayBuffer,
  createId: () => string,
): Promise<string> {
  const normalized = normalizePath(originalPath);
  const slash = normalized.lastIndexOf("/");
  const folder = slash < 0 ? "" : normalized.slice(0, slash + 1);
  const name = normalized.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = createId().replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
    if (!id) throw new Error("Invalid conflict copy identifier");
    const target = normalizePath(`${folder}${stem}.conflict-${id}${extension}`);
    if (target === normalized || vault.getAbstractFileByPath(target)) continue;
    try {
      await vault.createBinary(target, data);
      return target;
    } catch (error) {
      // A simultaneous creator may have won between lookup and create.
      if (vault.getAbstractFileByPath(target)) continue;
      throw error;
    }
  }
  throw new Error("Unable to create a unique attachment conflict copy");
}
