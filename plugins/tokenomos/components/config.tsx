import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery, useSettings } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";
import { REFERENCE_MODELS, SETTINGS, type SettingKey } from "../settings";
import { providerName } from "./format";
import { useT } from "./i18n";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SettingsSection, SettingsWithControl } from "./ui/settings-section";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

type Value = string | number | boolean;
const GROUPS = [
  { id: "general", keys: ["language", "defaultGrouping"] },
  { id: "limits", keys: ["heavyTargetPercent", "heavyModels"] },
  { id: "watchlist", keys: ["contextWatchTokens"] },
  { id: "savings", keys: ["referenceModel", "priceOverrides"] },
  { id: "data", keys: ["includeOutsideBb", "rawRetentionDays", "rollupRetentionDays"] },
] as const satisfies readonly { id: string; keys: readonly SettingKey[] }[];

/** One setting, saved on its own through `config.set` (selects and switches at once, text fields on blur). */
type Option = { value: string; label: string };
function Field({ k, value, save, options }: { k: SettingKey; value: Value | undefined; save: (k: SettingKey, v: Value) => Promise<boolean>; options?: Option[] }) {
  const t = useT();
  const def = SETTINGS[k];
  const shown = value ?? def.default;
  const [draft, setDraft] = useState(String(shown));
  useEffect(() => setDraft(String(shown)), [shown]);
  const label = t(`cfg.${k}.label`), hint = t(`cfg.${k}.hint`);
  const commit = () => {
    if (draft === String(shown)) return;
    const next = def.type === "number" ? Number(draft) : draft;
    void save(k, next).then((ok) => { if (!ok) setDraft(String(shown)); });
  };
  let control;
  if (def.type === "boolean") control = <Switch aria-label={label} checked={Boolean(shown)} onCheckedChange={(v) => void save(k, v)} />;
  else if (options || def.type === "select") {
    // Option names follow the interface language where we have them; otherwise the declared labels.
    const labels: Record<string, string> = k === "defaultGrouping" ? { provider: t("by.provider"), model: t("by.model") } : "experimental_optionLabels" in def ? def.experimental_optionLabels : {};
    const list: Option[] = options ?? ("options" in def ? def.options.map((o) => ({ value: o, label: labels[o] ?? o })) : []);
    // The saved value stays selectable even when the current list no longer offers it.
    if (!list.some((o) => o.value === String(shown))) list.unshift({ value: String(shown), label: String(shown) });
    control = (
      <Select value={String(shown)} onValueChange={(v) => void save(k, v)}>
        <SelectTrigger aria-label={label} className="h-7 w-64"><SelectValue /></SelectTrigger>
        <SelectContent>{list.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
      </Select>
    );
  } else if ("experimental_multiline" in def) {
    control = <Textarea aria-label={label} rows={4} className="font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
  } else {
    control = (
      <Input aria-label={label} type={def.type === "number" ? "number" : "text"} className={def.type === "number" ? "h-7 w-32 text-right tabular-nums" : "h-7 w-72"}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />
    );
  }
  return <SettingsWithControl label={label} description={hint || undefined} controlPlacement={"experimental_multiline" in def ? "below" : "inline"}>{control}</SettingsWithControl>;
}

/** The plugin's settings in groups, in bb's settings style; they replace the flat list bb draws for native fields. */
export function Configuration() {
  const t = useT();
  const { values } = useSettings();
  const set = useMutation({ contract: rpcContract, method: "config.set" });
  // Reference models come from bb's providers (priced ones only); the built-in list covers the wait and failures.
  const models = useQuery({ contract: rpcContract, method: "config.options", input: {} }).data?.referenceModels;
  const referenceOptions: Option[] = models
    ? models.map((m) => ({ value: m.model, label: m.provider ? `${providerName(m.provider, t)} · ${m.label}` : m.label }))
    : REFERENCE_MODELS.map((m) => ({ value: m, label: m }));
  const save = (key: SettingKey, value: Value) =>
    set.mutate({ key, value }).then(() => true, (e) => { toast.error(e instanceof Error ? e.message : String(e)); return false; });
  return (
    <div className="space-y-6">
      {GROUPS.map((g) => (
        <SettingsSection key={g.id} title={t(`cfg.group.${g.id}`)} bodyClassName="space-y-5">
          {g.keys.map((k) => <Field key={k} k={k} value={values?.[k]} save={save} options={k === "referenceModel" ? referenceOptions : undefined} />)}
        </SettingsSection>
      ))}
    </div>
  );
}

/**
 * Hides bb's own flat "Configuration" list for these settings while the grouped one is shown; the native fields
 * stay, so `bb plugin config` keeps working. The same approach as the Sweep and CI Dashboard plugins.
 */
export function useHideNativeSettings() {
  useEffect(() => {
    const labels = Object.values(SETTINGS).map((s) => s.label);
    const previous = new Map<HTMLElement, { hidden: boolean; display: string }>();
    const sync = () => {
      // Our own grouped fields are skipped, so only bb's native list is found.
      const fields = labels.map((label) => Array.from(document.querySelectorAll<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`)).find((f) => !f.closest("[data-tokenomos-settings]")))
        .filter((f): f is HTMLElement => !!f);
      if (fields.length < 2) return;
      let parent = fields[0]!.parentElement;
      while (parent && !fields.every((f) => parent!.contains(f))) parent = parent.parentElement;
      if (!parent || parent === document.body || parent.querySelector("[data-tokenomos-settings]")) return;
      // Hide the host card around the list too (its border and grey fill): only wrappers that hold nothing else.
      while (parent.parentElement && parent.parentElement !== document.body && parent.parentElement.children.length === 1) parent = parent.parentElement;
      // The host's section heading sits just before the list or its wrapper (bb nests it in a header row); no higher,
      // so an unrelated section's heading is never reached;
      // found by place, not by its text, so a localized heading is hidden too.
      let heading: HTMLElement | undefined;
      for (let n: HTMLElement | null = parent, i = 0; n && n !== document.body && !heading && i < 2; n = n.parentElement, i++) {
        const prev = n.previousElementSibling, sel = 'h2, h3, [role="heading"]';
        const found = prev instanceof HTMLElement ? (prev.matches(sel) ? prev : prev.querySelector<HTMLElement>(sel)) : null;
        if (found && !found.closest("[data-tokenomos-settings]")) heading = found;
      }
      for (const el of [parent, heading].filter((n): n is HTMLElement => !!n)) {
        if (!previous.has(el)) previous.set(el, { hidden: el.hidden, display: el.style.display });
        el.hidden = true; el.style.display = "none";
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); previous.forEach((v, el) => { el.hidden = v.hidden; el.style.display = v.display; }); };
  }, []);
}
