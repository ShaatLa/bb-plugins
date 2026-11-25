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
    <div className="lm-actions"><button autoFocus onClick={close}>Cancel</button><button onClick={confirm}>{label}</button></div>
  </dialog>;
}
function ContextCell({ model, save }: { model: ControlStatus['models'][number]; save: (tokens: number | null) => Promise<void> }) {
  const [value, setValue] = useState(String(model.context ?? '')), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setValue(String(model.context ?? '')); }, [model.context]);
  const change = async (tokens: number | null) => {
    setBusy(true); setError(''); try { await save(tokens); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  return <form onSubmit={event => { event.preventDefault(); if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) { setError('Enter a positive integer.'); return; } void change(Number(value)); }}>
    <div className="lm-actions"><input aria-label={'Context tokens for ' + model.id} type="number" min="1" max={model.nativeContext ?? undefined} step="1" value={value} onChange={event => setValue(event.target.value)} disabled={busy || !model.nativeContext} />
      <button disabled={busy || !model.nativeContext || value === String(model.context ?? '')}>Save</button>
      <button type="button" disabled={busy || model.contextSource !== 'user file'} onClick={() => { void change(null); }}>Default</button></div>
    <small>{model.contextSource} · native {model.nativeContext?.toLocaleString() ?? 'unknown (editing disabled)'}</small>
    {model.warning && <p role="status">{model.warning}</p>}{error && <p role="alert">{error}</p>}
  </form>;
}
export function SplashSettings() {
  const { call } = useRpc<typeof settingsRpcContract>(), settings = useSettings();
  const [data, setData] = useState<ControlStatus | null>(null), [requirements, setRequirements] = useState<DoctorReport | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [command, setCommand] = useState<string | null>(null), [installPending, setInstallPending] = useState(false);
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
  const action = async (key: string, run: () => Promise<unknown>) => {
    setPending(current => [...current, key]); setError(''); try { await run(); await refresh(); } catch (error) { if (mounted.current) { setError(String(error)); setInstallPending(false); } } finally { if (mounted.current) setPending(current => current.filter(value => value !== key)); }
  };
  return <div className="lm-settings">
    <section aria-labelledby="lm-requirements"><div className="lm-actions"><h3 id="lm-requirements">Requirements</h3><button disabled={pending.length > 0} onClick={() => { void action('requirements', () => detect(true)); }}>{pending.includes('requirements') ? 'Checking…' : 'Refresh requirements'}</button></div>
      {!requirements ? <p role="status">Detecting requirements…</p> : <>
        <p>{requirements.machine.chip} · {requirements.machine.arch} · macOS {requirements.machine.osVersion || 'unknown'} · {(requirements.machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB unified memory</p>
        {!requirements.supported && <p><strong>Splash not supported on this Mac</strong> · Llama only</p>}<p>{requirements.supportMessage}</p>
        <p>Llama.app: {requirements.llama.installed ? requirements.llama.version ?? 'installed' : <a href={requirements.llama.downloadUrl} target="_blank" rel="noreferrer">Get Llama.app</a>} · router {requirements.llama.reachable ? 'reachable' : 'down — launch Llama.app'}<br /><small>{requirements.llama.url}</small></p>
        <p>Homebrew: {requirements.brew.path ?? <a href={requirements.brew.url} target="_blank" rel="noreferrer">Get Homebrew at brew.sh</a>}</p>
        {!requirements.brew.path && <><p>Run the official command yourself in Terminal:</p><pre>{requirements.brew.bootstrap}</pre></>}
        <p>Splash: {requirements.splash.version ?? (requirements.splash.installed ? 'installed; version unavailable' : 'missing')}<br /><small>{requirements.splash.binary}</small></p>
        {requirements.splash.error && <p role="alert">{requirements.splash.error}</p>}{requirements.splash.updateError && <p role="alert">Update check: {requirements.splash.updateError}</p>}
        {requirements.supported && requirements.brew.path && (!requirements.splash.installed || requirements.splash.outdated) && <button disabled={pending.length > 0 || installPending || data?.installation.running} onClick={() => setCommand(requirements.splash.installed ? 'brew upgrade incoai/tap/splash' : 'brew install incoai/tap/splash')}>{requirements.splash.installed ? 'Update Splash' : 'Install Splash'}</button>}
      </>}
      {data?.installation.command && <><p>{data.installation.running || installPending ? 'Running: ' : 'Command: '}<code>{data.installation.command}</code></p><pre aria-live="polite" tabIndex={0}>{data.installation.output}</pre>{data.installation.error && <p role="alert">{data.installation.error}</p>}</>}
    </section>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section aria-labelledby="lm-servers"><h3 id="lm-servers">Servers</h3><p>{String(settings.values?.baseUrl ?? 'Loading…')}</p><p>Manage server URLs, Splash enablement, ports, binary and idle minutes in the normal settings fields on this page. The first server is Llama.app.</p></section>
    <section aria-labelledby="lm-splash"><h3 id="lm-splash">Splash</h3>
      {!data ? <p role="status">Loading Splash status…</p> : <>
        <p>{data.process.model ? name(data.process.model) + (data.process.ready ? ' · running' : ' · starting') : 'Stopped'} · pid {data.process.pid ?? '—'} · port {data.process.port} · {(Math.max(0, data.process.idleLeftMs - (clock || Date.now()) + received.current) / 60000).toFixed(1)} idle minutes left</p>
        {data.process.error && <p role="alert">{data.process.error}</p>}
        {restart && <p>Context saved for {name(restart)}. <button disabled={pending.length > 0} onClick={() => { void action('restart', async () => { await call('splashRestart', {model:restart}); setRestart(null); }); }}>{pending.includes('restart') ? 'Restarting…' : 'Restart Splash now'}</button></p>}
        <p>Context uses <code>{data.userIni}</code>. Splash applies changes on its next start; applies to Llama.app after restarting it. Native limits are enforced; memory estimates include an allowance for the draft and engine, and vary by model.</p>
        <div className="lm-table"><table><thead><tr><th>Model</th><th>Draft</th><th>Context size</th><th>Actions</th></tr></thead><tbody>{data.models.map(model => <tr key={model.id}>
          <th scope="row" title={model.id}>{name(model.id)}{!model.ggufPresent && <p>GGUF missing</p>}</th>
          <td>{!model.supported ? 'not supported by Splash, served by Llama.app' : model.draft?.state === 'ready' ? 'ready · ' + mb(model.draft.total) + ' MB · sha256 verified' : model.draft?.state === 'downloading' ? 'downloading ' + mb(model.draft.done) + ' / ' + mb(model.draft.total) + ' MB' : <>{model.draft?.error ?? 'missing or not yet verified'}<br /><a href={'https://huggingface.co/' + model.sourceRepo} target="_blank" rel="noreferrer">{model.sourceRepo}</a> · {mb(model.draft?.total ?? null)} MB</>}</td>
          <td><ContextCell model={model} save={async tokens => { const result = await call('setContext', {model:model.id,tokens}); setNotice(result.warning ?? 'Context saved. Applies to Llama.app after restarting it.'); if (result.restartAvailable) setRestart(model.id); await refresh(); }} /></td>
          <td>{model.supported && <div className="lm-actions">{model.draft?.state === 'downloading' ? <button disabled={pending.some(value => value.startsWith(model.id + ':'))} onClick={() => { void action(model.id + ':cancel', () => call('splashCancel', {model:model.id})); }}>{pending.includes(model.id + ':cancel') ? 'Cancelling…' : 'Cancel'}</button> : <button disabled={pending.some(value => value.startsWith(model.id + ':')) || !requirements?.supported || !model.ggufPresent || model.draft?.state === 'ready'} onClick={() => { void action(model.id + ':download', () => call('splashDownload', {model:model.id})); }}>{pending.includes(model.id + ':download') ? 'Downloading…' : 'Download'}</button>}
            <button disabled={pending.some(value => value.startsWith(model.id + ':')) || model.draft?.state === 'downloading' || !!data.process.model && data.process.model.split('/').at(-1)?.split(':')[0] === model.id.split('/').at(-1)?.split(':')[0]} onClick={() => { if (model.draft?.state === 'ready') setDeleting(model.id); else void action(model.id + ':delete', () => call('splashDelete', {model:model.id})); }}>{pending.includes(model.id + ':delete') ? 'Deleting…' : 'Delete'}</button></div>}</td>
        </tr>)}</tbody></table></div>
        {!data.models.length && <p>No models in Llama.app’s generated configuration. Download models in Llama.app first.</p>}
      </>}
    </section>
    {data && <section aria-labelledby="lm-managed"><h3 id="lm-managed">Splash models outside Llama.app</h3>
      <p>Pulled into <code>{data.modelsDir}</code> with their DFlash2 drafts; size and sha256 are verified. Delete removes the GGUF and, when no other model of its family uses it, the draft. Splash picks their context window.</p>
      <form className="lm-actions" onSubmit={event => { event.preventDefault(); const model = pull.trim(); if (!model) return; setPull(''); void action(model + ':download', () => call('splashDownload', {model})); }}>
        <input aria-label="Upstream GGUF model id" placeholder="unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_M" value={pull} onChange={event => setPull(event.target.value)} />
        <button disabled={!pull.trim() || !requirements?.supported}>Download</button>
      </form>
      {!data.managed.length ? <p>No models pulled outside Llama.app.</p> : <div className="lm-table"><table><thead><tr><th>Model</th><th>Files</th><th>Actions</th></tr></thead><tbody>{data.managed.map(model => {
        const busy = pending.some(value => value.startsWith(model.id + ':')), downloading = model.gguf.state === 'downloading' || model.draft?.state === 'downloading';
        return <tr key={model.id}><th scope="row" title={model.path}>{name(model.id)}<br /><small>{model.id}</small></th>
          <td>GGUF: {transfer(model.gguf)}<br />Draft: {transfer(model.draft)}<br />Images: {model.vision ? 'projector ready' : 'text only'}<br /><small>{model.path}</small></td>
          <td><div className="lm-actions">{downloading ? <button disabled={busy} onClick={() => { void action(model.id + ':cancel', () => call('splashCancel', {model:model.id})); }}>{pending.includes(model.id + ':cancel') ? 'Cancelling…' : 'Cancel'}</button>
            : <button disabled={busy || !requirements?.supported || model.gguf.state === 'ready' && model.draft?.state === 'ready' && model.vision} onClick={() => { void action(model.id + ':download', () => call('splashDownload', {model:model.id})); }}>Download</button>}
            <button disabled={busy || downloading || data.process.model === 'splash/' + model.id} onClick={() => setRemoving(model.id)}>{pending.includes(model.id + ':delete') ? 'Deleting…' : 'Delete'}</button></div></td></tr>;
      })}</tbody></table></div>}
    </section>}
    {deleting && <Confirmation title="Delete Splash draft" label="Delete draft" close={() => setDeleting(null)} confirm={() => { const model = deleting; setDeleting(null); void action(model + ':delete', () => call('splashDelete', {model})); }}><p>Delete the downloaded draft for {name(deleting)}? Downloading it again takes a while.</p></Confirmation>}
    {removing && <Confirmation title="Delete Splash model" label="Delete model" close={() => setRemoving(null)} confirm={() => { const model = removing; setRemoving(null); void action(model + ':delete', () => call('splashDelete', {model})); }}><p>Delete {removing} and its downloaded files? Downloading it again takes a while.</p></Confirmation>}
    {command && <Confirmation title="Confirm Splash installation" label="Run command" close={() => setCommand(null)} confirm={() => { const selected = command as 'brew install incoai/tap/splash' | 'brew upgrade incoai/tap/splash'; setCommand(null); setInstallPending(true); installed.current = true; void action('install', () => call('installSplash', {command:selected,confirmed:true})); }}><p>This runs the following command on the BB server machine:</p><pre>{command}</pre>
      <p>No sudo is used. Output is shown here and recorded in the plugin log.</p></Confirmation>}
  </div>;
}
