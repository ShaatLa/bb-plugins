import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { errorMessage } from "../shared/errors";
import type { StartMode } from "./store";

export const GATE_PLUGIN_ID = "spawn-gate";
/** A policy read that failed: nothing is known, so nothing is scheduled or launched on a guess. */
export class PolicyReadError extends Error {
  constructor(cause: unknown) { super(`could not read the Spawn Gate launch policy (${errorMessage(cause)}); try again`); this.name = "PolicyReadError"; }
}
const READ_TIMEOUT_MS = 10_000;
const gateConfig = z.object({ enabled: z.boolean(), method: z.enum(["script", "instruction"]) }).passthrough();

/**
 * How the bb project's sessions are launched: `spawn_gate` when Spawn Gate is installed with its Script launch on, else `preset`
 * (Spawn Gate absent, off or in instruction mode). A failed or unreadable answer throws, never falls back to a preset.
 */
export async function resolveMode(bb: BbPluginApi, bbProjectId: string): Promise<StartMode> {
  let installed: boolean;
  try {
    installed = (await bb.sdk.plugins.list({ signal: AbortSignal.timeout(READ_TIMEOUT_MS) })).plugins.some((plugin) => plugin.id === GATE_PLUGIN_ID && plugin.enabled);
  } catch (error) { throw new PolicyReadError(error); }
  if (!installed) return "preset";
  try {
    const config = await bb.sdk.plugins.callRpc({ pluginId: GATE_PLUGIN_ID, method: "config.get", input: { projectId: bbProjectId }, outputSchema: gateConfig, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return config.enabled && config.method === "script" ? "spawn_gate" : "preset";
  } catch (error) { throw new PolicyReadError(error); }
}

const startOutput = z.object({ dryRun: z.boolean(), threadId: z.string().optional() }).passthrough();
/** Spawn Gate's `start` with a builder's args; throws what the call threw. */
export async function callStart(bb: BbPluginApi, input: { projectId: string; parentThreadId: string; args: string[]; dryRun: boolean }) {
  return bb.sdk.plugins.callRpc({ pluginId: GATE_PLUGIN_ID, method: "start", input, outputSchema: startOutput });
}

/** The code a builder wrote on the first line of its stderr, which Spawn Gate's error message carries. */
export const reasonCodeOf = (message: string) => /"reasonCode"\s*:\s*"([a-z][a-z0-9_]{0,39})"/.exec(message)?.[1] ?? null;

const REFUSING_CODES = new Set(["forbidden", "not_found", "conflict", "invalid", "invalid_json", "invalid_input", "unknown_method"]);
// Spawn Gate's refusals before anything is minted or spawned (START-CONTRACT): builder failure, pace and provider refusals, parent, project and placement checks.
const PRE_SPAWN = /(?:^|\s)(?:exited -?\d+:|timed out after 60 seconds|output exceeds 1 MiB)|^(?:Builder |Use a parent thread|start requires Script mode|Provider pace |Pinned provider |Set |Cannot resolve|Machine |Wait for the parent|Project has no source|The builder selected|Workspace directory|The project source|Heavy Slots|Provider ".+" is not ready|Could not load the verified|The fetched commit|Use a ready environment)/;
/**
 * Only a definite answer is a refusal: the call was rejected at the plugin boundary, or its handler failed with one of Spawn Gate's
 * pre-spawn messages. Anything else (a lost response, a failed spawn call, an unknown message) may have started a session.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;
  if (typeof code === "string" && REFUSING_CODES.has(code)) return true;
  return code === "handler_error" && PRE_SPAWN.test(errorMessage(error).replace(/^HTTP \d+:\s*/, "").trim());
}
