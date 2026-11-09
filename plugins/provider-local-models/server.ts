import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerUsageSource } from "./usage-source.ts";
import { z } from "zod";
import { defineCli, cliCommand } from "@get-bb/plugin-sdk";
import { router } from "./router.ts";
import { DEFAULT_BASE_URL, REASONING_EFFORTS } from "./models.ts";

export const PROVIDER_ID = "local-models";

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: { type: "string", label: "Local server URL", default: DEFAULT_BASE_URL, description: "OpenAI-compatible endpoint with /models and /chat/completions, e.g. llama.cpp's llama serve." },
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
      fork: "none", permissionModes: ["accept-edits", "full"], reasoningLevels: ["none", "low", "medium", "high", "xhigh"],
    },
    reasoningLevels: ["none", "low", "medium", "high", "xhigh"].map(id => ({ id, label: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1) })),
    models: { scope: "host" }, completedTurnDisplay: "flat", composerActions: [],
    deriveProviderOptions: context => ({
      baseUrl: typeof context.settings.baseUrl === "string" && context.settings.baseUrl ? context.settings.baseUrl : DEFAULT_BASE_URL,
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
  const client = async () => {
    const value = await settings.get();
    return router(String(value.baseUrl || DEFAULT_BASE_URL), String(value.defaultModel || ''), bb.server.experimental_dataDir + '/plugins/' + bb.pluginId + '/bridge-data');  // the shim writes model-caps.json into the provider bridge's data dir
  };
  const signal = (parent: AbortSignal | undefined, timeout = 20*60000) => AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(timeout)]);
  bb.agents.registerTool({
    name: 'local_models_ask',
    description: 'One-shot prompt (no tools) to a local llama.cpp model: private and free but slow; for summaries, drafts, classification.',
    parameters: z.object({prompt:z.string().min(1).max(200000),model:z.string().optional(),system:z.string().optional(),max_tokens:z.number().int().min(1).max(8192).default(1024),effort:z.enum(['none','low','medium','high','xhigh']).optional()}),
    presentation: {label:{pending:'Asking local model',completed:'Asked local model'}},
    async execute(input,ctx) {
      try {return (await (await client()).ask(input,signal(ctx.signal))).content;}
      catch(error) {return {content:[{type:'text' as const,text:'Local model request failed: '+(error instanceof Error ? error.message : String(error))}],isError:true};}
    },
  });
  bb.agents.configure(context => ({tools:context.provider.id === PROVIDER_ID ? [] : ['local_models_ask'],skills:['local-models']}));
  const json = {type:'boolean' as const,description:'Print JSON'};
  bb.cli.register(defineCli({name:'local-models',summary:'Inspect and query the local model router',commands:{
    status:cliCommand({summary:'Show router and model status',options:{json},async run({options},ctx){
      const result=await (await client()).status(signal(ctx.signal,10000));
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):result.models.map(m=>m.id+' · '+m.displayName+' · '+m.status+' · context '+m.contextSize+(m.reasoningLevels?' · reasoning '+(m.reasoningLevels.join(', ')||'not adjustable'):'')).join('\n'))+'\n'};
    }}),
    ask:cliCommand({summary:'Send one prompt without tools',positionals:[{name:'prompt',description:'Prompt text',required:true}],options:{json,model:{type:'string',description:'Model id'},system:{type:'string',description:'System text'},'max-tokens':{type:'integer',min:1,max:8192,default:1024,description:'Output token limit'},effort:{type:'enum',values:REASONING_EFFORTS,description:'Reasoning level'},timeout:{type:'duration',defaultUnit:'m',default:1200000,min:1,max:2147483647,description:'Request timeout'}},async run({options,positionals},ctx){
      const result=await (await client()).ask({prompt:positionals.prompt,model:options.model,system:options.system,max_tokens:options['max-tokens'],effort:options.effort},signal(ctx.signal,options.timeout));
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):result.content)+'\n'};
    }}),
    unload:cliCommand({summary:'Unload model(s)',positionals:[{name:'model',description:'Model id'}],options:{all:{type:'boolean',description:'Unload all models'}},async run({options,positionals},ctx){
      return {exitCode:0,stdout:JSON.stringify(await (await client()).unload(positionals.model,options.all,signal(ctx.signal,10000)))+'\n'};
    }}),
  }}));
}
