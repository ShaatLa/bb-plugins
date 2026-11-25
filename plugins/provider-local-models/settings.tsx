import { useCallback, useEffect, useRef, useState } from 'react';
import { useRpc, useSettings } from '@get-bb/plugin-sdk/app';
import type { settingsRpcContract } from './settings-contract.ts';
import type { ControlStatus } from './splash-controls.ts';
import type { DoctorReport } from './requirements.ts';

const mb = (bytes: number | null) => bytes === null ? '?' : (bytes / 1024 ** 2).toFixed(1);
const gb = (bytes: number | null) => bytes === null ? '?' : (bytes / 1e9).toFixed(2);
type Transfer = ControlStatus['managed'][number]['gguf'];
const transfer = (value: Transfer | null) => !value ? 'none' : value.state === 'ready' ? 'ready · ' + gb(value.total) + ' GB · sha256 verified' : value.state === 'downloading' ? 'downloading ' + gb(value.done) + ' / ' + gb(value.total) + ' GB' : value.state === 'error' ? value.error ?? 'error' : value.done ? 'partial · ' + gb(value.done) + ' GB; Download resumes' : 'missing';
const name = (id: string) => id.split('/').at(-1)?.replace(/-GGUF(?=:|$)/i, '') ?? id;
function Confirmation({ title, label, confirm, close, children }: { title: string; label: string; confirm: () => void; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="lm-confirm" aria-labelledby="lm-confirm-title" onCancel={close}>
    <h3 id="lm-confirm-title">{title}</h3>{children}
    <div className="lm-actions"><button autoFocus onClick={close}>Cancel</button><button className="lm-danger" onClick={confirm}>{label}</button></div>
  </dialog>;
}
const contextProblem = (value: string, native: number | null) => !native ? 'Native context unknown.' : !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) ? 'Enter a positive whole number.' : Number(value) > native ? 'Max ' + native.toLocaleString() + '.' : '';
// Saves on blur, Enter, page hide and unmount instead of a Save button; invalid input stays in the field with a hint.
function ContextCell({ model, save }: { model: ControlStatus['models'][number]; save: (tokens: number | null) => Promise<void> }) {
  const saved = String(model.context ?? '');
  const [value, setValue] = useState(saved), [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'), [error, setError] = useState(''), [hint, setHint] = useState('');
  const latest = useRef({ value, saved, save, native: model.nativeContext }), sent = useRef(saved), attempt = useRef<number | null>(null);
  latest.current = { value, saved, save, native: model.nativeContext };
  useEffect(() => { setValue(saved); setHint(''); sent.current = saved; }, [saved]);
  const commit = async (tokens: number | null) => {
    attempt.current = tokens; sent.current = tokens === null ? '' : String(tokens); setState('saving'); setError(''); setHint('');
    try { await save(tokens); setState('saved'); if (tokens === null) setValue(latest.current.saved); } catch (error) { sent.current = ''; setState('error'); setError(String(error)); }
  };
  // Disabling or re-rendering during a save must not send the field again, e.g. while Reset is saving.
  const commitValue = () => { if (state === 'saving') return; const next = value.trim(), problem = contextProblem(next, model.nativeContext); setHint(next === saved ? '' : problem); if (next !== saved && next !== sent.current && !problem) void commit(Number(next)); };
  useEffect(() => {
    const flush = () => { const { value, saved, save, native } = latest.current, next = value.trim(); if (next !== saved && next !== sent.current && !contextProblem(next, native)) { sent.current = next; void save(Number(next)).catch(() => { if (sent.current === next) sent.current = ''; }); } };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, []);
  const estimate = model.warning && !model.warning.startsWith('Memory estimate unavailable');
  return <form noValidate onSubmit={event => { event.preventDefault(); commitValue(); }}>
    <div className="lm-actions"><input aria-label={'Context tokens for ' + model.id} aria-invalid={!!hint} type="number" min="1" max={model.nativeContext ?? undefined} step="1" value={value} onChange={event => { setValue(event.target.value); setHint(''); if (state !== 'saving') setState('idle'); }} onBlur={commitValue} readOnly={state === 'saving'} disabled={!model.nativeContext} />
      {model.contextSource === 'user file' && <button type="button" disabled={state === 'saving'} onMouseDown={event => event.preventDefault()} onClick={() => { void commit(null); }}>Reset</button>}
      <span role="status">{state === 'saving' ? 'Saving…' : state === 'saved' ? <span className="lm-ok">Saved</span> : ''}</span></div>
    <small>{model.contextSource} · native {model.nativeContext?.toLocaleString() ?? 'unknown (editing disabled)'}</small>
    {hint && <p role="alert">{hint}</p>}
    {state === 'error' && <p role="alert">Not saved: {error} <button type="button" onClick={() => { void commit(attempt.current); }}>Retry</button></p>}
    {model.warning && (estimate ? <p className="lm-warning">Warning: {model.warning}</p> : <small>{model.warning}</small>)}
  </form>;
}
const State = ({ kind, children }: { kind: 'ok' | 'bad' | 'warn'; children: string }) => <span className={'lm-state lm-' + kind}>{kind === 'ok' ? '✓' : kind === 'bad' ? '✕' : '!'} {children}</span>;
const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/v1$/, '');
const ago = (at: number, now: number) => { const minutes = Math.floor((now - at) / 60000); return minutes < 1 ? 'just now' : minutes + ' min ago'; };
export function SplashSettings() {
  const { call } = useRpc<typeof settingsRpcContract>(), settings = useSettings();
  const [data, setData] = useState<ControlStatus | null>(null), [requirements, setRequirements] = useState<DoctorReport | null>(null);
  const [error, setError] = useState(''), [command, setCommand] = useState<string | null>(null), [installPending, setInstallPending] = useState(false);
  const [restart, setRestart] = useState<string | null>(null), [deleting, setDeleting] = useState<string | null>(null), [removing, setRemoving] = useState<string | null>(null), [pull, setPull] = useState(''), [pending, setPending] = useState<string[]>([]), [clock, setClock] = useState(0);
  const installed = useRef(false), mounted = useRef(true), latest = useRef<ControlStatus | null>(null), received = useRef(Date.now()), sequence = useRef(0);
  const detect = useCallback(async (force = false) => { const report = await call('doctor', force ? { force: true } : null); if (mounted.current) setRequirements(report); }, [call]);
  const refresh = useCallback(async () => {
    const request = ++sequence.current, status = await call('splashStatus', null); if (!mounted.current || request !== sequence.current) return;
    latest.current = status; received.current = Date.now(); setData(status); setError('');
    if (installed.current && !status.installation.running) { setInstallPending(false); void detect().catch(error => setError(String(error))); }
    installed.current = status.installation.running;
  }, [call, detect]);
  useEffect(() => {
    mounted.current = true; let alive = true, running = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!alive || document.hidden || running) return; running = true; try { await refresh(); } catch (error) { if (alive) setError(String(error)); } finally { running = false; clearTimeout(timer); if (alive && !document.hidden) { const s = latest.current, hot = s && (s.installation.running || !!s.process.model && !s.process.ready || s.models.some(model => model.draft?.state === 'downloading') || s.managed.some(model => model.gguf.state === 'downloading' || model.draft?.state === 'downloading')); timer = setTimeout(poll, hot ? 2000 : 10000); } } };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    document.addEventListener('visibilitychange', visible);
    void poll(); void detect().catch(error => { if (alive) setError(String(error)); });
    const ticker = setInterval(() => setClock(Date.now()), 6000);
    return () => { alive = false; mounted.current = false; sequence.current++; clearTimeout(timer); clearInterval(ticker); document.removeEventListener('visibilitychange', visible); };
  }, [refresh, detect]);
  const serverKey = String(settings.values?.baseUrl ?? '') + '\n' + String(settings.values?.splashBinary ?? ''), firstKey = useRef(serverKey);
  useEffect(() => { if (serverKey === firstKey.current) return; firstKey.current = serverKey; void detect().catch(error => setError(String(error))); }, [serverKey, detect]);
  const action = async (key: string, run: () => Promise<unknown>) => {
    setPending(current => [...current, key]); setError(''); try { await run(); await refresh(); } catch (error) { if (mounted.current) { setError(String(error)); setInstallPending(false); } } finally { if (mounted.current) setPending(current => current.filter(value => value !== key)); }
  };
  const splashOn = !!settings.values?.splash, now = clock || Date.now();
  const runningFamily = (id: string) => !!data?.process.model && data.process.model.split('/').at(-1)?.split(':')[0] === id.split('/').at(-1)?.split(':')[0];
  const splashState = !data ? '' : data.process.model ? name(data.process.model) + (data.process.ready ? ' running' : ' starting') + ' · stops after ' + (Math.max(0, data.process.idleLeftMs - now + received.current) / 60000).toFixed(0) + ' idle min' : splashOn ? 'stopped, starts when a thread needs it' : 'off in the settings above';
  return <div className="lm-settings">
    {error && <p role="alert" className="lm-page-alert">{error}</p>}
    <section aria-labelledby="lm-health"><div className="lm-actions"><h3 id="lm-health">Health</h3><button disabled={pending.length > 0} onClick={() => { void action('requirements', () => detect(true)); }}>{pending.includes('requirements') ? 'Checking…' : 'Check again'}</button></div>
      {!requirements ? <p role="status">Checking servers and requirements…</p> : <>
        <ul className="lm-health">
          {requirements.servers.map((server, index) => <li key={server.url}>{server.reachable ? <State kind="ok">OK</State> : <State kind="bad">Down</State>} {shortUrl(server.url)}{server.reachable ? ' · ' + server.models + (server.models === 1 ? ' model' : ' models') : index === 0 && requirements.llama.installed ? ' — launch Llama.app' : ' — start its server or check the network'}</li>)}
          <li>{requirements.llama.installed ? <><State kind="ok">OK</State> Llama.app {requirements.llama.version ?? ''}</> : <><State kind="bad">Missing</State> Llama.app — <a href={requirements.llama.downloadUrl} target="_blank" rel="noreferrer">get Llama.app</a></>}</li>
          <li>{requirements.brew.path ? <><State kind="ok">OK</State> Homebrew</> : <><State kind="bad">Missing</State> Homebrew — <a href={requirements.brew.url} target="_blank" rel="noreferrer">get it at brew.sh</a>; run this in Terminal:<pre>{requirements.brew.bootstrap}</pre></>}</li>
          <li>{!requirements.supported ? <><State kind="warn">Not supported</State> Splash on this Mac · Llama only</> : !requirements.splash.installed ? <><State kind="bad">Missing</State> Splash</> : <>{requirements.splash.outdated ? <State kind="warn">Update</State> : <State kind="ok">OK</State>} {requirements.splash.version ?? 'Splash'}{splashState && ' · ' + splashState}</>}
            {requirements.supported && requirements.brew.path && (!requirements.splash.installed || requirements.splash.outdated) && <> <button disabled={pending.length > 0 || installPending || data?.installation.running} onClick={() => setCommand(requirements.splash.installed ? 'brew upgrade incoai/tap/splash' : 'brew install incoai/tap/splash')}>{requirements.splash.installed ? 'Update Splash' : 'Install Splash'}</button></>}</li>
        </ul>
        {requirements.splash.error && <p role="alert">{requirements.splash.error}</p>}{requirements.splash.updateError && <p role="alert">Update check: {requirements.splash.updateError}</p>}{data?.process.error && <p role="alert">{data.process.error}</p>}
        <small>Checked {ago(requirements.checkedAt, now)}</small>
        <details open={!requirements.supported}><summary>{requirements.machine.chip} · {(requirements.machine.memoryBytes / 1024 ** 3).toFixed(0)} GiB · paths</summary>
          <p>{requirements.machine.arch} · macOS {requirements.machine.osVersion || 'unknown'} · {requirements.supportMessage}</p>
          <p><small>Splash: {requirements.splash.binary}{requirements.brew.path && <><br />Homebrew: {requirements.brew.path}</>}</small></p></details>
      </>}
      {data?.installation.command && <><p>{data.installation.running || installPending ? 'Running: ' : 'Command: '}<code>{data.installation.command}</code></p><pre aria-live="polite" tabIndex={0}>{data.installation.output}</pre>{data.installation.error && <p role="alert">{data.installation.error}</p>}</>}
    </section>
    <section aria-labelledby="lm-models"><h3 id="lm-models">Llama.app models and Splash drafts</h3>
      {!data ? <p role="status">Loading models…</p> : <>
        {restart && <p>Context saved for {name(restart)}. <button disabled={pending.length > 0} onClick={() => { void action('restart', async () => { await call('splashRestart', {model:restart}); setRestart(null); }); }}>{pending.includes('restart') ? 'Restarting…' : 'Restart Splash now'}</button></p>}
        <p>Context is saved to <code>{data.userIni}</code> when you leave the field or press Enter. Splash uses it on its next start, Llama.app after a restart. Memory estimates include the draft and engine.</p>
        <div className="lm-table"><table><thead><tr><th>Model</th><th>Splash draft</th><th>Context size</th><th>Actions</th></tr></thead><tbody>{data.models.map(model => {
          const busy = pending.some(value => value.startsWith(model.id + ':')), draft = model.draft;
          return <tr key={model.id}>
            <th scope="row" title={model.id}>{name(model.id)}{!model.ggufPresent && <p>GGUF missing</p>}</th>
            <td>{!model.supported ? <small>Llama.app only (no Splash draft)</small> : draft?.state === 'ready' ? 'ready · ' + mb(draft.total) + ' MB' : draft?.state === 'downloading' ? 'downloading ' + mb(draft.done) + ' / ' + mb(draft.total) + ' MB' : <>{draft?.error ?? (draft?.done ? 'partial · ' + mb(draft.done) + ' / ' + mb(draft.total) + ' MB' : 'missing · ' + mb(draft?.total ?? null) + ' MB')}<br /><a href={'https://huggingface.co/' + model.sourceRepo} target="_blank" rel="noreferrer">{model.sourceRepo}</a></>}</td>
            <td><ContextCell model={model} save={async tokens => { const result = await call('setContext', {model:model.id,tokens}); if (result.restartAvailable) setRestart(model.id); await refresh(); }} /></td>
            <td>{model.supported && <div className="lm-actions">{draft?.state === 'downloading' ? <button disabled={busy} onClick={() => { void action(model.id + ':cancel', () => call('splashCancel', {model:model.id})); }}>{pending.includes(model.id + ':cancel') ? 'Cancelling…' : 'Cancel'}</button>
              : <>{draft?.state !== 'ready' && model.ggufPresent && requirements?.supported && <button disabled={busy} onClick={() => { void action(model.id + ':download', () => call('splashDownload', {model:model.id})); }}>{pending.includes(model.id + ':download') ? 'Downloading…' : draft?.done ? 'Resume draft' : 'Download draft'}</button>}
                {(draft?.state === 'ready' || draft?.state === 'error' || !!draft?.done) && <button disabled={busy || runningFamily(model.id)} title={runningFamily(model.id) ? 'Splash is running this model' : undefined} onClick={() => { if (draft?.state === 'ready') setDeleting(model.id); else void action(model.id + ':delete', () => call('splashDelete', {model:model.id})); }}>{pending.includes(model.id + ':delete') ? 'Deleting…' : 'Delete draft'}</button>}</>}</div>}</td>
          </tr>; })}</tbody></table></div>
        {!data.models.length && <p>No models in Llama.app’s generated configuration. Download models in Llama.app first.</p>}
      </>}
    </section>
    {data && <section aria-labelledby="lm-managed"><h3 id="lm-managed">Models outside Llama.app</h3>
      <p>Pulled with their Splash drafts into <code>{data.modelsDir}</code>; size and sha256 are verified. Delete model removes the GGUF and, when no other model of its family uses it, the draft. Splash picks their context window.</p>
      {requirements?.supported && <form className="lm-actions lm-pull" onSubmit={event => { event.preventDefault(); const model = pull.trim(); if (!model) return; setPull(''); void action(model + ':download', () => call('splashDownload', {model})); }}>
        <label htmlFor="lm-pull-id">Hugging Face GGUF id</label>
        <input id="lm-pull-id" placeholder="owner/Model-GGUF:Q4_K_M" value={pull} onChange={event => setPull(event.target.value)} required />
        <button>Download model</button>
      </form>}
      {!data.managed.length ? <p>No models pulled outside Llama.app.</p> : <div className="lm-table"><table><thead><tr><th>Model</th><th>Files</th><th>Actions</th></tr></thead><tbody>{data.managed.map(model => {
        const busy = pending.some(value => value.startsWith(model.id + ':')), downloading = model.gguf.state === 'downloading' || model.draft?.state === 'downloading';
        const incomplete = model.unfinished || model.gguf.state !== 'ready' || !!model.draft && model.draft.state !== 'ready', running = data.process.model === 'splash/' + model.id;
        return <tr key={model.id}><th scope="row" title={model.path}>{name(model.id)}<br /><small>{model.id}</small></th>
          <td>GGUF: {transfer(model.gguf)}<br />Draft: {transfer(model.draft)}<br />Images: {model.vision ? 'projector ready' : 'text only'}<br /><small>{model.path}</small></td>
          <td><div className="lm-actions">{downloading ? <button disabled={busy} onClick={() => { void action(model.id + ':cancel', () => call('splashCancel', {model:model.id})); }}>{pending.includes(model.id + ':cancel') ? 'Cancelling…' : 'Cancel'}</button>
            : incomplete && requirements?.supported && <button disabled={busy} onClick={() => { void action(model.id + ':download', () => call('splashDownload', {model:model.id})); }}>Download missing files</button>}
            {!downloading && <button disabled={busy || running} title={running ? 'Splash is running this model' : undefined} onClick={() => setRemoving(model.id)}>{pending.includes(model.id + ':delete') ? 'Deleting…' : 'Delete model'}</button>}</div></td></tr>;
      })}</tbody></table></div>}
    </section>}
    {deleting && <Confirmation title="Delete Splash draft" label="Delete draft" close={() => setDeleting(null)} confirm={() => { const model = deleting; setDeleting(null); void action(model + ':delete', () => call('splashDelete', {model})); }}><p>Delete the downloaded draft for {name(deleting)}? Downloading it again takes a while.</p></Confirmation>}
    {removing && <Confirmation title="Delete Splash model" label="Delete model" close={() => setRemoving(null)} confirm={() => { const model = removing; setRemoving(null); void action(model + ':delete', () => call('splashDelete', {model})); }}><p>Delete {removing} and its downloaded files? Downloading it again takes a while.</p></Confirmation>}
    {command && <Confirmation title="Confirm Splash installation" label="Run command" close={() => setCommand(null)} confirm={() => { const selected = command as 'brew install incoai/tap/splash' | 'brew upgrade incoai/tap/splash'; setCommand(null); setInstallPending(true); installed.current = true; void action('install', () => call('installSplash', {command:selected,confirmed:true})); }}><p>This runs the following command on the BB server machine:</p><pre>{command}</pre>
      <p>No sudo is used. Output is shown here and recorded in the plugin log.</p></Confirmation>}
  </div>;
}
