export const invalidBranch = "Use a Git branch name, such as tools/builders, or leave it blank to use the remote default branch.";

export function isBuilderBranch(value: string) {
  if (!value) return true;
  if (value.startsWith("-") || value.startsWith("refs/") || value === "HEAD" || value === "@" ||
    /[\s\x00-\x1f\x7f~^:?*\[\\]/u.test(value) || value.includes("..") || value.includes("@{") || value.endsWith(".")) return false;
  return value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
}
