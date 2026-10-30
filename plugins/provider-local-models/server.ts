import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerUsageSource } from "./usage-source.ts";
import { DEFAULT_BASE_URL } from "./models.ts";

export const PROVIDER_ID = "local-models";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: { type: "string", label: "Local server URL", default: DEFAULT_BASE_URL, description: "OpenAI-compatible endpoint with /models and /responses, e.g. llama.cpp's llama serve." },
    codexCommand: { type: "string", label: "codex executable", default: "", description: "Absolute path on the execution machine. Empty finds the installed codex on PATH or in Homebrew." },
    defaultModel: { type: "string", label: "Default model", default: "", description: "Model id for new threads, e.g. ggml-org/gpt-oss-20b-GGUF:MXFP4. Empty picks the first model the server lists." },
  });
  bb.providers.register({
    id: PROVIDER_ID, displayName: "Local models", icon: "./icons/local-models.svg",
    strings: {
      signInHint: "Start the local model server (llama serve) on this machine, then refresh.",
      expiredHint: "Start the local model server (llama serve) on this machine, then refresh.",
      installUrl: "https://github.com/ggml-org/llama.cpp",
    },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      supportsServiceTier: false, supportsNativeUserQuestion: false,
      supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false,
      fork: "none", permissionModes: ["accept-edits", "full"], reasoningLevels: ["low", "medium", "high"],
    },
    reasoningLevels: ["low", "medium", "high"].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    models: { scope: "host" }, completedTurnDisplay: "flat", composerActions: [],
    deriveProviderOptions: context => ({
      baseUrl: typeof context.settings.baseUrl === "string" && context.settings.baseUrl ? context.settings.baseUrl : DEFAULT_BASE_URL,
      codexCommand: typeof context.settings.codexCommand === "string" ? context.settings.codexCommand : "",
      defaultModel: typeof context.settings.defaultModel === "string" ? context.settings.defaultModel : "",
    }),
  });
  // Model listing receives env vars but no providerOptions, so the settings travel this way too.
  bb.providers.experimental_contributeEnv(PROVIDER_ID, async () => {
    const { baseUrl, defaultModel } = await settings.get();
    return [
      { name: "LM_BASE_URL", value: typeof baseUrl === "string" && baseUrl ? baseUrl : DEFAULT_BASE_URL, reason: "Local model server for model listing" },
      ...(typeof defaultModel === "string" && defaultModel ? [{ name: "LM_DEFAULT_MODEL", value: defaultModel, reason: "Default model for new threads" }] : []),
    ];
  });
  registerUsageSource(bb);
}
