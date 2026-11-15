import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { z } from "zod";
import { MIGRATIONS } from "./store/schema";
import { prune } from "./store/prune";
import { parseOverrides } from "./pricing/price";

import { createStore } from "./store/write";
import { createClaudeSource } from "./ingest/claude";
import { createCodexSource } from "./ingest/codex";
import { createBbEvents } from "./ingest/bb-events";
import { createExtSource } from "./ingest/ext";
import { createScheduler } from "./ingest/scheduler";
import { registerRpc } from "./rpc";
import { registerCli } from "./cli";

const REFERENCE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6.1-terra"];

const days = (min: number, max: number) => z.number().int().min(min).max(max);

const priceOverridesSchema = z.string().refine((text) => {
  try {
    parseOverrides(text);
    return true;
  } catch {
    return false;
  }
}, "Expected a JSON object with valid model prices");

export default function plugin(bb: BbPluginApi) {
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const readLoop = () => ({ p99Ms: loopDelay.percentile(99) / 1e6, maxMs: loopDelay.max / 1e6 });
  let lastMinute: ReturnType<typeof readLoop> | undefined;
  const loopTimer = setInterval(() => { lastMinute = readLoop(); loopDelay.reset(); }, 60_000);
  loopTimer.unref();
  bb.onDispose(() => { clearInterval(loopTimer); loopDelay.disable(); });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const settings = bb.settings.define({
    language: {
      type: "select", label: "Language", options: ["en", "ru"], experimental_optionLabels: { en: "English", ru: "Русский" }, default: "en",
    },
    rawRetentionDays: {
      type: "number", label: "Keep raw records, days (7–60)", default: 30, experimental_schema: days(7, 60),
    },
    rollupRetentionDays: {
      type: "number", label: "Keep hourly rollups, days (184–400)", default: 200, experimental_schema: days(184, 400),
    },
    referenceModel: {
      type: "select", label: "Reference model for savings", options: REFERENCE_MODELS, default: "claude-sonnet-5-5",
    },
    includeOutsideBb: {
      type: "boolean", label: "Count usage outside BB", default: false,
    },
    contextWatchTokens: {type:"number",label:"Watchlist context threshold",default:300000,experimental_schema:z.number().int().min(50000).max(1000000)},
    priceOverrides: {
      type: "string", label: "Custom prices ($/MTok, JSON)", default: "{}", experimental_multiline: true,
      experimental_schema: priceOverridesSchema,
    },
  });

  const store = createStore(db);
  const scheduler=createScheduler({ bb, db, store, settings,
    files: {
      'claude-file': createClaudeSource({ store, db, root: process.env.TOKENOMOS_CLAUDE_ROOT }),
      'codex-file': createCodexSource({ store, db, root: process.env.TOKENOMOS_CODEX_ROOT, archivedRoot: process.env.TOKENOMOS_CODEX_ARCHIVED_ROOT }),
    },
    sources: (sdk, signal) => ({
      bbEvents: createBbEvents({ store, db, sdk, log: bb.log, signal }),
      ext: createExtSource({ store, db, signal, callRpc: (pluginId, method, input) => sdk.plugins.callRpc({ pluginId, method, input: input as import('@get-bb/plugin-sdk').JsonValue, outputSchema: z.unknown() }) }),
    }),
  });
  // Defer SDK access until RPC handlers execute; the factory runs before binding.
  const sdk = new Proxy({} as import('@get-bb/plugin-sdk').PluginBbSdk, { get: (_, key) => Reflect.get(bb.sdk, key) });
  registerCli(bb, registerRpc(bb, db, settings, sdk, () => lastMinute ?? readLoop(), scheduler.noteWatchlist));

  bb.background.schedule("prune", "17 4 * * *", async () => {
    const { rawRetentionDays, rollupRetentionDays } = await settings.get();
    const deleted = prune(db, { rawRetentionDays, rollupRetentionDays, now: Date.now() });
    if (deleted) bb.log.info(`Tokenomos prune removed ${deleted} rows`);
  });
}
