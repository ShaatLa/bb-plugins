import { z } from "zod";
import { repositorySchema } from "./metrics";

export function splitRepositories(value: string): string[] {
  return value.split(/[\s,]+/).filter(Boolean);
}

export const repositoriesSettingSchema = z.string().max(10_000).refine(
  (value) => splitRepositories(value).every((repo) => repositorySchema.safeParse(repo).success),
  "Use owner/repo entries separated by commas or newlines",
);

export function githubRepository(remote: string | null): string | null {
  if (!remote) return null;
  try {
    const url = new URL(remote.replace(/^git@github\.com:/i, "ssh://git@github.com/"));
    if (url.hostname.toLowerCase() !== "github.com" || !["https:", "http:", "ssh:", "git:"].includes(url.protocol) || url.search || url.hash) return null;
    const repo = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "");
    return repositorySchema.safeParse(repo).success ? repo : null;
  } catch { return null; }
}

export function uniqueRepositories(repositories: string[]): string[] {
  return [...new Map(repositories.map((repo) => [repo.toLowerCase(), repo])).values()];
}
