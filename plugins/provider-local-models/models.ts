import type { PluginProviderFallbackModel } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const DEFAULT_BASE_URL = "http://127.0.0.1:9931/v1";
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
import { readCaps, type Caps } from "./reasoning.ts";

const modelListSchema = z.object({ data: z.array(z.object({ id: z.string().min(1) }).passthrough()) });

// "ggml-org/gpt-oss-20b-GGUF:MXFP4" -> "gpt-oss-20b (MXFP4)"
export function displayName(id: string) {
  const [name, quant] = (id.split("/").at(-1) ?? id).split(":");
  return name.replace(/-GGUF$/i, "") + (quant ? ` (${quant})` : "") + (id.startsWith("splash/") ? " · Splash" : "");
}

export function preferSplash<T extends { id: string }>(entries: T[], enabled = true) {
  const variants = new Set(entries.filter(entry => entry.id.startsWith('splash/')).map(entry => entry.id.slice(7)));
  return enabled ? entries.filter(entry => !variants.has(entry.id)) : entries;
}

// The configured default wins when the server lists it; otherwise the server's first model.
export function parseModels(body: unknown, defaultModel = "", caps: Record<string, Caps> = {}): (PluginProviderFallbackModel & { model: string })[] {
  const entries = modelListSchema.parse(body).data;
  const fallback = entries.some(entry => entry.id === defaultModel) ? defaultModel : entries[0]?.id;
  const models = entries.map(entry => {
    const known = caps[entry.id];
    // A model with no reasoning control still needs one level: the host requires defaultReasoningEffort.
    const found = known ? [...(known.none ? ["none"] : []), ...known.levels] : ["low","medium","high"], levels = found.length ? found : ["none"];
    return ({
    id: entry.id, model: entry.id, displayName: displayName(entry.id), description: `Local · ${entry.id}`,
    isDefault: entry.id === fallback, defaultReasoningEffort: levels.includes("medium") ? "medium" : levels[0],
    supportedReasoningEfforts: levels.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })),
  }); });
  if (!models.length) throw new Error("The local server lists no models.");
  return models;
}

// The baseUrl setting may list several servers (e.g. llama.cpp and Splash), separated by commas or spaces.
export function serverUrls(value: string, splash = false, splashProxyPort = 8011) {
  const urls = value.split(/[\s,]+/).filter(Boolean).map(url => url.replace(/\/+$/, ""));
  if (!urls.length) urls.push(DEFAULT_BASE_URL);
  if (splash) { const proxy = `http://127.0.0.1:${splashProxyPort}/v1`; if (!urls.includes(proxy)) urls.push(proxy); }
  return urls;
}

export function effectiveBaseUrl(settings: Record<string, unknown>) {
  return serverUrls(typeof settings.baseUrl === "string" ? settings.baseUrl : "", settings.splash === true, typeof settings.splashProxyPort === "number" ? settings.splashProxyPort : 8011).join(", ");
}

async function listModels(baseUrl: string) {
  const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Local server answered ${response.status}.`); }
  return modelListSchema.parse(await response.json()).data;
}

// Models from every reachable server; on duplicate ids the server listed first wins. Fails only when no server answers.
export async function readModels(baseUrl: string, defaultModel = "", dataDir = "", splash = false) {
  const lists = await Promise.allSettled(serverUrls(baseUrl).map(listModels));
  if (!lists.some(list => list.status === "fulfilled")) throw (lists[0] as PromiseRejectedResult).reason;
  const data = lists.flatMap(list => list.status === "fulfilled" ? list.value : []).filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index);
  return parseModels({ data: preferSplash(data, splash) }, defaultModel.startsWith("splash/") ? defaultModel : splash && data.some(m => m.id === "splash/" + defaultModel) ? "splash/" + defaultModel : defaultModel, readCaps(dataDir));
}
