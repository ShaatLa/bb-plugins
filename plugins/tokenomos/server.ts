import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { MIGRATIONS } from "./store/schema";
import { prune } from "./store/prune";

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

  bb.background.schedule("prune", "17 4 * * *", async () => {
    const { rawRetentionDays, rollupRetentionDays } = await settings.get();
    const deleted = prune(db, { rawRetentionDays, rollupRetentionDays, now: Date.now() });
    if (deleted) bb.log.info(`Tokenomos prune removed ${deleted} rows`);
  });
}
