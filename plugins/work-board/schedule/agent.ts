import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { StartAgent } from "../shared/contract";
import { errorMessage } from "../shared/errors";

/** A refusal with a reason code: nothing is stored on a guess. */
export class StartRefusal extends Error {
  constructor(readonly code: string, detail: string) { super(`${detail} (${code})`); this.name = "StartRefusal"; }
}
const MODES = ["accept-edits", "auto", "full"] as const;
const ONE_OFF = "for a one-off with a model that is not listed, use `bb thread spawn`";

/**
 * Checks an agent against the live catalog of the card's bb project (the one the picker reads, routed to that project's host).
 * Returns the agent with its permission mode filled in (`auto`), or throws a `StartRefusal`. Runs when a start is scheduled,
 * changed or checked, not again at launch: a provider that has gone away by then fails in the spawn, which is classified as usual.
 */
export async function checkAgent(bb: BbPluginApi, bbProjectId: string, agent: StartAgent): Promise<StartAgent> {
  const catalog = await bb.sdk.providers.models({ projectId: bbProjectId, providerId: agent.providerId, preferCached: true })
    .catch((error: unknown) => { throw new StartRefusal("catalog_unavailable", `Could not read the model catalog, so nothing is scheduled on a guess: ${errorMessage(error)}`); });
  const provider = catalog.providers.find((entry) => entry.id === agent.providerId);
  if (!provider || !provider.available) throw new StartRefusal("provider_unavailable", `Provider ${agent.providerId} is not available for this project`);
  if (catalog.modelLoadError && catalog.modelLoadError.providerId === agent.providerId)
    throw new StartRefusal(catalog.modelLoadError.code, `The models of ${agent.providerId} could not be loaded${catalog.modelLoadError.detail ? `: ${catalog.modelLoadError.detail}` : ""}`);
  const model = catalog.models.find((entry) => entry.model === agent.model);
  if (!model) throw new StartRefusal("model_unknown", `${agent.providerId} lists no model ${agent.model}; ${ONE_OFF}`);
  if (agent.reasoningLevel && model.reasoningDiscovery === "known" && !model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === agent.reasoningLevel))
    throw new StartRefusal("reasoning_unsupported", `${agent.model} does not support reasoning level ${agent.reasoningLevel} (it supports ${model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(", ") || "none"})`);
  if (agent.serviceTier && !(model.supportedServiceTiers ?? []).some((tier) => tier.id === agent.serviceTier))
    throw new StartRefusal("service_tier_unsupported", `${agent.model} does not offer service tier ${agent.serviceTier}`);
  const permissionMode = agent.permissionMode ?? "auto";
  if (!provider.capabilities.permissionModes.includes(permissionMode)) throw new StartRefusal("permission_unsupported", `${agent.providerId} does not offer permission mode ${permissionMode}`);
  if (MODES.indexOf(permissionMode) > MODES.indexOf(catalog.permissionCeiling)) throw new StartRefusal("permission_above_ceiling", `Permission mode ${permissionMode} is above this machine's ceiling (${catalog.permissionCeiling})`);
  return { ...agent, permissionMode };
}
