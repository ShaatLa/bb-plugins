import { useMemo } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";

export type Lang = "en" | "ru";
export const LOCALES: Record<Lang, string> = { en: "en-US", ru: "ru-RU" };

/** A string, or plural forms picked with Intl.PluralRules from the `n` parameter. */
type Entry = string | ({ other: string } & Partial<Record<Intl.LDMLPluralRule, string>>);

const en = {
  "noPrice": "no price",
  "tokShort": "{value} tok.",
  // Range and grouping controls
  "range.day": "Day",
  "range.week": "Week",
  "range.month": "Month",
  "range.3m": "3 months",
  "by.provider": "By provider",
  "by.model": "By model",
  "loadError": "Failed to load data.",
  "backfill.banner": { one: "Loading history: {processed} of {total} thread — numbers are incomplete", other: "Loading history: {processed} of {total} threads — numbers are incomplete" },
  // KPI tiles
  "kpi.spend": "Spend (API equivalent)",
  "kpi.tokens": "Tokens",
  "kpi.compaction": "Compaction ~",
  "kpi.local": "Local models ~",
  "kpi.noPrevious": "no data for the previous period",
  "kpi.deltaUsd": "{value} vs previous period",
  "kpi.deltaTokens": "{value} vs previous period (tokens)",
  "kpi.cacheRead": "cache read {value}",
  "kpi.cacheReadNone": "cache read —",
  "kpi.split": "input {freshIn} · cache {cacheRead} · write {cacheWrite} · output {output}",
  "kpi.vsModel": "vs {model}",
  "saving.tokens": "{tokens} tokens",
  "saving.cost": "a cost, not a saving",
  "saving.excludesOwnCost": "excludes the cost of the compaction itself",
  "saving.partial": "partial",
  // Chart
  "chart.legend": "Legend",
  "chart.spend": "Spend, ~$",
  "chart.tokens": "Tokens",
  "chart.table": "Table",
  "chart.empty": "No data for this period.",
  "chart.aria": "Spend by interval, {n} total",
  "chart.interval": "Interval ({unit})",
  "chart.unitTokens": "tokens",
  "chart.total": "Total",
  "chart.intervals": { one: "{n} interval", other: "{n} intervals" },
  "chart.tipDetail": "{total} tok. · cache {cacheRead} · output {output}",
  "series.other": "Other",
  "series.others": "Others",
  // Breakdown
  "breakdown.title": "Breakdown",
  "breakdown.name": "Name",
  "breakdown.freshIn": "Fresh input",
  "breakdown.cacheRead": "Cache read",
  "breakdown.cacheWrite": "Cache write",
  "breakdown.output": "Output",
  "breakdown.calls": "Calls",
  "breakdown.empty": "No data.",
  // Threads
  "threads.title": "Threads",
  "threads.empty": "No threads with spend in this period.",
  "threads.thread": "Thread",
  "threads.own": "~$ own",
  "threads.total": "~$ with subthreads",
  "threads.ownTitle": "This thread only",
  "threads.totalTitle": "With subthreads",
  "threads.more": "More",
  // Compactions
  "compactions.title": "Compactions",
  "compactions.empty": "No compactions in this period.",
  "compactions.cost": "(cost)",
  "compactions.count": { one: "{count} compaction", other: "{count} compactions" },
  "compactions.saved": "saved",
  "compactions.noData": { one: "{count} without data", other: "{count} without data" },
  "origin.idle-compact": "Idle Compact",
  "origin.bb": "bb",
  // Settings: sources
  "sources.title": "Sources",
  "sources.prune": "Clear old data",
  "sources.source": "Source",
  "sources.state": "State",
  "sources.lastIngest": "Last ingest",
  "sources.rows": "Rows",
  "sources.error": "Error",
  "sources.claude-file": "Claude Code (files)",
  "sources.codex-file": "Codex (files)",
  "sources.local-log": "Local models (log)",
  "sources.agy-log": "Antigravity (log)",
  "sources.bb-events": "bb events",
  "sources.footer": "Degraded threads: {degraded} · database {size} ({pages}, {free} free) · {rows}",
  "sources.pages": { one: "{n} page", other: "{n} pages" },
  "sources.pruned": "Rows deleted: {n}",
  // Settings: prices
  "prices.title": "Prices, $ per 1M tokens (version {version})",
  "prices.model": "Model",
  "prices.input": "Input",
  "prices.output": "Output",
  "prices.cacheRead": "Cache read",
  "prices.cacheWriteShort": "Cache write (short)",
  "prices.cacheWriteLong": "Cache write (long)",
  "prices.changed": "changed",
  "prices.unverified": "unverified",
  "prices.save": "Save",
  "prices.reset": "Reset",
  "prices.saved": "Price saved",
  "prices.resetDone": "Price reset",
  // Formatting units and provider names
  "unit.gb": "GB",
  "unit.mb": "MB",
  "unit.kb": "KB",
  "weekOf": "wk of {date}",
  "provider.local-models": "Local models",
} as const;

export type Key = keyof typeof en;

const ru: Record<Key, Entry> = {
  "noPrice": "нет цены",
  "tokShort": "{value} ток.",
  "range.day": "День",
  "range.week": "Неделя",
  "range.month": "Месяц",
  "range.3m": "3 месяца",
  "by.provider": "По провайдерам",
  "by.model": "По моделям",
  "loadError": "Не удалось загрузить данные.",
  "backfill.banner": { one: "Загружается история: {processed} из {total} треда — цифры неполные", other: "Загружается история: {processed} из {total} тредов — цифры неполные" },
  "kpi.spend": "Расход (API-эквивалент)",
  "kpi.tokens": "Токены",
  "kpi.compaction": "Компакция ~",
  "kpi.local": "Локальные модели ~",
  "kpi.noPrevious": "нет данных за прошлый период",
  "kpi.deltaUsd": "{value} к прошлому периоду",
  "kpi.deltaTokens": "{value} к прошлому периоду (токены)",
  "kpi.cacheRead": "чтение из кэша {value}",
  "kpi.cacheReadNone": "чтение из кэша —",
  "kpi.split": "вход {freshIn} · кэш {cacheRead} · запись {cacheWrite} · выход {output}",
  "kpi.vsModel": "vs {model}",
  "saving.tokens": "{tokens} токенов",
  "saving.cost": "затраты, а не экономия",
  "saving.excludesOwnCost": "без учёта стоимости самой компакции",
  "saving.partial": "частично",
  "chart.legend": "Легенда",
  "chart.spend": "Расход, ~$",
  "chart.tokens": "Токены",
  "chart.table": "Таблица",
  "chart.empty": "За этот период данных нет.",
  "chart.aria": "Расход по интервалам, {n} шт.",
  "chart.interval": "Интервал ({unit})",
  "chart.unitTokens": "токены",
  "chart.total": "Всего",
  "chart.intervals": { one: "{n} интервал", few: "{n} интервала", many: "{n} интервалов", other: "{n} интервала" },
  "chart.tipDetail": "{total} ток. · кэш {cacheRead} · выход {output}",
  "series.other": "Другое",
  "series.others": "Другие",
  "breakdown.title": "Разбивка",
  "breakdown.name": "Название",
  "breakdown.freshIn": "Свежий вход",
  "breakdown.cacheRead": "Чтение кэша",
  "breakdown.cacheWrite": "Запись кэша",
  "breakdown.output": "Выход",
  "breakdown.calls": "Вызовов",
  "breakdown.empty": "Нет данных.",
  "threads.title": "Треды",
  "threads.empty": "Нет тредов с расходом за период.",
  "threads.thread": "Тред",
  "threads.own": "~$ сам",
  "threads.total": "~$ с подтредами",
  "threads.ownTitle": "Сам тред",
  "threads.totalTitle": "С подтредами",
  "threads.more": "Ещё",
  "compactions.title": "Компакции",
  "compactions.empty": "Компакций за период не было.",
  "compactions.cost": "(затраты)",
  "compactions.count": { one: "{count} компакция", few: "{count} компакции", many: "{count} компакций", other: "{count} компакции" },
  "compactions.saved": "сэкономлено",
  "compactions.noData": { one: "{count} без данных", few: "{count} без данных", many: "{count} без данных", other: "{count} без данных" },
  "origin.idle-compact": "Idle Compact",
  "origin.bb": "bb",
  "sources.title": "Источники",
  "sources.prune": "Очистить старые данные",
  "sources.source": "Источник",
  "sources.state": "Состояние",
  "sources.lastIngest": "Последний приём",
  "sources.rows": "Строк",
  "sources.error": "Ошибка",
  "sources.claude-file": "Claude Code (файлы)",
  "sources.codex-file": "Codex (файлы)",
  "sources.local-log": "Локальные модели (лог)",
  "sources.agy-log": "Antigravity (лог)",
  "sources.bb-events": "События bb",
  "sources.footer": "Деградировавших тредов: {degraded} · база {size} ({pages}, свободных {free}) · {rows}",
  "sources.pages": { one: "{n} страница", few: "{n} страницы", many: "{n} страниц", other: "{n} страницы" },
  "sources.pruned": "Удалено строк: {n}",
  "prices.title": "Цены, $ за 1 млн токенов (версия {version})",
  "prices.model": "Модель",
  "prices.input": "Вход",
  "prices.output": "Выход",
  "prices.cacheRead": "Чтение кэша",
  "prices.cacheWriteShort": "Запись (короткая)",
  "prices.cacheWriteLong": "Запись (длинная)",
  "prices.changed": "изменено",
  "prices.unverified": "не проверено",
  "prices.save": "Сохранить",
  "prices.reset": "Сбросить",
  "prices.saved": "Цена сохранена",
  "prices.resetDone": "Цена сброшена",
  "unit.gb": "ГБ",
  "unit.mb": "МБ",
  "unit.kb": "КБ",
  "weekOf": "нед. с {date}",
  "provider.local-models": "Локальные модели",
};

export const DICTIONARIES: Record<Lang, Record<Key, Entry>> = { en, ru };

export type Params = Record<string, string | number>;

/** Looks up `key`, picks the plural form for `params.n`, and fills `{name}` placeholders. */
export function translate(lang: Lang, key: Key, params: Params = {}): string {
  const entry = DICTIONARIES[lang][key];
  let text: string;
  if (typeof entry === "string") text = entry;
  else {
    const rule = new Intl.PluralRules(LOCALES[lang]).select(Number(params.n ?? 0));
    text = entry[rule] ?? entry.other;
  }
  const number = new Intl.NumberFormat(LOCALES[lang]);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    return typeof value === "number" ? number.format(value) : String(value ?? "");
  });
}

/** Translator bound to a language: callable, with the language and its Intl locale attached. */
export type T = ((key: Key, params?: Params) => string) & { lang: Lang; locale: string };

export function makeT(lang: Lang): T {
  return Object.assign((key: Key, params?: Params) => translate(lang, key, params), { lang, locale: LOCALES[lang] });
}

/** English unless the plugin setting `language` says "ru". */
export function useT(): T {
  const language = useSettings().values?.language === "ru" ? "ru" : "en";
  return useMemo(() => makeT(language), [language]);
}
