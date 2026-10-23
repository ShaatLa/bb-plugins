import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { settingsHostContract } from "./settings-contract.ts";
import { readDiagnostics } from "./diagnostics.ts";
import { setCreditUsage } from "./native-settings.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  experimental_defineProviderBridge, createBridgeIo, providerMaintenanceParamsSchema,
  providerInstallationStatusParamsSchema, providerInstallationRunParamsSchema,
  modelListParamsSchema, threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, turnSteerParamsSchema,
  initializeParamsSchema, PROVIDER_BRIDGE_PROTOCOL_VERSION, THREAD_DELTA_GRAMMAR_V3,
  bridgeRequestEnvelopeSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge as acp } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { installationRun, installationStatus, readUsage, readCredits, resolveAgy } from "./maintenance.ts";
import { shimSource } from "./shim.ts";
import { readModels } from "./models.ts";

const io = createBridgeIo();
const optionsSchema = z.object({ agyCommand: z.string().default("") });
let dataDir = path.join(os.tmpdir(), "bb-antigravity");
let tempDir = os.tmpdir();
let launch: ReturnType<typeof launchSpec> | undefined;
let launchKey = "";

async function launchSpec(options: z.infer<typeof optionsSchema>) {
  const agy = await resolveAgy(options.agyCommand);
  if (!agy) throw new Error("Install and sign in to agy on this machine first.");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const shim = path.join(dataDir, "adapter-shim.mjs");
  await writeFile(shim, shimSource, { mode: 0o600 });
  return { displayName: "Antigravity provider", command: process.execPath, args: [shim],
    permissionCli: { insertAfterArgs: 1, full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] },
    env: {
    // BB's Electron executable needs Node mode to run the shim.
    ELECTRON_RUN_AS_NODE: "1",
    AGY_BIN: agy, AGY_BB_DATA_DIR: dataDir, AGY_BB_TEMP_DIR: tempDir,
    PATH: [path.dirname(agy), process.env.PATH ?? ""].join(path.delimiter),
  } };
}

async function dispatch(request: { id: string | number; method: string; params?: any }, line: string) {
  const { id, method } = request;
  try {
    if (method === "initialize") {
      initializeParamsSchema.parse(request.params);
      return io.sendResult(id, {
        ok: true, protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: { sessionRestore: false, threadArchive: false, threadRename: false, threadGoalClear: false,
          fork: "none", approvalEnforcedBy: "runtime", grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "inject", skills: { configure: true }, commands: { list: false } },
      });
    }
    if (method === "model/list") {
      modelListParamsSchema.parse(request.params);
      const options = optionsSchema.parse(request.params?.providerOptions ?? {});
      return io.sendResult(id, { models: await readModels(options.agyCommand), selectedOnlyModels: [] });
    }
    if (method.startsWith("provider/")) {
      const params = method === "provider/installation/status"
        ? providerInstallationStatusParamsSchema.parse(request.params)
        : method === "provider/installation/run" ? providerInstallationRunParamsSchema.parse(request.params)
        : providerMaintenanceParamsSchema.parse(request.params);
      const options = optionsSchema.parse(params.providerOptions ?? {});
      if (method === "provider/usage") return io.sendResult(id, { supported: true, usage: await readUsage(options.agyCommand) });
      if (method === "provider/installation/status") return io.sendResult(id, await installationStatus(options.agyCommand, params.checkUpdates !== false));
      if (method === "provider/installation/run") return io.sendResult(id, await installationRun(options.agyCommand, String(params.action)));
      if (method === "provider/health") {
        const [status, usage] = await Promise.all([installationStatus(options.agyCommand, false), readUsage(options.agyCommand)]);
        return io.sendResult(id, { supported: true, health: {
          status: status.versionUnsupported ? "unsupported_version" : usage.status === "ok" ? "ready" : usage.status === "error" ? "unknown" : usage.status,
          statusMessage: usage.status === "error" ? usage.message : null,
          accountEmail: usage.status === "ok" ? usage.accountEmail : null, planLabel: null,
          installedVersion: status.currentVersion, minimumSupportedVersion: status.minimumSupportedVersion,
          canInstall: false, canUpdate: status.installed, loginCommand: "agy",
        } });
      }
      return acp.handleLine(line);
    }
    if (["model/list", "thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method)) {
      const schema = { "model/list": modelListParamsSchema, "thread/start": threadStartParamsSchema,
        "thread/resume": threadResumeParamsSchema, "turn/start": turnStartParamsSchema, "turn/steer": turnSteerParamsSchema }[method];
      if (!schema?.safeParse(request.params).success) return acp.handleLine(line);
      const params = request.params;
      if (!params || typeof params !== "object") return acp.handleLine(line);
      const parent = ["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method) ? params.options : params;
      if (!parent || typeof parent !== "object") return acp.handleLine(line);
      const options = optionsSchema.parse(parent.providerOptions ?? {});
      const key = JSON.stringify(options);
      if (key !== launchKey) { launch = undefined; launchKey = key; }
      launch ??= launchSpec(options).catch(error => { launch = undefined; throw error; });
      parent.providerOptions = { ...parent.providerOptions, acpLaunchSpec: await launch, acpDialect: "generic" };
      return acp.handleLine(JSON.stringify(request));
    }
    acp.handleLine(line);
  } catch (error) {
    io.sendError(id, error instanceof z.ZodError ? -32602 : -32603,
      error instanceof z.ZodError ? "Invalid Antigravity parameters." : "Antigravity could not start. Check agy login and the ACP adapter.");
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) { dataDir = context.dataDir; tempDir = context.tempDir; acp.start?.(context); },
  handleLine(line) {
    let request;
    try { request = JSON.parse(line); } catch { return acp.handleLine(line); }
    if (bridgeRequestEnvelopeSchema.safeParse(request).success)
      void dispatch(request, line);
    else acp.handleLine(line);
  },
  onClose: acp.onClose, onSigint: acp.onSigint, onSigterm: acp.onSigterm,
});

export default experimental_defineHostEntry({
  contract: settingsHostContract,
  handlers: {
    diagnostics: ({ command, checkUpdates }) => readDiagnostics(command, checkUpdates),
    async setCreditUsage({ command, enabled, expectedRevision }) {
      if (!await resolveAgy(command) || (await readCredits(command)).status !== "ok") throw new Error("AI credits are unavailable on this machine or account.");
      try { return await setCreditUsage(enabled, expectedRevision); }
      catch { throw new Error("Native settings could not be saved. Refresh diagnostics; the file may have changed or require manual editing."); }
    },
  },
});
