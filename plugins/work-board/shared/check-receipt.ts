import { z } from "zod";
import { questionLinks } from "./questions";

export const RECEIPT_PROJECT_UPDATE_REFUSAL = "use config set checkReceipt to enable or tighten Check receipt, or change it in the project settings";
export const RECEIPT_LIMIT = 256 * 1024;
export const validatorIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const checkReceiptSchema = z.object({
  validatorId: validatorIdSchema,
  timeoutSeconds: z.number().int().min(5).max(300).default(60),
  hint: z.string().trim().min(1).max(1000),
  linkPathPattern: z.string().min(1).max(500).refine(value => {
    try { new RegExp(value); return true; } catch { return false; }
  }, "Invalid link path pattern").optional(),
  linkWrappers: z.array(z.string().regex(/^\/(?!\/)[^?#\s]*\?[\w.-]+$/)).max(5).optional(),
  // Only the canonical URL.hostname form, so the scope test can compare strings (`[::1]`, not `[0:0:0:0:0:0:0:1]`).
  linkHosts: z.array(z.string().refine(host => {
    try { return new URL(`http://${host}/`).hostname === host; } catch { return false; }
  }, "Link host must be a canonical hostname such as 127.0.0.1")).min(1).max(5).optional(),
}).strict().nullable();
export type CheckReceipt = z.infer<typeof checkReceiptSchema>;

export function agentReceiptRefusal(current: CheckReceipt, next: CheckReceipt): string | null {
  if (!current) return null;
  if (!next) return "switching Check receipt off is owner-only";
  if (current.validatorId !== next.validatorId) return "changing the Check receipt validator is owner-only";
  if (current.timeoutSeconds !== next.timeoutSeconds) return "changing the Check receipt timeout is owner-only";
  if (current.hint !== next.hint) return "changing the Check receipt hint is owner-only";
  if (!next.linkPathPattern) return null;
  if (current.linkPathPattern !== next.linkPathPattern) return "adding or editing the Check receipt link path pattern is owner-only";
  if (current.linkWrappers?.some(wrapper => !next.linkWrappers?.includes(wrapper)))
    return "removing a Check receipt link wrapper is owner-only";
  // Dropping the host list widens scope; setting one or removing a host narrows it.
  if (!next.linkHosts) return null;
  if (!current.linkHosts) return "adding a Check receipt link host list is owner-only";
  if (current.linkHosts.some(host => !next.linkHosts!.includes(host)))
    return "removing a Check receipt link host is owner-only";
  return null;
}

export function receiptInScope(setting: CheckReceipt | undefined, prompt: string, steps: readonly string[]) {
  if (!setting) return false;
  if (!setting.linkPathPattern) return true;
  const pattern = new RegExp(setting.linkPathPattern);
  return questionLinks(prompt, steps).some(link => {
    try {
      // With hosts listed, only absolute http(s) links on a listed host count; relative and `//` targets do not.
      if (setting.linkHosts && !/^https?:/i.test(link)) return false;
      const url = new URL(link, "https://example.invalid");
      if (setting.linkHosts && !setting.linkHosts.includes(url.hostname)) return false;
      if (pattern.test(url.pathname)) return true;
      return setting.linkWrappers?.some(wrapper => {
        const [path, param] = wrapper.split("?");
        const value = url.searchParams.get(param);
        if (url.pathname !== path || url.searchParams.size !== 1 || !value) return false;
        const inner = new URL(value, url);
        return inner.origin === url.origin && pattern.test(inner.pathname);
      });
    } catch { return false; }
  });
}
