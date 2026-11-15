import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
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

const REFERENCE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6.1-terra"];

const days = (min: number, max: number) => z.number().int().min(min).max(max);

// priceOverrides must be a JSON object (e.g. {"model": {"input": 1}}); per-model shape is checked by pricing later.
const priceOverridesSchema = z.string().refine((text) => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}, "Нужен JSON-объект");

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const settings = bb.settings.define({
    rawRetentionDays: {
      type: "number", label: "Хранить сырые записи, дней (7–60)", default: 30, experimental_schema: days(7, 60),
    },
    rollupRetentionDays: {
      type: "number", label: "Хранить почасовые итоги, дней (184–400)", default: 200, experimental_schema: days(184, 400),
    },
    referenceModel: {
      type: "select", label: "Эталонная модель для расчёта экономии", options: REFERENCE_MODELS, default: "claude-sonnet-5-5",
    },
    includeOutsideBb: {
      type: "boolean", label: "Учитывать использование вне BB", default: false,
    },
    priceOverrides: {
      type: "string", label: "Свои цены ($/MTok, JSON)", default: "{}", experimental_multiline: true,
      experimental_schema: priceOverridesSchema,
    },
  });

  const store = createStore(db);
  createScheduler({ bb, db, store, settings,
    files: {
      'claude-file': createClaudeSource({ store, db, root: process.env.TOKENOMOS_CLAUDE_ROOT }),
      'codex-file': createCodexSource({ store, db, root: process.env.TOKENOMOS_CODEX_ROOT, archivedRoot: process.env.TOKENOMOS_CODEX_ARCHIVED_ROOT }),
    },
    sources: sdk => ({
      bbEvents: createBbEvents({ store, db, sdk, log: bb.log }),
      ext: createExtSource({ store, db, callRpc: (pluginId, method, input) => sdk.plugins.callRpc({ pluginId, method, input: input as import('@get-bb/plugin-sdk').JsonValue, outputSchema: z.unknown() }) }),
    }),
  });
  // Defer SDK access until RPC handlers execute; the factory runs before binding.
  const sdk = new Proxy({} as import('@get-bb/plugin-sdk').PluginBbSdk, { get: (_, key) => Reflect.get(bb.sdk, key) });
  registerCli(bb, registerRpc(bb, db, settings, sdk));

  bb.background.schedule("prune", "17 4 * * *", async () => {
    const { rawRetentionDays, rollupRetentionDays } = await settings.get();
    const deleted = prune(db, { rawRetentionDays, rollupRetentionDays, now: Date.now() });
    if (deleted) bb.log.info(`Tokenomos prune removed ${deleted} rows`);
  });
}
