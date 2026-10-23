import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { NativeSettings } from "./settings-contract.ts";

const settingsPath = () => path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
const configSchema = z.object({ useG1Credits: z.boolean().optional() }).passthrough();
async function snapshot(filePath: string) {
  const stat = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const text = stat ? await readFile(filePath, "utf8") : "{}";
  const config = configSchema.parse(JSON.parse(text));
  const revision = createHash("sha256").update((stat ? stat.isSymbolicLink() ? "symlink:" : "file:" : "absent:") + text).digest("hex");
  return { config, revision, editable: !stat?.isSymbolicLink() };
}
export async function readNativeSettings(filePath = settingsPath()): Promise<NativeSettings> {
  try {
    const value = await snapshot(filePath);
    return { filePath, useG1Credits: value.config.useG1Credits ?? false, revision: value.revision,
      editable: value.editable, message: value.editable ? null : "This settings file is a symlink. Edit it through agy or your dotfile manager." };
  } catch {
    return { filePath, useG1Credits: null, revision: null, editable: false,
      message: "The native agy settings file could not be read. It has not been changed." };
  }
}
let writes: Promise<unknown> = Promise.resolve();
export function setCreditUsage(enabled: boolean, expectedRevision: string, filePath = settingsPath()): Promise<NativeSettings> {
  const next = writes.then(async () => {
    const previous = await snapshot(filePath);
    if (!previous.editable) throw new Error("Symlinked settings must be edited through agy.");
    if (previous.revision !== expectedRevision) throw new Error("agy settings changed. Refresh before saving.");
    if ((previous.config.useG1Credits ?? false) === enabled) return readNativeSettings(filePath);
    const temporary = filePath + ".bb-" + randomUUID() + ".tmp";
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(temporary, JSON.stringify({ ...previous.config, useG1Credits: enabled }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      if ((await snapshot(filePath)).revision !== expectedRevision) throw new Error("agy settings changed. Refresh before saving.");
      await rename(temporary, filePath);
      return await readNativeSettings(filePath);
    } finally { await rm(temporary, { force: true }); }
  });
  writes = next.catch(() => undefined);
  return next;
}
