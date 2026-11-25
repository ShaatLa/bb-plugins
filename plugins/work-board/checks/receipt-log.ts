import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CheckReceipt } from "../shared/check-receipt";
import { registeredValidator } from "./receipt-registry";

export function logReceiptChange(bb: BbPluginApi, prefix: string, before: CheckReceipt, after: CheckReceipt,
  registration: ReturnType<typeof registeredValidator> | null | undefined) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  let oldRegistration;
  try {
    oldRegistration = before && registeredValidator(before.validatorId);
  } catch {
    oldRegistration = "registration unavailable";
  }
  bb.log.info(`check receipt for ${prefix}: ${JSON.stringify([before, oldRegistration])} → ${JSON.stringify([after, registration])}`);
}
