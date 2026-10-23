import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import { resolveAgy, runAgy } from "./maintenance.ts";

export const GOOGLE_MODEL_PREFIX = "gemini-";

export function parseModels(output: string) {
  const models = new Map<string, PluginProviderFallbackModel & { model: string }>();
  for (const line of output.trim().split(/\r?\n/)) {
    const [rawId, name] = line.split("\t");
    if (!rawId?.startsWith(GOOGLE_MODEL_PREFIX) || !name || !/^[\w.-]+$/.test(rawId)) continue;
    const effort = rawId.match(/-(low|medium|high|xhigh|max)$/)?.[1] ?? "none";
    const id = rawId.replace(/-(low|medium|high|xhigh|max)$/, "");
    const previous = models.get(id);
    if (previous) {
      if (!previous.supportedReasoningEfforts.some(option => option.reasoningEffort === effort))
        models.set(id, { ...previous, supportedReasoningEfforts: [...previous.supportedReasoningEfforts, { reasoningEffort: effort, description: effort }] });
    } else {
      models.set(id, { id, model: id, displayName: name.replace(/\s+\((Low|Medium|High|Xhigh|Max)\)$/i, ""),
        description: name, isDefault: models.size === 0, defaultReasoningEffort: effort,
        supportedReasoningEfforts: [{ reasoningEffort: effort, description: effort }] });
    }
  }
  if (!models.size) throw new Error("Antigravity returned no models.");
  return [...models.values()];
}

export async function readModels(command = "") {
  const agy = await resolveAgy(command);
  if (!agy) throw new Error("Install agy first.");
  return parseModels(await runAgy(agy, ["models"]));
}
