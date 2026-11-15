import type { z } from "zod";
import type { rpcContract } from "../contract";

type Output<M extends keyof typeof rpcContract> = z.output<(typeof rpcContract)[M]["output"]>;

export type SummaryOutput = Output<"summary">;
export type ThreadsOutput = Output<"topThreads">;
export type CompactionsOutput = Output<"compactions">;
export type StatusOutput = Output<"status">;
export type PricesOutput = Output<"prices">;
