import { z } from "zod";
import { questionLinks } from "./questions";

export const RECEIPT_OWNER_ONLY = "the check receipt validator is changed by the owner in the project settings";
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
}).strict().nullable();
export type CheckReceipt = z.infer<typeof checkReceiptSchema>;

export function receiptInScope(setting: CheckReceipt | undefined, prompt: string, steps: readonly string[]) {
  if (!setting) return false;
  if (!setting.linkPathPattern) return true;
  const pattern = new RegExp(setting.linkPathPattern);
  return questionLinks(prompt, steps).some(link => {
    try {
      const url = new URL(link, "https://example.invalid");
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
