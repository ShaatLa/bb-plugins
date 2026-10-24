import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export type AuthSource = "plugin" | "environment" | "gh" | "anonymous";

export async function resolveGithubToken(override: string | undefined, signal: AbortSignal): Promise<{ token: string | undefined; source: AuthSource }> {
  signal.throwIfAborted();
  if (override?.trim()) return { token: override.trim(), source: "plugin" };
  const environment = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (environment) return { token: environment, source: "environment" };
  // Match BB's GitHub plugin lookup when GUI launches have a limited PATH.
  for (const executable of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try {
      const { stdout } = await run(executable, ["auth", "token", "--hostname", "github.com"], {
        signal, timeout: 5000, maxBuffer: 16_384, encoding: "utf8",
      });
      if (stdout.trim()) return { token: stdout.trim(), source: "gh" };
    } catch {
      signal.throwIfAborted();
      // CLI errors can contain credentials; never log or return their output.
    }
  }
  return { token: undefined, source: "anonymous" };
}
