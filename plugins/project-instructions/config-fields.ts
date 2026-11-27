import { z } from "zod";

export function textConfigSchemas(isAbsolute: (path: string) => boolean, isRelative: (path: string) => boolean) {
  const relativePath = z.string().min(1).max(500)
    .refine(path => !isAbsolute(path) && !path.split(/[\\/]/).includes(".."), "must be a relative path without ..");

  return {
    clonePath: z.string().min(1).max(1000).refine(path => !isRelative(path), "must be an absolute path"),
    branch: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,200}$/, "must be a plain branch name"),
    rootFile: relativePath,
    skillsDir: relativePath,
  };
}

export type TextConfigKey = keyof ReturnType<typeof textConfigSchemas>;
