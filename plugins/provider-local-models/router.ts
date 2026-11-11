import { PluginCliError } from '@get-bb/plugin-sdk';
import { deriveCaps, readCaps, reasoningParams } from './reasoning.ts';
import { displayName } from './models.ts';
// shortcut: server-side fetch to settings.baseUrl assumes the router is reachable from the BB server machine; multi-machine needs a host call like antigravity's hosts.experimental_client.
export function router(baseUrl: string, defaultModel: string, dataDir: string) {
  const base = baseUrl.replace(/\/+$/,''), origin = base.replace(/\/v1$/,'');
  async function request(url: string, signal: AbortSignal, body?: unknown): Promise<any> {
    try {
      const response = await fetch(url,{signal,...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      if (!response.ok) throw new PluginCliError(`Model server answered ${response.status}: ${(await response.text()).slice(0,300)}`,{code:'server_error',hint:'Check the router logs and model availability.'});
      return await response.json();
    } catch (error) {
      if (error instanceof PluginCliError) throw error;
      throw new PluginCliError(signal.aborted ? 'Local model request timed out or was cancelled.' : `Cannot reach the model server at ${base}.`,{code:signal.aborted?'timeout':'server_unreachable',hint:'Check the server URL and that llama serve is running; allow time for cold loads.'});
    }
  }
  async function models(signal: AbortSignal) {
    const body = await request(base+'/models',signal);
    if (!Array.isArray(body.data)) throw new PluginCliError('Invalid model list.',{code:'server_error',hint:'Check the router logs.'});
    return (body.data as any[]).filter((m:any)=>typeof m.id==='string');
  }
  // The --ctx-size the router loads with is the real limit; context_length is the trained one.
  const contextSize=(m:any)=>{const a=m.status?.args,i=Array.isArray(a)?a.indexOf('--ctx-size'):-1,arg=i>=0?Number(a[i+1]):0;return arg>0?arg:m.context_length??m.meta?.n_ctx??null;};
  return {
    async status(signal: AbortSignal) {
      const caps=readCaps(dataDir);
      return {reachable:true,models:(await models(signal)).slice(0,100).map((m:any)=>({id:m.id.slice(0,500),displayName:displayName(m.id).slice(0,500),status:m.status?.value??'unloaded',contextSize:contextSize(m),...(caps[m.id]?{reasoningLevels:[...(caps[m.id].none?['none']:[]),...caps[m.id].levels]}:{})}))};
    },
    async ask(input: {prompt:string;model?:string;system?:string;max_tokens?:number;effort?:string}, signal: AbortSignal) {
      const listed=await models(signal), selected= input.model ? listed.find((m:any)=>m.id===input.model) : listed.find((m:any)=>m.id===defaultModel)??listed.find((m:any)=>m.status?.value==='loaded')??listed[0];
      if (!selected) throw new PluginCliError('Local model not found.',{code:'model_not_found',hint:'Run bb local-models status to see model ids.'});
      let caps;
      if(selected.status?.value==='loaded')try {caps=deriveCaps(await request(origin+'/props?model='+encodeURIComponent(selected.id),signal));}catch {if(signal.aborted)throw new PluginCliError('Request cancelled or timed out.',{code:'timeout',hint:'Try a longer timeout.'});}
      const body=await request(base+'/chat/completions',signal,{model:selected.id,stream:false,messages:[...(input.system?[{role:'system',content:input.system}]:[]),{role:'user',content:input.prompt}],max_tokens:input.max_tokens??1024,...reasoningParams(caps,input.effort)});
      const message=body.choices?.[0]?.message;
      if(!message)throw new PluginCliError('Model server returned no message.',{code:'server_error',hint:'Check the router logs.'});
      return {model:selected.id,content:String(message.content??'').slice(0,20000),usage:body.usage??null,reasoning:String(message.reasoning_content??'').slice(0,20000)};
    },
    async unload(model: string | undefined, all: boolean, signal: AbortSignal) {
      const listed=await models(signal);
      if(!all&&!model)throw new PluginCliError('Specify a model or --all.',{code:'model_not_found',hint:'Run bb local-models status.'});
      const ids=all?listed.map((m:any)=>m.id):[model];
      if(!all&&!listed.some((m:any)=>m.id===model))throw new PluginCliError('Local model not found.',{code:'model_not_found',hint:'Run bb local-models status.'});
      for(const id of ids)await request(origin+'/models/unload',signal,{model:id});
      return {unloaded:ids};
    },
  };
}
