import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { defineCli, cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import { router } from "./router.ts";
import { DEFAULT_BASE_URL, REASONING_EFFORTS, effectiveBaseUrl, serverUrls } from "./models.ts";
import { startSplash } from "./splash.ts";
import { withSlot } from './slots.ts';
import { appendUsage, listUsage, llamaCounts, usageRpcContract } from './usage-log.ts';

import { splashControls } from './splash-controls.ts';
import { settingsRpcContract } from './settings-contract.ts';
import { SPLASH_INSTALL, SPLASH_UPDATE, type DoctorReport } from './requirements.ts';

export const PROVIDER_ID = "local-models";

// The SDK calls the default export with bb only; tests use createPlugin to stub the requirement probes.
export default function plugin(bb: BbPluginApi) { return createPlugin(bb); }
export function createPlugin(bb: BbPluginApi, testing: Pick<Parameters<typeof splashControls>[0], 'run' | 'doctorOptions'> = {}) {
  const settings = bb.settings.define({
    baseUrl: { type: "string", label: "Local server URLs", default: DEFAULT_BASE_URL, description: "OpenAI-compatible endpoints with /models and /chat/completions, separated by commas, e.g. llama.cpp's llama serve and Splash. On duplicate model ids the first server wins." },
    defaultModel: { type: "string", label: "Default model", default: "", description: "Model id for new threads, e.g. ggml-org/gpt-oss-20b-GGUF:MXFP4. Empty picks the first model the server lists." },
    splash: { type: "boolean", label: "Use Splash", default: false },
    splashBinary: { type: "string", label: "Splash binary", default: "/opt/homebrew/bin/splash" },
    splashPort: { type: "number", label: "Splash engine port", default: 8010, experimental_schema: z.number().int().min(1).max(65535) },
    splashProxyPort: { type: "number", label: "Splash proxy port", default: 8011, experimental_schema: z.number().int().min(1).max(65535) },
    splashIdleMinutes: { type: "number", label: "Splash idle minutes", default: 10, experimental_schema: z.number().positive().finite() },
  });
  let splash: Awaited<ReturnType<typeof startSplash>> | undefined, splashKey = "", disposed = false;
  // A failed start (e.g. EADDRINUSE) is remembered per settings key so polls and env resolution do not retry it every call.
  let splashFail: { key: string; at: number; error: string } | undefined;
  let lifecycle = Promise.resolve(), stoppedPort = 8010;
  let compatibility: DoctorReport | undefined;
  const syncSplash = (value: Awaited<ReturnType<typeof settings.get>>) => {
    stoppedPort = value.splashPort ?? 8010;
    lifecycle = lifecycle.catch(() => {}).then(async () => {
      const key = JSON.stringify([value.splashBinary, value.splashPort, value.splashProxyPort, value.splashIdleMinutes, serverUrls(value.baseUrl)[0]]);
      if (splash && (!value.splash || key !== splashKey || disposed || compatibility?.splash.binary === value.splashBinary && !compatibility.supported)) { await splash.dispose(); splash = undefined; }
      if (splashFail && (splashFail.key !== key || !value.splash)) splashFail = undefined;
      if (value.splash && !splash && !disposed && !(splashFail && Date.now() - splashFail.at < 60_000)) {
        const report = compatibility?.splash.binary === value.splashBinary ? compatibility : await controls.detect();
        if (!report.supported) { if (splashKey !== key) bb.log.error('Splash not supported on this Mac: ' + report.supportMessage); splashKey = key; return; }
        if (disposed) return;
        try {
          splash = await startSplash({ binary: value.splashBinary, port: value.splashPort, proxyPort: value.splashProxyPort, idleMinutes: value.splashIdleMinutes, llamaUrl: serverUrls(value.baseUrl)[0], dataDir: bb.server.experimental_dataDir + '/plugins/' + bb.pluginId });
          splashKey = key; splashFail = undefined;
        } catch (error) {
          if (!splashFail) bb.log.error('Splash proxy failed: ' + String(error));
          splashFail = { key, at: Date.now(), error: String(error) };
        }
      }
    });
    return lifecycle;
  };
  const processStatus = async () => {
    const value = await settings.get(); await syncSplash(value);
    return splash?.status() ?? {model:null,pid:null,port:value.splashPort,ready:false,idleLeftMs:0,error:splashFail?.error ?? null};
  };
  const controls = splashControls({
    settings: async () => { const value = await settings.get(); return {...value, baseUrl:serverUrls(value.baseUrl)[0]}; },
    process: () => splash?.status() ?? {model:null,pid:null,port:stoppedPort,ready:false,idleLeftMs:0,error:splashFail?.error ?? null},
    restart: async id => { await processStatus(); if (!splash) throw Error(splashFail?.error ?? 'Enable Splash first.'); await splash.restart(id); },
    log: line => bb.log.info(line), onDetected: report => { compatibility = report; }, ...testing,
  });
  const ok = {ok:true as const};
  // The shim's data dir (host.ts gets it from the bridge); the usage journal lives next to its sessions.
  const bridgeDir = () => bb.server.experimental_dataDir + '/plugins/' + bb.pluginId + '/bridge-data';
  const journal = (source: 'tool' | 'cli', threadId: string | undefined, result: { model: string; usage: unknown; durationMs: number; ttftMs: number | null }) =>
    appendUsage(bridgeDir(), { source, threadId: threadId ?? null, providerThreadId: null, model: result.model, engine: result.model.startsWith('splash/') ? 'splash' : 'llama', ...llamaCounts(result.usage), durationMs: result.durationMs, ttftMs: result.ttftMs }, line => bb.log.error(line));
  bb.rpc.register(usageRpcContract, { 'usage.list': input => listUsage(bridgeDir(), input?.after, input?.limit) });
  bb.rpc.register(settingsRpcContract, {
    async splashStatus() { await processStatus(); return controls.status(); },
    async splashDownload({model}) { await controls.validate(model); void controls.download(model).catch(error => bb.log.error(String(error))); return ok; },
    async splashCancel({model}) { await controls.cancel(model); return ok; },
    async splashDelete({model}) { await controls.remove(model); return ok; },
    async splashRestart({model}) { await controls.restart(model); return ok; },
    setContext({model,tokens}) { return controls.context(model,tokens); },
    doctor(input) { return controls.detect(input?.force); },
    installSplash({command,confirmed}) { void controls.install(command,confirmed).catch(error => bb.log.error(String(error))); return ok; },
  });
  const ready = settings.get().then(syncSplash);
  void ready.catch(error => bb.log.error('Splash proxy failed: ' + String(error)));
  settings.onChange(value => { void syncSplash(value).catch(error => bb.log.error('Splash proxy failed: ' + String(error))); });
  bb.onDispose(async () => { disposed = true; await controls.dispose(); await ready.catch(() => {}); await lifecycle.catch(() => {}); await splash?.dispose(); });
  bb.providers.register({
    id: PROVIDER_ID, displayName: "Local models", icon: "./icons/local-models.svg",
    strings: {
      signInHint: "Start the local model server (llama serve) on this machine, then refresh.",
      expiredHint: "Start the local model server (llama serve) on this machine, then refresh.",
      installUrl: "https://github.com/ggml-org/llama.cpp",
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false, supportsNativeUserQuestion: false,
      supportsManualCompaction: false, supportsThreadArchive: false, supportsThreadRename: false,
      fork: "none", permissionModes: ["accept-edits", "full"], reasoningLevels: ["none", "low", "medium", "high", "xhigh"],
    },
    reasoningLevels: ["none", "low", "medium", "high", "xhigh"].map(id => ({ id, label: id === "xhigh" ? "Extra high" : id[0].toUpperCase() + id.slice(1) })),
    models: { scope: "host" }, completedTurnDisplay: "flat", composerActions: [],
    deriveProviderOptions: context => ({
      baseUrl: effectiveBaseUrl(context.settings), splash: context.settings.splash === true,
      ...(context.settings.splash === true ? {splashProxyPort:context.settings.splashProxyPort ?? 8011} : {}),
      defaultModel: typeof context.settings.defaultModel === "string" ? context.settings.defaultModel : "",
    }),
  });
  // Model listing receives env vars but no providerOptions, so the settings travel this way too.
  bb.providers.experimental_contributeEnv(PROVIDER_ID, async () => {
    const value = await settings.get(), { defaultModel } = value;
    await syncSplash(value);
    return [
      { name: "LM_SPLASH", value: value.splash ? "1" : "0", reason: "Prefer verified Splash variants" },
      ...(value.splash ? [{ name: "LM_SPLASH_PROXY_PORT", value: String(value.splashProxyPort), reason: "Configured Splash proxy port" }] : []),
      { name: "LM_BASE_URL", value: effectiveBaseUrl(value), reason: "Local model server for model listing" },
      ...(typeof defaultModel === "string" && defaultModel ? [{ name: "LM_DEFAULT_MODEL", value: defaultModel, reason: "Default model for new threads" }] : []),
    ];
  });
  const client = async () => {
    const value = await settings.get();
    await syncSplash(value);
    return router(effectiveBaseUrl(value), String(value.defaultModel || ''), bridgeDir(), value.splash);   // the shim writes model-caps.json into the provider bridge's data dir
  };
  const slots = async (method: string, input: Record<string, unknown>) => bb.sdk.plugins.callRpc({pluginId:'slots',method,input:(method==='acquire'?{...input,hostId:(await bb.sdk.system.config()).primaryHostId}:input) as any,outputSchema:z.any(),signal:AbortSignal.timeout(10000)}) as Promise<any>;
  const signal = (parent: AbortSignal | undefined, timeout = 20*60000) => AbortSignal.any([...(parent ? [parent] : []), AbortSignal.timeout(timeout)]);
  bb.agents.registerTool({
    name: 'local_models_ask',
    description: 'One-shot prompt (no tools) to a local llama.cpp model: private and free but slow; for summaries, drafts, classification. Queues behind other Machine Slots local-model work and fails after 20 minutes.',
    parameters: z.object({prompt:z.string().min(1).max(200000),model:z.string().optional().describe('Model id from `bb local-models status`, e.g. ggml-org/gpt-oss-20b-GGUF:MXFP4; omit for the default model'),system:z.string().optional().describe('System prompt text'),max_tokens:z.number().int().min(1).max(8192).default(1024).describe('Output token limit, reasoning included'),effort:z.enum(['none','low','medium','high','xhigh']).optional().describe('Reasoning level; omit for the model default')}),
    presentation: {label:{pending:'Asking local model',completed:'Asked local model'}},
    async execute(input,ctx) {
      try {const abort=signal(ctx.signal);return (await withSlot(slots,ctx.threadId,'local_models_ask · '+(input.model??'default model'),abort,async()=>{const result=await (await client()).ask(input,abort);void journal('tool',ctx.threadId,result);return result;},line=>bb.log.info(line))).content;}
      catch(error) {return {content:[{type:'text' as const,text:'Local model request failed: '+(error instanceof Error ? error.message : String(error))+(error instanceof PluginCliError && error.hint ? ' '+error.hint : '')}],isError:true};}
    },
  });
  bb.agents.configure(context => ({tools:context.provider.id === PROVIDER_ID ? [] : ['local_models_ask'],skills:['local-models']}));
  const json = {type:'boolean' as const,description:'Print JSON'};
  bb.cli.register(defineCli({name:'local-models',summary:'Inspect and query the local model router',commands:{
    status:cliCommand({summary:'Show router and model status',options:{json},async run({options},ctx){
      const result=await (await client()).status(signal(ctx.signal,10000));
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):result.models.map(m=>m.id+' · '+m.displayName+' · '+m.status+' · context '+(m.contextSize??'Splash default')+(m.reasoningLevels?' · reasoning '+(m.reasoningLevels.join(', ')||'not adjustable'):'')).join('\n'))+'\n'};
    }}),
    ask:cliCommand({summary:'Send one prompt without tools',positionals:[{name:'prompt',description:'Prompt text',required:true}],options:{json,model:{type:'string',description:'Model id'},system:{type:'string',description:'System text'},'max-tokens':{type:'integer',min:1,max:8192,default:1024,description:'Output token limit'},effort:{type:'enum',values:REASONING_EFFORTS,description:'Reasoning level'},timeout:{type:'duration',defaultUnit:'m',default:1200000,min:1,max:2147483647,description:'Request timeout such as 90s or 20m; a bare number means minutes. Default 20m (shown in ms)'}},async run({options,positionals},ctx){
      const abort=signal(ctx.signal,options.timeout),result=await withSlot(slots,ctx.threadId,'bb local-models ask · '+(options.model??'default model'),abort,async()=>(await client()).ask({prompt:positionals.prompt,model:options.model,system:options.system,max_tokens:options['max-tokens'],effort:options.effort},abort),line=>bb.log.info(line));
      void journal('cli',ctx.threadId,result);
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):result.content)+'\n'};
    }}),
    'splash-setup':cliCommand({summary:'Download and verify a Splash draft, or pull a model for Splash outside Llama.app',positionals:[{name:'model',description:'Llama.app model id, or an upstream GGUF such as unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_M',required:true}],async run({positionals},ctx){
      // A pull downloads many GB; no 20-minute cap, only the caller's cancellation.
      const path=await controls.download(positionals.model,ctx.signal).catch(error=>{throw new PluginCliError(String(error),{code:'splash_setup_failed',hint:'Use a supported model from the Splash settings tables; `bb local-models splash-models` lists pulled ones.'});});
      return {exitCode:0,stdout:'Ready: '+path+'\n'};
    }}),
    'splash-models':cliCommand({summary:'List models pulled for Splash outside Llama.app, with sizes and drafts',options:{json},async run({options}){
      const {managed,modelsDir}=await controls.status(),gb=(bytes:number|null)=>bytes===null?'?':(bytes/1e9).toFixed(2)+' GB';
      return {exitCode:0,stdout:(options.json?JSON.stringify({modelsDir,models:managed}):[modelsDir,...managed.map(m=>m.id+' · '+m.gguf.state+' '+gb(m.gguf.done)+(m.gguf.error?' ('+m.gguf.error+')':'')+' · draft '+(m.draft?.state??'none')+' · '+(m.vision?'vision':'text only')+' · '+m.path)].join('\n'))+'\n'};
    }}),
    'splash-delete':cliCommand({summary:'Delete a pulled Splash model (and its draft when unused), or a Llama.app model\'s Splash draft',positionals:[{name:'model',description:'Model id from splash-models or the Splash settings table',required:true}],async run({positionals}){
      await controls.remove(positionals.model).catch(error=>{throw new PluginCliError(String(error),{code:'splash_delete_failed',hint:'Stop Splash with `bb local-models unload splash/<id>` first if the model is running.'});});
      return {exitCode:0,stdout:'Deleted '+positionals.model+'\n'};
    }}),
    'splash-status':cliCommand({summary:'Show the supervised Splash process',options:{json},async run({options}){
      const result=await processStatus();
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):'Splash: '+(result.model??'stopped')+' · pid '+(result.pid??'-')+' · port '+result.port+' · idle left '+Math.ceil(result.idleLeftMs/1000)+' s'+(result.error?' · '+result.error:''))+'\n'};
    }}),
    context:cliCommand({summary:'Set a model context in models.user.ini',positionals:[{name:'model',description:'Llama.app model id',required:true},{name:'tokens',description:'Positive token count or default',required:true}],async run({positionals}){
      if (positionals.tokens !== 'default' && !/^[1-9]\d*$/.test(positionals.tokens)) throw new PluginCliError('Use a positive integer or default.',{code:'invalid_context'});
      const result=await controls.context(positionals.model,positionals.tokens==='default'?null:Number(positionals.tokens));
      return {exitCode:0,stdout:'Context saved; applies to Splash on next start and to Llama.app after restarting it.'+(result.warning?'\n'+result.warning:'')+'\n'};
    }}),
    doctor:cliCommand({summary:'Detect local model requirements',options:{json},async run({options}){
      const result=await controls.detect();
      return {exitCode:0,stdout:(options.json?JSON.stringify(result):[
        result.machine.chip+' · '+result.machine.arch+' · macOS '+result.machine.osVersion+' · '+(result.machine.memoryBytes/1024**3).toFixed(1)+' GiB unified memory',
        result.supportMessage, 'Llama.app: '+(result.llama.installed?result.llama.version??'installed':'missing; '+result.llama.downloadUrl)+' · router '+(result.llama.reachable?'reachable':'down; launch Llama.app'),
        'Homebrew: '+(result.brew.path??'missing; '+result.brew.url+'\n'+result.brew.bootstrap),
        'Splash: '+(result.splash.version??'missing')+(result.splash.outdated?' · update available':'')+(result.splash.error?' · '+result.splash.error:'')+(result.splash.updateError?' · '+result.splash.updateError:''),
      ].join('\n'))+'\n'};
    }}),
    'install-splash':cliCommand({summary:'Explicitly install or update Splash with Homebrew',async run(){
      const report=await controls.detect(true),command=report.splash.outdated?SPLASH_UPDATE:SPLASH_INSTALL;
      const output=await controls.install(command,true);
      return {exitCode:0,stdout:command+'\n'+output+'\n'};
    }}),
    unload:cliCommand({summary:'Unload one model, or every loaded model with --all; from a thread, waits for running local-model work',positionals:[{name:'model',description:'Model id from status; omit only with --all'}],options:{all:{type:'boolean',description:'Unload every loaded model, including ones other threads use'}},async run({options,positionals},ctx){
      if(options.all&&positionals.model)throw new PluginCliError('Pass a model id or --all, not both.',{code:'invalid_arguments',hint:'Drop --all to unload only '+positionals.model+'.'});
      // From a thread, take a local-model Slots use first so the unload never pulls a model out from under a running request.
      const abort=signal(ctx.signal),result=await withSlot(slots,ctx.threadId,'bb local-models unload · '+(options.all?'all':positionals.model),abort,async()=>(await client()).unload(positionals.model,options.all,signal(abort,10000)),line=>bb.log.info(line));
      return {exitCode:0,stdout:JSON.stringify(result)+'\n'};
    }}),
  }}));
}
