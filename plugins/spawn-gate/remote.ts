export const invalidRemote = "Use an HTTPS or SSH Git remote without embedded credentials, or leave it blank to use the project remote.";

export function isBuilderRemote(value: string) {
  if (!value) return true;
  if (/[\s\\\x00-\x1f\x7f]/u.test(value)) return false;
  if (/^(?:[\w.-]+@)?(?:[a-z\d][a-z\d.-]*|\[[a-f\d:]+\]):(?!\/\/)[^?#:]+$/iu.test(value)) return true;
  if (!/^(?:https|ssh):\/\//u.test(value) || /[?#]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && url.pathname.length > 1 && !url.password &&
      (url.protocol === "ssh:" || !url.username);
  } catch {
    return false;
  }
}
