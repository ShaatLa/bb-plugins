import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { z } from "zod";
import { SETTINGS } from "./settings.js";
import { MIGRATIONS } from "./store/schema";
import { prune } from "./store/prune";

import { createStore } from "./store/write";
import { createClaudeSource } from "./ingest/claude";
import { createCodexSource } from "./ingest/codex";
import { createBbEvents } from "./ingest/bb-events";
import { createExtSource } from "./ingest/ext";
import { createScheduler } from "./ingest/scheduler";
import { registerRpc } from "./rpc";
import { registerCli } from "./cli";

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

  const settings = bb.settings.define(SETTINGS);

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
