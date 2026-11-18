import { PluginCliError } from '@get-bb/plugin-sdk';
import { setTimeout as wait } from 'node:timers/promises';
import { deriveCaps, readCaps, reasoningParams } from './reasoning.ts';
import { displayName, serverUrls, preferSplash } from './models.ts';
// shortcut: server-side fetch to settings.baseUrl assumes the router is reachable from the BB server machine; multi-machine needs a host call like antigravity's hosts.experimental_client.
export function router(baseUrl: string, defaultModel: string, dataDir: string, splash = false, retryMs = 2000) {
  const bases = serverUrls(baseUrl), origin = (base: string) => base.replace(/\/v1$/,'');
  async function request(url: string, signal: AbortSignal, body?: unknown, read: (response: Response) => Promise<any> = response => response.json()): Promise<any> {
    try {
      let response = await fetch(url,{signal,...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      // The Splash proxy answers 503 while it starts the engine; wait for it like the shim does.
      while (response.status === 503 && body !== undefined) { await response.body?.cancel(); await wait(retryMs, undefined, {signal}); response = await fetch(url,{signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); }
      if (!response.ok) throw new PluginCliError(`Model server answered ${response.status}: ${(await response.text()).slice(0,300)}`,{code:'server_error',hint:'Check the router logs and model availability.'});
      return await read(response);
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      throw new PluginCliError(signal.aborted ? 'Local model request timed out or was cancelled.' : `Cannot reach the model server at ${new URL(url).origin}.`,{code:signal.aborted?'timeout':'server_unreachable',hint:'Check the server URL and that llama serve is running; allow time for cold loads.'});
    }
  }
  // Streaming keeps headers arriving with the first token; a non-streaming completion would hit undici's 300 s headers timeout.
  async function readStream(response: Response) {
    const decoder = new TextDecoder(), fail = (message: string) => new PluginCliError(message,{code:'server_error',hint:'Check the router logs.'});
    let buffer = '', content = '', reasoning = '', usage: unknown = null, seen = false, finished = false, firstAt = 0;
    const line = (text: string) => {
      if (!text.startsWith('data:')) return;
      const data = text.slice(5).trim();
      if (data === '[DONE]') { finished = true; return; }
      const chunk = JSON.parse(data);
      if (chunk.error) throw fail(`Model server error: ${String(chunk.error.message ?? JSON.stringify(chunk.error)).slice(0,300)}`);
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) return;
      seen = true;
      if (!firstAt && (choice.delta?.content || choice.delta?.reasoning_content)) firstAt = Date.now();
      content += choice.delta?.content ?? ''; reasoning += choice.delta?.reasoning_content ?? '';
      if (choice.finish_reason) finished = true;
    };
    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
      const lines = (buffer += decoder.decode(part, {stream:true})).split('\n'); buffer = lines.pop()!;
      lines.forEach(line);
    }
    line(buffer + decoder.decode());
    if (!seen) throw fail('Model server returned no message.');
    if (!finished) throw fail('Model server ended the stream early.');
    return {content, reasoning, usage, firstAt};
  }
  // Models from every reachable server, each tagged with its server; the first server wins on duplicate ids.
  async function models(signal: AbortSignal) {
    const lists = await Promise.allSettled(bases.map(async base => {
      const body = await request(base+'/models',signal);
      if (!Array.isArray(body.data)) throw new PluginCliError('Invalid model list.',{code:'server_error',hint:'Check the router logs.'});
      return (body.data as any[]).filter((m:any)=>typeof m.id==='string').map((m:any)=>({...m,base}));
    }));
    if (!lists.some(list => list.status === 'fulfilled')) throw (lists[0] as PromiseRejectedResult).reason;
    return lists.flatMap(list => list.status === 'fulfilled' ? list.value : []).filter((m:any,i,all)=>all.findIndex((o:any)=>o.id===m.id)===i);
  }
  // Servers without router status (e.g. Splash) keep their single model resident, so it reports as loaded.
  // The --ctx-size the router loads with is the real limit; context_length is the trained one.
  const contextSize=(m:any)=>{const a=m.status?.args,i=Array.isArray(a)?a.indexOf('--ctx-size'):-1,arg=i>=0?Number(a[i+1]):0;return arg>0?arg:m.context_length??m.meta?.n_ctx??null;};
  return {
    async status(signal: AbortSignal) {
      const caps=readCaps(dataDir);
      return {reachable:true,models:preferSplash(await models(signal), splash).slice(0,100).map((m:any)=>({id:m.id.slice(0,500),displayName:displayName(m.id).slice(0,500),status:m.status?.value??'loaded',contextSize:contextSize(m),...(caps[m.id]?{reasoningLevels:[...(caps[m.id].none?['none']:[]),...caps[m.id].levels]}:{})}))};
    },
    async ask(input: {prompt:string;model?:string;system?:string;max_tokens?:number;effort?:string}, signal: AbortSignal) {
      const listed=await models(signal), visible=preferSplash(listed,splash), selected= input.model ? listed.find((m:any)=>m.id===input.model) : visible.find((m:any)=>m.id===defaultModel||m.id==='splash/'+defaultModel)??visible.find((m:any)=>m.status?.value==='loaded')??visible[0];
      if (!selected) throw new PluginCliError('Local model not found.',{code:'model_not_found',hint:'Run bb local-models status to see model ids.'});
      let caps;
      if(selected.status?.value==='loaded')try {caps=deriveCaps(await request(origin(selected.base)+'/props?model='+encodeURIComponent(selected.id),signal));}catch {if(signal.aborted)throw new PluginCliError('Request cancelled or timed out.',{code:'timeout',hint:'Try a longer timeout.'});}
      const started=Date.now(),message=await request(selected.base+'/chat/completions',signal,{model:selected.id,stream:true,stream_options:{include_usage:true},messages:[...(input.system?[{role:'system',content:input.system}]:[]),{role:'user',content:input.prompt}],max_tokens:input.max_tokens??1024,...reasoningParams(caps,input.effort)},readStream);
      return {model:selected.id,content:message.content.slice(0,20000),usage:message.usage,reasoning:message.reasoning.slice(0,20000),durationMs:Date.now()-started,ttftMs:message.firstAt?message.firstAt-started:null};
    },
    async unload(model: string | undefined, all: boolean, signal: AbortSignal) {
      const listed=await models(signal);
      if(!all&&!model)throw new PluginCliError('Specify a model or --all.',{code:'model_not_found',hint:'Run bb local-models status.'});
      // --all unloads what is loaded (the router answers 400 for an idle model); servers without status cannot unload.
      const targets=all?listed.filter((m:any)=>m.status?.value==='loaded'):listed.filter((m:any)=>m.id===model);
      if(!all&&!targets.length)throw new PluginCliError('Local model not found.',{code:'model_not_found',hint:'Run bb local-models status.'});
      for(const m of targets)await request(origin(m.base)+'/models/unload',signal,{model:m.id});
      return {unloaded:targets.map((m:any)=>m.id)};
    },
  };
}
