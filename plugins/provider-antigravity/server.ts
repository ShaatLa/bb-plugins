import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registerUsageSource } from "./usage-source.ts";
import { settingsHostContract, settingsRpcContract } from "./settings-contract.ts";

export const PROVIDER_ID = "antigravity";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    agyCommand: { type: "string", label: "agy executable", default: "", description: "Absolute path on the execution machine. Empty finds the installed agy on PATH or in ~/.local/bin." },
  });
  bb.providers.register({
    id: PROVIDER_ID, displayName: "Antigravity provider", icon: "./icons/antigravity.svg",
    strings: {
      signInHint: "Run agy on this machine to sign in, then refresh.",
      expiredHint: "Sign in again with agy on this machine, then refresh.",
      installUrl: "https://antigravity.google/docs/cli",
    },
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: false, supportsNativeUserQuestion: false,
      supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false,
      fork: "none", permissionModes: ["accept-edits", "full"], reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    models: { scope: "host" }, completedTurnDisplay: "flat", composerActions: [],
    deriveProviderOptions: context => ({
      agyCommand: typeof context.settings.agyCommand === "string" ? context.settings.agyCommand : "",
    }),
  });
  registerUsageSource(bb);
  const host = bb.hosts.experimental_client({ contract: settingsHostContract });
  const diagnostics = async (hostId: string, checkUpdates = false) => {
    const { agyCommand } = await settings.get();
    return host.call("diagnostics", { command: agyCommand, checkUpdates }, { hostId, timeoutMs: 45_000 });
  };
  bb.rpc.register(settingsRpcContract, {
    diagnostics: ({ hostId, checkUpdates }) => diagnostics(hostId, checkUpdates),
    async setCreditUsage({ hostId, enabled, expectedRevision }) {
      const { agyCommand } = await settings.get();
      return host.call("setCreditUsage", { command: agyCommand, enabled, expectedRevision }, { hostId });
    },
  });

  bb.agents.registerTool({
    name: "antigravity_limits",
    description: "Read actual Antigravity quota remaining and reset times on a BB machine. Use the current machine ID from your instructions. Works from any agent provider.",
    parameters: z.object({ hostId: z.string().min(1), refresh: z.boolean().default(false) }),
    async execute({ hostId, refresh }) {
      const result = await bb.sdk.system.usageLimits({ hostId, providerId: PROVIDER_ID, refresh });
      const usage = result[PROVIDER_ID];
      if (!usage) return { isError: true, content: [{ type: "text", text: "Antigravity usage is unavailable on this machine." }] };
      return JSON.stringify({ hostId, ...usage, ...(usage.status === "ok" ? {
        windows: usage.windows.map(window => ({ ...window, remainingPercent: 100 - window.usedPercent })),
      } : {}) });
    },
  });
  bb.agents.configure(context => ({
    tools: ["antigravity_limits"], skills: ["antigravity"],
    instructions: `Antigravity quotas are available with antigravity_limits. Current machine ID: ${context.host.id}. Query it when choosing a provider or checking remaining capacity; do not infer quota from model availability.`,
  }));
  bb.cli.register({
    name: "antigravity", summary: "Inspect the Antigravity provider and actual quota remaining",
    commands: [
      { name: "status", summary: "Show provider registration", usage: "bb antigravity status" },
      { name: "diagnostics", summary: "Inspect CLI, account, models, credits and native settings", usage: "bb antigravity diagnostics --host <id> [--check-updates]" },
      { name: "usage", summary: "Show actual quota remaining", usage: "bb antigravity usage [--host <id>] [--refresh]" },
    ],
    async run(argv) {
      if (argv[0] === "status") return { exitCode: 0, stdout: JSON.stringify((await bb.sdk.providers.list()).filter(p => p.id === PROVIDER_ID), null, 2) + "\n" };
      if (!["usage", "diagnostics"].includes(argv[0])) return { exitCode: 1, stderr: "Usage: bb antigravity status | usage [--host <id>] [--refresh] | diagnostics --host <id> [--check-updates]\n" };
      const args = argv.slice(1);
      let hostId: string | undefined;
      let refresh = false;
      let checkUpdates = false;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === "--check-updates" && argv[0] === "diagnostics") checkUpdates = true;
        else if (args[index] === "--refresh") refresh = true;
        else if (args[index] === "--host" && args[index + 1] && !args[index + 1].startsWith("--")) hostId = args[++index];
        else return { exitCode: 1, stderr: "Unknown or incomplete option. Use --host <id> or --refresh.\n" };
      }
      if (argv[0] === "diagnostics") {
        if (!hostId) return { exitCode: 1, stderr: "Use diagnostics --host <id>.\n" };
        return { exitCode: 0, stdout: JSON.stringify(await diagnostics(hostId, checkUpdates), null, 2) + "\n" };
      }
      const result = await bb.sdk.system.usageLimits({ hostId, providerId: PROVIDER_ID, refresh });
      const usage = result[PROVIDER_ID];
      return { exitCode: usage?.status === "ok" ? 0 : 1, stdout: JSON.stringify(usage ?? { status: "error", message: "No usage available." }, null, 2) + "\n" };
    },
  });
}
