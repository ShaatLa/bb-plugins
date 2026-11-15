import { experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { fmtInt } from "./format";
import { useT } from "./i18n";
import { Card } from "./shared";

/** Progress of the first-run history import; the server may omit it, and `usage` invalidation refreshes it. */
export type Backfill = { processedThreads: number; totalThreads: number; done: boolean; startedAt?: number };

/** True while the history import is still running, so money figures are incomplete. */
export function useBackfilling(): Backfill | undefined {
  const { data } = useQuery({ contract: rpcContract, method: "status", input: {} });
  const backfill = (data as { backfill?: Backfill } | undefined)?.backfill;
  return backfill && !backfill.done ? backfill : undefined;
}

export function BackfillBanner({ backfill }: { backfill: Backfill | undefined }) {
  const t = useT();
  if (!backfill) return null;
  return (
    <Card role="status" className="py-2 text-sm">
      {t("backfill.banner", { n: backfill.totalThreads, processed: fmtInt(backfill.processedThreads, t), total: fmtInt(backfill.totalThreads, t) })}
    </Card>
  );
}
