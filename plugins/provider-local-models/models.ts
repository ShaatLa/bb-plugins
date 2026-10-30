import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import type { ProviderUsage } from "@get-bb/plugin-sdk/provider-bridge";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1";
export const REASONING_EFFORTS = ["low", "medium", "high"];

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) });

// "ggml-org/gpt-oss-20b-GGUF:MXFP4" -> "gpt-oss-20b (MXFP4)"
export function displayName(id: string) {
  const [name, quant] = (id.split("/").at(-1) ?? id).split(":");
  return name.replace(/-GGUF$/i, "") + (quant ? ` (${quant})` : "");
}

// The configured default wins when the server lists it; otherwise the server's first model.
export function parseModels(body: unknown, defaultModel = ""): (PluginProviderFallbackModel & { model: string })[] {
  const entries = modelListSchema.parse(body).data;
  const fallback = entries.some(entry => entry.id === defaultModel) ? defaultModel : entries[0]?.id;
  const models = entries.map(entry => ({
    id: entry.id, model: entry.id, displayName: displayName(entry.id), description: `Local · ${entry.id}`,
    isDefault: entry.id === fallback, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: REASONING_EFFORTS.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  }));
  if (!models.length) throw new Error("The local server lists no models.");
  return models;
}

export async function readModels(baseUrl: string, defaultModel = "") {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Local server answered ${response.status}.`);
  return parseModels(await response.json(), defaultModel);
}

// Local models have no quota: one "∞" window per installed model.
// The label is the short model name followed by an invisible separator (U+2063)
// so CSS can target only these rows.
export function usageFor(models: { displayName: string }[]): ProviderUsage {
  const shortName = (name: string) => name.split(" ")[0];
  return {
    status: "ok",
    accountEmail: null,
    planLabel: "Local",
    windows: models.map(model => ({
      label: shortName(model.displayName) + "\u2063",
      usedPercent: 0,
      resetsAt: null,
    })),
  };
}

export async function resolveCodex(command = ""): Promise<string | null> {
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = command ? [command] : [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)),
    "/opt/homebrew/bin/codex", "/usr/local/bin/codex", path.join(os.homedir(), ".local", "bin", name),
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installation. */ }
  }
  return null;
}
