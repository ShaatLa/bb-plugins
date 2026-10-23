import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  experimental_compareVersions as compareVersions,
  experimental_versionFrom as versionFrom,
  experimental_formatCommand as formatCommand,
  type ProviderUsage,
  type ProviderInstallationStatus,
  type ProviderInstallationRunResult,
} from "@get-bb/plugin-sdk/provider-bridge";

const exec = promisify(execFile);
export const RELEASES = "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest";
export const MINIMUM_CLI_VERSION = "1.4.6";

export async function resolveAgy(command = ""): Promise<string | null> {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const candidates = command ? [command] : [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)),
    path.join(os.homedir(), ".local", "bin", name),
  ];
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installation. */ }
  }
  return null;
}

// Never expose CLI stderr: it can contain login details and credential-bearing URLs.
export async function runAgy(command: string, args: string[]): Promise<string> {
  try {
    return (await exec(command, args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string };
    if (/not logged|unauthenticated|sign in|log in/i.test(failure.stderr ?? ""))
      throw new Error("unauthenticated");
    throw new Error(failure.killed ? "Antigravity CLI timed out." : "Antigravity CLI failed.");
  }
}

const bucketSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), window: z.string().optional(),
  remaining_fraction: z.number().min(0).max(1), reset_time: z.iso.datetime({ offset: true }).optional(),
});
const quotaSchema = z.object({ groups: z.array(z.object({ name: z.string().min(1), buckets: z.array(bucketSchema) })) });

function commandData(output: string, name: string): unknown {
  const events = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const event = events.find(value => value.event === "command_result" && value.command?.name === name);
  const result = events.find(value => value.event === "result" && value.result?.command?.name === name);
  return event?.command?.data ?? result?.result?.command?.data;
}

export function parseUsage(output: string): ProviderUsage {
  const data = quotaSchema.parse(commandData(output, "usage"));
  const windows = data.groups.flatMap(group => group.buckets
    .filter(bucket => bucket.id.startsWith("gemini-"))
    .sort((a, b) => Number(b.window === "5h") - Number(a.window === "5h"))
    .map(bucket => ({
    id: bucket.id,
    label: `${bucket.window === "weekly" ? "7d" : bucket.window ?? bucket.name.replace(/ Remaining$/, "")}${bucket.id.includes("argon") ? " · Argon" : ""}`,
    kind: bucket.window === "5h" ? "five-hour" : bucket.window === "weekly" ? "weekly" : "custom",
    model: group.name,
    usedPercent: (1 - bucket.remaining_fraction) * 100,
    resetsAt: bucket.reset_time ?? null,
  })));
  if (!windows.length) throw new Error("Antigravity returned no Google quota buckets.");
  return { status: "ok", accountEmail: null, planLabel: null, windows };
}

export async function readUsage(command = ""): Promise<ProviderUsage> {
  const executable = await resolveAgy(command);
  if (!executable) return { status: "not_installed" };
  let logDir: string | undefined;
  try {
    logDir = await mkdtemp(path.join(os.tmpdir(), "bb-antigravity-usage-"));
    const logPath = path.join(logDir, "cli.log");
    const usage = parseUsage(await runAgy(executable, ["--log-file", logPath, "--disable-slash-commands=false", "--output-format", "stream-json", "-p", "/usage"]));
    // shortcut: agy 1.4.6 omits identity from /usage; use its login log until structured identity is available.
    const log = await readFile(logPath, "utf8").catch(() => "");
    const email = [...log.matchAll(/OAuth: authenticated successfully as ([^\s]+)/g)].at(-1)?.[1];
    if (usage.status === "ok") usage.accountEmail = z.email().safeParse(email).data ?? null;
    return usage;
  } catch (error) {
    if (error instanceof Error && error.message === "unauthenticated") return { status: "unauthenticated" };
    return { status: "error", accountEmail: null, planLabel: null, message: "Antigravity quotas could not be read. Run agy and /usage on this machine." };
  } finally {
    if (logDir) await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installationStatus(command = "", checkUpdates = true): Promise<ProviderInstallationStatus> {
  const executablePath = await resolveAgy(command);
  const currentVersion = executablePath ? versionFrom(await runAgy(executablePath, ["--version"]).catch(() => "")) : null;
  let latestVersion: string | null = null;
  if (checkUpdates) {
    try {
      const response = await fetch(RELEASES, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json" } });
      if (response.ok) latestVersion = versionFrom(z.object({ tag_name: z.string() }).parse(await response.json()).tag_name);
    } catch { /* Offline discovery preserves the installed state. */ }
  }
  const needsUpdate = currentVersion !== null && latestVersion !== null && compareVersions(latestVersion, currentVersion) > 0;
  return {
    executableName: "agy", executablePath, installed: executablePath !== null,
    installSource: executablePath ? "external" : "notInstalled", currentVersion, latestVersion,
    minimumSupportedVersion: MINIMUM_CLI_VERSION, npmPackageName: null, npmGlobalPackageVersion: null,
    needsUpdate, versionUnsupported: currentVersion !== null && compareVersions(currentVersion, MINIMUM_CLI_VERSION) < 0,
    installAction: needsUpdate && executablePath ? { kind: "update", label: "Update", command: formatCommand(executablePath, ["update"]) } : null,
  };
}

export async function installationRun(command: string, action: string): Promise<ProviderInstallationRunResult> {
  const status = await installationStatus(command);
  if (action !== "update" || !status.needsUpdate || !status.executablePath || !status.currentVersion)
    return { available: false, message: "No CLI update is available. Install and sign in to agy separately if needed." };
  return {
    available: true,
    command: { command: status.executablePath, args: ["update"], displayCommand: formatCommand(status.executablePath, ["update"]) },
    verification: { kind: "version_at_least", version: status.latestVersion! },
  };
}

export function parseCredits(output: string): number {
  return z.object({ remaining_credits: z.number().nonnegative() }).parse(commandData(output, "credits")).remaining_credits;
}
export async function readCredits(command = "") {
  const executable = await resolveAgy(command);
  if (!executable) return { status: "not_installed" as const, remainingCredits: null, message: null };
  try {
    return { status: "ok" as const, remainingCredits: parseCredits(await runAgy(executable,
      ["--disable-slash-commands=false", "--output-format", "stream-json", "-p", "/credits"])), message: null };
  } catch (error) {
    return { status: error instanceof Error && error.message === "unauthenticated" ? "unauthenticated" as const : "error" as const,
      remainingCredits: null, message: "AI credits could not be read from agy." };
  }
}
