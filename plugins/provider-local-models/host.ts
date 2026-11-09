import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  experimental_defineProviderBridge, createBridgeIo, providerMaintenanceParamsSchema,
  modelListParamsSchema, threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, turnSteerParamsSchema,
  initializeParamsSchema, PROVIDER_BRIDGE_PROTOCOL_VERSION, THREAD_DELTA_GRAMMAR_V3,
  bridgeRequestEnvelopeSchema, type ProviderUsage,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge as acp } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { shimSource } from "./shim.ts";
import { DEFAULT_BASE_URL, readModels, usageFor } from "./models.ts";

const io = createBridgeIo();
const optionsSchema = z.object({ baseUrl: z.string().default(DEFAULT_BASE_URL).transform(value => value || DEFAULT_BASE_URL), defaultModel: z.string().default("") });
type Options = z.infer<typeof optionsSchema>;
let dataDir = path.join(os.tmpdir(), "bb-local-models");
let launch: ReturnType<typeof launchSpec> | undefined;
let launchKey = "";

async function launchSpec(options: Options) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Per-version name: bridges of still-running threads rewrite their own copy and must not swap code under new threads.
  const shim = path.join(dataDir, `adapter-shim-${createHash("sha256").update(shimSource).digest("hex").slice(0, 12)}.mjs`);
  await writeFile(shim, shimSource, { mode: 0o600 });
  return { displayName: "Local models", command: process.execPath, args: [shim],
    permissionCli: { insertAfterArgs: 1, full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] },
    env: {
    // BB's Electron executable needs Node mode to run the shim.
    ELECTRON_RUN_AS_NODE: "1",
    LM_BASE_URL: options.baseUrl, LM_DEFAULT_MODEL: options.defaultModel, LM_BB_DATA_DIR: dataDir,
  } };
}

async function readUsage(options: Options): Promise<ProviderUsage> {
  try { return usageFor(await readModels(options.baseUrl)); }
  catch { return { status: "error", accountEmail: null, planLabel: null, message: `No local model server answers at ${options.baseUrl}.` }; }
}

async function readHealth(options: Options) {
  const reachable = await readModels(options.baseUrl).then(() => true, () => false);
  return {
    status: reachable ? "ready" as const : "unknown" as const,
    statusMessage: reachable ? null : `No local model server answers at ${options.baseUrl}.`,
    accountEmail: null, planLabel: "Local", installedVersion: null, minimumSupportedVersion: null,
    canInstall: false, canUpdate: false, loginCommand: null,
  };
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
      // BB lists models without providerOptions; the server contributes the settings as env vars instead.
      const env = request.params?.envVars ?? {};
      const options = optionsSchema.parse({ baseUrl: env.LM_BASE_URL, defaultModel: env.LM_DEFAULT_MODEL, ...request.params?.providerOptions });
      return io.sendResult(id, { models: await readModels(options.baseUrl, options.defaultModel, dataDir), selectedOnlyModels: [] });
    }
    if (method === "provider/usage" || method === "provider/health") {
      const params = providerMaintenanceParamsSchema.parse(request.params);
      const options = optionsSchema.parse(params.providerOptions ?? {});
      if (method === "provider/usage") return io.sendResult(id, { supported: true, usage: await readUsage(options) });
      return io.sendResult(id, { supported: true, health: await readHealth(options) });
    }
    if (["thread/start", "thread/resume", "turn/start", "turn/steer"].includes(method)) {
      const schema = { "thread/start": threadStartParamsSchema, "thread/resume": threadResumeParamsSchema,
        "turn/start": turnStartParamsSchema, "turn/steer": turnSteerParamsSchema }[method];
      const parent = request.params?.options;
      if (!schema?.safeParse(request.params).success || !parent || typeof parent !== "object") return acp.handleLine(line);
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
      error instanceof z.ZodError ? "Invalid Local models parameters." : "Local models could not start. Check the local model server.");
  }
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  start(context) { dataDir = context.dataDir; acp.start?.(context); },
  handleLine(line) {
    let request;
    try { request = JSON.parse(line); } catch { return acp.handleLine(line); }
    if (bridgeRequestEnvelopeSchema.safeParse(request).success)
      void dispatch(request, line);
    else acp.handleLine(line);
  },
  onClose: acp.onClose, onSigint: acp.onSigint, onSigterm: acp.onSigterm,
});
