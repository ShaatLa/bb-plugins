import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import type { Config } from './server';

export class CheckoutRefreshError extends Error {}

function missingIsNull(error: NodeJS.ErrnoException) {
  if (error.code !== 'ENOENT') throw error;
  return null;
}

export async function command(command: string, args: string[], cwd: string, signal: AbortSignal, timeout = 60000, env = process.env, shallowLock?: string): Promise<{ code: number; output: string }> {
  const couldCreateLock = shallowLock && !await lstat(shallowLock).catch(missingIsNull);
  const detached = !!shallowLock && process.platform !== 'win32';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, detached, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const killGroup = (sig: NodeJS.Signals) => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, sig); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      } else child.kill(sig);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      failure ??= new Error(`${command} timed out`);
      if (shallowLock) {
        // Git can unlink its own lock on SIGTERM, before a stuck fetch needs SIGKILL.
        killGroup('SIGTERM');
        escalation = setTimeout(() => killGroup('SIGKILL'), 1000);
      } else child.kill('SIGKILL');
    }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const collect = (chunk: string) => { if (failure) return; output += chunk; if (Buffer.byteLength(output) > 1000000) { failure = new Error(`${command} output exceeds 1 MB`); child.kill('SIGKILL'); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => {
      if (shallowLock) failure ??= error;
      else { clearTimeout(timer); reject(error); }
    });
    child.on('close', async (code, sig) => {
      clearTimeout(timer); clearTimeout(escalation);
      if (timedOut && sig === 'SIGKILL' && couldCreateLock) {
        try {
          // The private checkout has one runner. Preserve locks that preceded this fetch.
          const lock = await lstat(shallowLock).catch(missingIsNull);
          if (lock?.isFile()) await unlink(shallowLock).catch(missingIsNull);
        } catch (cause) {
          reject(new Error(`${failure?.message}; could not clear shallow.lock: ${String(cause)}`, { cause }));
          return;
        }
      }
      if (failure) reject(failure);
      else if (code === null) reject(new Error(`${command} killed by ${sig}`));
      else resolve({ code, output });
    });
  });
}
export async function execute(base: string, projectId: string, config: Config & { remote: string }, previous: Buffer | null, signal: AbortSignal, bbCli = process.env.BB_CLI ?? '', runtimePath = '') {
  const root = join(base, 'checkouts', projectId);
  const git = async (args: string[], shallowLock?: string) => { const result = await command('git', ['-c', 'core.hooksPath=/dev/null', ...args], root, signal, 60000, { ...process.env, GIT_TERMINAL_PROMPT: '0' }, shallowLock); if (result.code) throw new Error(result.output); };
  try {
    await mkdir(root, { recursive: true });
    await git(['init']);
    try { await git(['remote', 'get-url', 'origin']); } catch { await git(['remote', 'add', 'origin', config.remote]); }
    await git(['remote', 'set-url', 'origin', config.remote]);
    await git(['fetch', '--depth=1', '--', config.remote, config.branch], join(root, '.git', 'shallow.lock'));
    await git(['checkout', '--force', '--detach', 'FETCH_HEAD']);
    await git(['clean', '-ffdx']);
  } catch (cause) {
    throw new CheckoutRefreshError(`Checkout refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  const script = await realpath(join(root, config.script)), rel = relative(await realpath(root), script);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Script escapes checkout');
  const temp = await mkdtemp(join(base, 'sweep-'));
  try {
    const committed = join(temp, 'committed.json'), candidate = join(temp, 'candidate.json');
    if (previous) await writeFile(committed, previous, { mode: 0o400 });
    if (bbCli && !isAbsolute(bbCli)) throw new Error('BB CLI path must be absolute');
    const env = { ...process.env, PATH: [bbCli ? dirname(bbCli) : '', runtimePath || process.env.PATH || ''].filter(Boolean).join(delimiter), ...(bbCli ? { BB_CLI: bbCli } : {}), BB_PROJECT_ID: projectId, BB_THREAD_ID: config.manager, BB_SWEEP_COMMITTED_STATE: committed, BB_SWEEP_CANDIDATE_SNAPSHOT: candidate };
    const args = config.args.map(arg => arg.replaceAll('{manager}', config.manager));
    const result = await command(script.endsWith('.py') ? 'python3' : script, [...(script.endsWith('.py') ? [script] : []), ...args, ...(config.snapshots ? ['--committed-state', committed, '--candidate-snapshot', candidate] : [])], root, signal, config.timeoutSeconds * 1000, env);
    let snapshot: Buffer | null = null;
    if (config.snapshots && result.code <= 1) { try { snapshot = await readFile(candidate); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    return { ...result, snapshot };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
