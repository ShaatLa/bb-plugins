import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, platform, totalmem } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export const BREW_BOOTSTRAP = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
export const SPLASH_INSTALL = 'brew install incoai/tap/splash';
export const SPLASH_UPDATE = 'brew upgrade incoai/tap/splash';
export type CommandResult = { code: number; output: string };
export type RunCommand = (binary: string, args: string[], signal: AbortSignal, print?: (text: string) => void) => Promise<CommandResult>;
export const runCommand: RunCommand = (binary, args, signal, print = () => {}) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  // A process group lets cancellation reap brew's children as well as its wrapper.
  const child = spawn(binary, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ANALYTICS: '1' } });
  let output = '', timer: ReturnType<typeof setTimeout> | undefined;
  const collect = (chunk: Buffer) => { const text = chunk.toString(); output = (output + text).slice(-100000); print(text); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const kill = (kind: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, kind); } catch { /* Already exited. */ } };
  const abort = () => { kill('SIGTERM'); timer = setTimeout(() => kill('SIGKILL'), 10000); timer.unref(); };
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', reject);
  child.once('close', code => { signal.removeEventListener('abort', abort); if (timer) clearTimeout(timer); if (signal.aborted) reject(signal.reason); else resolve({ code: code ?? 1, output: output.trim() }); });
  if (signal.aborted) abort();
});
export async function fileExists(path: string) { return access(path).then(() => true, () => false); }
async function brewPath() {
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin']) {
    const path = join(dir, 'brew'); if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  return null;
}
export type DoctorOptions = { binary: string; baseUrl: string; run?: RunCommand; exists?: typeof fileExists; brew?: string | null; platform?: string; arch?: string; memoryBytes?: number; fetcher?: typeof fetch; resolveBinary?: typeof realpath };
export async function doctor(options: DoctorOptions, signal: AbortSignal) {
  const run = options.run ?? runCommand, exists = options.exists ?? fileExists;
  const command = async (binary: string, args: string[]) => {
    try { return await run(binary, args, AbortSignal.any([signal, AbortSignal.timeout(20000)])); }
    catch (error) { return { code: -1, output: String(error) }; }
  };
  const brew = options.brew === undefined ? await brewPath() : options.brew;
  const [os, chip, installed, llamaInstalled] = await Promise.all([
    command('/usr/bin/sw_vers', ['-productVersion']), command('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), exists(options.binary), exists('/Applications/Llama.app'),
  ]);
  const version = os.code === 0 ? os.output : '', parts = version.split('.').map(Number), generation = /Apple M(\d+)/.exec(chip.output);
  const machine = { platform: options.platform ?? platform(), arch: options.arch ?? arch(), osVersion: version, chip: chip.code === 0 ? chip.output : 'Unknown', memoryBytes: options.memoryBytes ?? totalmem() };
  const eligible = machine.platform === 'darwin' && machine.arch === 'arm64' && (parts[0] > 26 || parts[0] === 26 && parts[1] >= 4) && !!generation && Number(generation[1]) >= 3;
  let device: CommandResult | null = null, splashVersion: CommandResult | null = null, outdated: CommandResult | null = null;
  if (installed) {
    splashVersion = await command(options.binary, ['--version']);
    let prefix: string | null = null;
    if (brew) { const result = await command(brew, ['--prefix', 'incoai/tap/splash']); if (result.code === 0 && result.output.startsWith('/')) prefix = result.output; }
    if (!prefix) prefix = dirname(dirname(await (options.resolveBinary ?? realpath)(options.binary).catch(() => options.binary)));
    device = await command(join(prefix, 'libexec/engine/splash'), ['device-check']);
    if (brew) outdated = await command(brew, ['outdated', 'incoai/tap/splash']);
  }
  let llamaVersion: string | null = null;
  if (llamaInstalled) {
    const value = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Llama.app/Contents/Info.plist']);
    if (value.code === 0) llamaVersion = value.output;
  }
  const reachable = await (options.fetcher ?? fetch)(options.baseUrl + '/models', { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) }).then(async response => { await response.body?.cancel(); return response.ok; }, () => false);
  return {
    machine, supported: device ? device.code === 0 : eligible,
    supportMessage: device ? device.output || (device.code === 0 ? 'Splash device-check passed' : 'Splash device-check failed') : eligible ? 'Apple silicon, macOS and GPU requirements met' : 'Splash not supported on this Mac: requires arm64, macOS 26.4+, and Apple M3 or later.',
    llama: { installed: llamaInstalled, version: llamaVersion, reachable, url: options.baseUrl, downloadUrl: 'https://llama.app/' },
    brew: { path: brew, url: 'https://brew.sh', bootstrap: BREW_BOOTSTRAP },
    splash: { installed, binary: options.binary, version: splashVersion?.code === 0 ? splashVersion.output : null, error: splashVersion && splashVersion.code !== 0 ? splashVersion.output : null, outdated: outdated?.code === 0 && !!outdated.output, updateError: outdated && outdated.code !== 0 ? outdated.output : null },
  };
}
export type DoctorReport = Awaited<ReturnType<typeof doctor>>;
