import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const cache = new Map<string | undefined, { expires: number; value: Promise<{ token: string | undefined; source: AuthSource }> }>();
export type AuthSource = "plugin" | "environment" | "gh" | "anonymous";

export async function resolveGithubToken(override: string | undefined, signal: AbortSignal): Promise<{ token: string | undefined; source: AuthSource }> {
  signal.throwIfAborted();
  if (override?.trim()) return { token: override.trim(), source: "plugin" };
  const environment = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (environment) return { token: environment, source: "environment" };
  let entry = cache.get(override);
  if (!entry || entry.expires <= Date.now()) {
    const value = (async (): Promise<{ token: string | undefined; source: AuthSource }> => {
      // Match BB's GitHub plugin lookup when GUI launches have a limited PATH.
      for (const executable of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
        try {
          const { stdout } = await run(executable, ["auth", "token", "--hostname", "github.com"], { timeout: 5000, maxBuffer: 16_384, encoding: "utf8" });
          if (stdout.trim()) return { token: stdout.trim(), source: "gh" };
        } catch { /* CLI errors can contain credentials. */ }
      }
      return { token: undefined, source: "anonymous" };
    })();
    entry = { value, expires: Infinity };
    cache.set(override, entry);
    const current = entry;
    void value.then(result => { current.expires = Date.now() + (result.token ? 300_000 : 30_000); });
  }
  const result = await new Promise<{ token: string | undefined; source: AuthSource }>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    entry!.value.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, reject);
    if (signal.aborted) abort();
  });
  return result;
}
