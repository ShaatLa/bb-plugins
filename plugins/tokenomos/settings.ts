import type { PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { parseOverrides, resolveModel } from "./pricing/price.js";
import { DEFAULT_HEAVY_MODELS } from "./store/limits.js";

/** Fallback for the reference-model picker when bb's providers cannot list their models. */
export const REFERENCE_MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "gpt-6.1-sol", "gpt-6.1-terra"];

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const priceOverridesSchema = z.string().refine((text) => {
  try { parseOverrides(text); return true; } catch { return false; }
}, "Expected a JSON object with valid model prices");

/**
 * The plugin's global settings: native bb fields (so `bb plugin config tokenomos set <key>` keeps working),
 * one validation schema per key, shared by the server, the `config.set` RPC and the settings UI.
 */
export const SETTINGS = {
  language: { type: "select", label: "Language", options: ["en", "ru"], experimental_optionLabels: { en: "English", ru: "Русский" }, default: "en", experimental_schema: z.enum(["en", "ru"]) },
  defaultGrouping: { type: "select", label: "Default chart grouping", options: ["provider", "model"], experimental_optionLabels: { provider: "By provider", model: "By model" }, default: "provider", experimental_schema: z.enum(["provider", "model"]) },
  rawRetentionDays: { type: "number", label: "Keep raw records, days (7–60)", default: 30, experimental_schema: int(7, 60) },
  rollupRetentionDays: { type: "number", label: "Keep hourly rollups, days (184–400)", default: 200, experimental_schema: int(184, 400) },
  // Any model the price table knows can price the savings; the UI offers the ones bb's providers list.
  referenceModel: { type: "string", label: "Reference model for savings", default: "claude-sonnet-5-5", experimental_schema: z.string().refine((m) => resolveModel(m) !== null, "Expected a model from the price table") },
  includeOutsideBb: { type: "boolean", label: "Count usage outside BB", default: false, experimental_schema: z.boolean() },
  contextWatchTokens: { type: "number", label: "Watchlist context threshold", default: 300000, experimental_schema: int(50000, 1000000) },
  heavyTargetPercent: { type: "number", label: "Heavy model target, % of limit cost (0 turns it off)", default: 50, experimental_schema: int(0, 100) },
  heavyModels: { type: "string", label: "Heavy model families (comma-separated)", default: DEFAULT_HEAVY_MODELS, experimental_schema: z.string().max(500) },
  // Display only: the limits RPC still reports every subscription.
  poolAccounts: { type: "boolean", label: "Pool subscriptions of one provider (experimental)", default: true, experimental_schema: z.boolean() },
  // Used when a provider does not report its plan's multiplier: "pro=20, plus=1".
  planMultipliers: { type: "string", label: "Plan sizes for the pool (plan=multiplier, comma-separated)", default: "", experimental_schema: z.string().max(500).regex(/^\s*([\w.-]+\s*=\s*\d+(\.\d+)?\s*(,\s*|$))*$/, "Expected plan=number pairs, such as pro=20, plus=1") },
  priceOverrides: { type: "string", label: "Custom prices ($/MTok, JSON)", default: "{}", experimental_multiline: true, experimental_schema: priceOverridesSchema },
} satisfies Record<string, PluginSettingDescriptor>;

export type SettingKey = keyof typeof SETTINGS;
