import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import type { ProviderUsage } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1";
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
import { readCaps, type Caps } from "./reasoning.ts";

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) });

// "ggml-org/gpt-oss-20b-GGUF:MXFP4" -> "gpt-oss-20b (MXFP4)"
export function displayName(id: string) {
  const [name, quant] = (id.split("/").at(-1) ?? id).split(":");
  return name.replace(/-GGUF$/i, "") + (quant ? ` (${quant})` : "");
}

// The configured default wins when the server lists it; otherwise the server's first model.
export function parseModels(body: unknown, defaultModel = "", caps: Record<string, Caps> = {}): (PluginProviderFallbackModel & { model: string })[] {
  const entries = modelListSchema.parse(body).data;
  const fallback = entries.some(entry => entry.id === defaultModel) ? defaultModel : entries[0]?.id;
  const models = entries.map(entry => {
    const known = caps[entry.id];
    const levels = known ? [...(known.none ? ["none"] : []), ...known.levels] : ["low","medium","high"];
    return ({
    id: entry.id, model: entry.id, displayName: displayName(entry.id), description: `Local · ${entry.id}`,
    isDefault: entry.id === fallback, defaultReasoningEffort: levels.includes("medium") ? "medium" : levels[0],
    supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  }); });
  if (!models.length) throw new Error("The local server lists no models.");
  return models;
}

export async function readModels(baseUrl: string, defaultModel = "", dataDir = "") {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Local server answered ${response.status}.`);
  return parseModels(await response.json(), defaultModel, readCaps(dataDir));
}

// Local models have no quota: one usage row listing all installed models.
// The label ends with an invisible separator (U+2063) so CSS can target this row.
export function usageFor(models: { displayName: string }[]): ProviderUsage {
  const shortName = (name: string) => name.split(" ")[0];
  const names = models.map(m => shortName(m.displayName)).filter(Boolean);
  const label = names.join(", ")+"\u2063";
  return {
    status: "ok",
    accountEmail: null,
    planLabel: "Local",
    windows: [{
      label,
      usedPercent: 0,
      resetsAt: null,
    }],
  };
}
