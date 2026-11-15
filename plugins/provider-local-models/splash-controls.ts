import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DRAFTS_DIR, draftMetadata, setupSplash, splashFamily, verifiedDraft } from './splash.ts';
import { ggufInfo, llamaModels, memoryWarning, MODELS_INI, setContext, USER_INI } from './llama-config.ts';
import { doctor, runCommand, SPLASH_INSTALL, SPLASH_UPDATE, type DoctorOptions, type DoctorReport, type RunCommand } from './requirements.ts';

type ProcessStatus = { model: string | null; pid: number | null; port: number; ready: boolean; idleLeftMs: number; error: string | null };
type DraftState = { state: 'missing' | 'downloading' | 'ready' | 'error'; done: number; total: number | null; error: string | null };
type Job = { abort: AbortController; promise: Promise<string>; progress: DraftState };
type Settings = { splashBinary: string; baseUrl: string; splashPort: number };
export function splashControls(options: {
  settings: () => Promise<Settings>; process: () => ProcessStatus; restart: (id: string) => Promise<void>; log: (line: string) => void;
  modelsIni?: string; userIni?: string; draftsDir?: string; fetcher?: typeof fetch; run?: RunCommand; doctorOptions?: Partial<DoctorOptions>; onDetected?: (report: DoctorReport) => void;
}) {
  const modelsIni = options.modelsIni ?? MODELS_INI, userIni = options.userIni ?? USER_INI, draftsDir = options.draftsDir ?? DRAFTS_DIR, fetcher = options.fetcher ?? fetch;
  const deleting = new Set<string>();
  const jobs = new Map<string, Job>(), metadata = new Map<string, ReturnType<typeof draftMetadata>>(), lifetime = new AbortController();
  let disposed = false, installJob: Promise<void> | undefined;
  const installation: { running: boolean; command: string | null; output: string; error: string | null } = { running: false, command: null, output: '', error: null };
  function family(id: string) { const value = splashFamily(id); if (!value) throw Error('Unsupported Splash family: ' + id); return value; }
  async function known(id: string) { if (!(await llamaModels(modelsIni, userIni)).some(model => model.id === id)) throw Error('Llama.app model not found'); }
  function source(id: string) {
    const key = family(id);
    if (!metadata.has(key)) metadata.set(key, draftMetadata(id, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]), fetcher).catch(error => { setTimeout(() => metadata.delete(key), 60000).unref(); throw error; }));
    return metadata.get(key)!;
  }
  async function inspectDraft(id: string): Promise<DraftState> {
    const key = family(id), job = jobs.get(key);
    if (job?.progress.state === 'downloading' || job?.progress.state === 'error') return { ...job.progress };
    const dir = join(draftsDir, key + '-DFlash2');
    if (await verifiedDraft(dir)) { const size = (await stat(join(dir, 'model.safetensors'))).size; return { state: 'ready', done: size, total: size, error: null }; }
    try { const info = await source(id); return { state: 'missing', done: 0, total: info.size, error: null }; }
    catch (error) { return { state: 'error', done: 0, total: null, error: String(error) }; }
  }
  async function status() {
    const models = await llamaModels(modelsIni, userIni);
    return {
      process: options.process(), installation: { ...installation, output: installation.output.slice(-20000) }, userIni,
      models: await Promise.all(models.map(async model => {
        const supported = !!splashFamily(model.id), info = await ggufInfo(model.model).catch(() => null);
        return { id: model.id, supported, ggufPresent: await stat(model.model).then(s => s.isFile(), () => false), sourceRepo: supported ? 'incoai/' + splashFamily(model.id) + '-DFlash2' : null,
          draft: supported ? await inspectDraft(model.id) : null, context: model.context_length ?? null, contextSource: model.contextSource, nativeContext: info?.nativeContext ?? null,
          warning: info && model.context_length ? memoryWarning(info.size, info.kvBytesPerToken, model.context_length) : null };
      })),
    };
  }
  async function download(id: string, signal?: AbortSignal) {
    if (disposed) throw Error('Plugin is stopping');
    const key = family(id); await known(id); const existing = jobs.get(key);
    if (disposed || deleting.has(key)) throw Error('Draft is being deleted or plugin is stopping');
    if (existing?.progress.state === 'downloading') return existing.promise;
    const abort = new AbortController(), progress: DraftState = { state: 'downloading', done: 0, total: null, error: null };
    const combined = AbortSignal.any([lifetime.signal, abort.signal, ...(signal ? [signal] : [])]);
    const promise = setupSplash(id, options.log, combined, draftsDir, fetcher, (done, total) => { progress.done = done; progress.total = total; })
      .then(dir => { progress.state = 'ready'; return dir; }, error => { progress.state = abort.signal.aborted ? 'missing' : 'error'; progress.error = abort.signal.aborted ? null : String(error); options.log('Splash draft: ' + String(error)); throw error; });
    jobs.set(key, { abort, promise, progress }); return promise;
  }
  async function cancel(id: string) {
    const job = jobs.get(family(id));
    if (job?.progress.state === 'downloading') { job.abort.abort(); await job.promise.catch(() => {}); }
  }
  async function remove(id: string) {
    await known(id); const key = family(id);
    if (options.process().model && splashFamily(options.process().model!) === key) throw Error('Stop Splash before deleting its active draft.');
    if (deleting.has(key)) throw Error('Draft is already being deleted');
    deleting.add(key);
    try {
      await cancel(id);
      await rm(join(draftsDir, key + '-DFlash2'), { recursive: true, force: true }); jobs.delete(key); metadata.delete(key);
      options.log('Deleted Splash draft incoai/' + key + '-DFlash2');
    } finally { deleting.delete(key); }
  }
  // Memoized per binary and server for 60 s; doctor spawns ~7 processes and takes about a second.
  let detected: { key: string; at: number; report: Promise<DoctorReport> } | undefined;
  const detect = async (force = false) => {
    const settings = await options.settings(), key = settings.splashBinary + '\n' + settings.baseUrl;
    if (!force && detected?.key === key && Date.now() - detected.at < 60000) return detected.report;
    const current = { key, at: Date.now(), report: doctor({ binary: settings.splashBinary, baseUrl: settings.baseUrl, run: options.run, fetcher, ...options.doctorOptions }, lifetime.signal).then(report => { options.onDetected?.(report); return report; }) };
    detected = current; current.report.catch(() => { if (detected === current) detected = undefined; }); return current.report;
  };
  async function install(command: string, confirmed: boolean) {
    if (disposed) throw Error('Plugin is stopping');
    if (!confirmed || ![SPLASH_INSTALL, SPLASH_UPDATE].includes(command)) throw Error('Confirm the exact Splash install command first.');
    if (installJob) throw Error('A Splash installation is already running.');
    // Reserve before detection, so two clicks cannot launch overlapping brew jobs.
    installation.running = true; installation.command = command; installation.output = ''; installation.error = null;
    const job = (async () => {
      const report = await detect(true);
      if (!report.supported) throw Error('Splash not supported on this Mac. ' + report.supportMessage);
      if (!report.brew.path) throw Error('Install Homebrew yourself from https://brew.sh first.');
      if (command === SPLASH_INSTALL && report.splash.installed) throw Error('Splash is already installed; refresh requirements.');
      if (command === SPLASH_UPDATE && (!report.splash.installed || !report.splash.outdated)) throw Error('No Splash update is available; refresh requirements.');
      installation.running = true; installation.command = command; installation.output = ''; installation.error = null;
      options.log(command);
      const result = await (options.run ?? runCommand)(report.brew.path, [command === SPLASH_UPDATE ? 'upgrade' : 'install', 'incoai/tap/splash'], lifetime.signal, text => {
        installation.output = (installation.output + text).slice(-100000); options.log(text);
      });
      if (result.code !== 0) throw Error('Splash installation failed: ' + result.output);
      const after = await detect(true);
      if (!after.splash.installed || !after.supported || after.splash.error) throw Error('Splash installation verification failed: ' + (after.splash.error ?? after.supportMessage));
    })();
    installJob = job;
    try { await job; return installation.output; } catch (error) { installation.error = String(error); options.log(String(error)); throw error; }
    finally { installation.running = false; installJob = undefined; }
  }
  return { status, download, cancel, remove, detect, install,
    async context(id: string, tokens: number | null) { const result = await setContext(id, tokens, modelsIni, userIni); options.log('Context ' + id + ': ' + (tokens ?? 'default')); return { ...result, restartAvailable: options.process().model === 'splash/' + id }; },
    async restart(id: string) { await known(id); await options.restart('splash/' + id); },
    async dispose() { disposed = true; lifetime.abort(); await Promise.allSettled([...jobs.values()].map(job => job.promise).concat(installJob ? [installJob.then(() => '')] : [])); },
  };
}
export type ControlStatus = Awaited<ReturnType<ReturnType<typeof splashControls>['status']>>;
