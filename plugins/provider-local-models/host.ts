import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  experimental_defineProviderBridge, createBridgeIo, providerMaintenanceParamsSchema,
  modelListParamsSchema, threadStartParamsSchema, threadResumeParamsSchema, turnStartParamsSchema, turnSteerParamsSchema,
  initializeParamsSchema, PROVIDER_BRIDGE_PROTOCOL_VERSION, THREAD_DELTA_GRAMMAR_V3,
  bridgeRequestEnvelopeSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge as acp } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { shimSource } from "./shim.ts";
import { DEFAULT_BASE_URL, effectiveBaseUrl, readModels } from "./models.ts";

const io = createBridgeIo();
const optionsSchema = z.object({ baseUrl: z.string().default(DEFAULT_BASE_URL).transform(value => value || DEFAULT_BASE_URL), defaultModel: z.string().default(""), splash: z.boolean().default(false), splashProxyPort: z.number().int().min(1).max(65535).default(8011) }).transform(options => ({ baseUrl: effectiveBaseUrl(options), defaultModel: options.defaultModel, splash: options.splash }));
type Options = z.infer<typeof optionsSchema>;
let dataDir = path.join(os.tmpdir(), "bb-local-models");
let launch: ReturnType<typeof launchSpec> | undefined;
let launchKey = "";

export async function launchSpec(options: Options) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // Per-version name: the file is written once and never changed, so running and new bridges cannot swap code.
  const shim = path.join(dataDir, `adapter-shim-${createHash("sha256").update(shimSource).digest("hex").slice(0, 12)}.mjs`);
  // Temp file + rename: a crash mid-write must never leave a truncated shim under the final name.
  if (!(await stat(shim).catch(() => null))) { const temp = `${shim}.${process.pid}.tmp`; await writeFile(temp, shimSource, { mode: 0o600 }); await rename(temp, shim); }
  await pruneShims(dataDir, shim);
  return { displayName: "Local models", command: process.execPath, args: [shim],
    permissionCli: { insertAfterArgs: 1, full: ["--bb-permission-mode=full"], workspaceWrite: ["--bb-permission-mode=accept-edits"] },
    env: {
    // BB's Electron executable needs Node mode to run the shim.
    ELECTRON_RUN_AS_NODE: "1",
    LM_BASE_URL: options.baseUrl, LM_SPLASH: options.splash ? "1" : "0", LM_DEFAULT_MODEL: options.defaultModel, LM_BB_DATA_DIR: dataDir,
  } };
}

// Best effort: per-version copies from older builds would otherwise accumulate forever.
async function pruneShims(dir: string, current: string) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const name of await readdir(dir).catch(() => [])) {
    const file = path.join(dir, name);
    if (file === current || !/^adapter-shim.*\.mjs$/.test(name)) continue;
    await stat(file).then(async info => { if (info.mtimeMs < cutoff) await unlink(file); }).catch(() => undefined);
  }
}

async function readHealth(options: Options) {
  const reachable = await readModels(options.baseUrl, "", dataDir, options.splash).then(() => true, () => false);
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
      const options = optionsSchema.parse({ baseUrl: env.LM_BASE_URL, splash: env.LM_SPLASH === "1", splashProxyPort: env.LM_SPLASH_PROXY_PORT ? Number(env.LM_SPLASH_PROXY_PORT) : undefined, defaultModel: env.LM_DEFAULT_MODEL, ...request.params?.providerOptions });
      return io.sendResult(id, { models: await readModels(options.baseUrl, options.defaultModel, dataDir, options.splash), selectedOnlyModels: [] });
    }
    // Local models have no quota, so maintenance.usage is false and BB does not ask for usage.
    if (method === "provider/usage") return io.sendResult(id, { supported: false });
    if (method === "provider/health") {
      const params = providerMaintenanceParamsSchema.parse(request.params);
      const options = optionsSchema.parse(params.providerOptions ?? {});
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
      const spec = await launch;
      // Each thread gets its own shim; the BB thread id lets it hold a Slots use for its turns.
      parent.providerOptions = { ...parent.providerOptions, acpLaunchSpec: { ...spec, env: { ...spec.env, LM_THREAD_ID: request.params.threadId } }, acpDialect: "generic" };
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
