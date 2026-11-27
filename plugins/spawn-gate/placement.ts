import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Build } from "./start";

type Sdk = BbPluginApi["sdk"];
type Host = Awaited<ReturnType<Sdk["hosts"]["list"]>>[number];
type Project = Awaited<ReturnType<Sdk["projects"]["get"]>>;

export async function resolveMachine(sdk: Sdk, target: string, signal: AbortSignal) {
  const hosts = await sdk.hosts.list({ signal });
  const names = hosts.filter(host => host.name === target);
  const host = hosts.find(host => host.id === target) ?? (names.length === 1 ? names[0] : undefined);
  if (!host && names.length > 1) throw new Error(`Machine "${target}" is ambiguous. Use its host ID from bb machine list.`);
  if (!host) throw new Error(`Machine "${target}" was not found. Choose an enrolled machine from bb machine list.`);
  if (host.status !== "connected" || host.lifecycle.phase !== "active") {
    throw new Error(`Machine "${host.name}" is unavailable. Reconnect it or select a connected machine.`);
  }
  return host;
}

const slotsStatus = z.object({
  ok: z.literal(true),
  data: z.object({
    localHostId: z.string(),
    leaseHosts: z.record(z.string(), z.object({ pools: z.array(z.string()) })).optional(),
  }),
});

export async function requireHeavySlots(sdk: Sdk, host: Host, signal: AbortSignal) {
  const status = await sdk.plugins.callRpc({ pluginId: "slots", method: "status", input: {}, outputSchema: slotsStatus, signal })
    .catch(() => null);
  const data = status?.data;
  const supported = data?.leaseHosts
    ? data.leaseHosts[host.id]?.pools.includes("heavy")
    : data?.localHostId === host.id;
  if (!supported) {
    throw new Error(`Heavy Slots leases are unavailable on "${host.name}". Configure heavy leases there or choose a machine that supports them.`);
  }
}

export async function placeOnMachine(sdk: Sdk, host: Host, project: Project, spawn: Build["spawn"], signal: AbortSignal) {
  const { id: hostId, name } = host;
  const target = spawn.environment;
  const source = project.sources.find(item => item.hostId === hostId);
  const sourcePath = () => {
    if (!source) {
      throw new Error(`Project has no source checkout on "${name}". Add a project source there or have the builder reuse a ready environment on that machine.`);
    }
    return source.path;
  };
  let path: string | undefined;
  if (target?.type === "reuse") {
    const existing = await sdk.environments.get({ environmentId: target.environmentId, signal }).catch(() => null);
    if (!existing || existing.hostId !== hostId || existing.projectId !== project.id ||
      existing.status !== "ready" || !existing.path) {
      throw new Error(`Use a ready environment in this project on "${name}", or ask the builder for a new workspace there.`);
    }
    path = existing.path;
  } else if (target?.type === "host") {
    if (target.hostId && target.hostId !== hostId) {
      throw new Error(`The builder selected a different host. Choose its host or ask the builder for a workspace on "${name}".`);
    }
    if (target.workspace.type === "managed-worktree") path = sourcePath();
    if (target.workspace.type === "unmanaged") path = target.workspace.path;
    target.hostId = hostId;
  } else if (project.kind === "personal") {
    spawn.environment = { type: "host", hostId, workspace: { type: "personal" } };
  } else {
    path = sourcePath();
    spawn.environment = { type: "host", hostId, workspace: { type: "unmanaged", path } };
  }
  if (path) {
    await sdk.files.list({ hostId, path, limit: 1, signal }).catch(() => {
      throw new Error(`Workspace directory is unavailable on "${name}". Set up the checkout there or choose an existing workspace on that machine.`);
    });
  }
  if (target?.type === "host" && target.workspace.type === "managed-worktree") {
    const repository = await sdk.projects.branches({ projectId: project.id, hostId, limit: "1", signal }).catch(() => null);
    if (!repository || !("headSha" in repository.checkout) || !repository.checkout.headSha) {
      throw new Error(`The project source on "${name}" needs a Git checkout with a commit before bb can create a worktree.`);
    }
  }
}

export async function requireProviderReady(sdk: Sdk, { id: hostId, name }: Host, providerId: string | undefined, signal: AbortSignal) {
  if (!providerId) {
    throw new Error(`Set spawn.providerId in the builder so Spawn Gate can verify provider readiness on "${name}".`);
  }
  const { providers } = await sdk.system.providerStates({ hostId, signal }).catch(() => ({ providers: [] }));
  const state = providers.find(provider => provider.providerId === providerId);
  if (state?.status !== "ready") {
    throw new Error(`Provider "${providerId}" is not ready on "${name}" (${state?.status ?? "unavailable"}). Install or sign in to the provider on that machine, or configure pooled credentials if supported.`);
  }
}
