import { useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Rates } from "../contract";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { fmtBytes, fmtInt, fmtWhen } from "./format";
import { useT } from "./i18n";
import { Muted, Section, SkeletonBlock } from "./shared";
import type { PricesOutput } from "./types";
import { Configuration, useHideNativeSettings } from "./config";

const SOURCE_KEYS = ["claude-file", "codex-file", "local-log", "agy-log", "bb-events"] as const;
const FIELDS = ["input", "output", "cacheRead", "cacheWriteShort", "cacheWriteLong"] as const satisfies readonly (keyof Rates)[];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Sources() {
  const t = useT();
  const { data, isLoading } = useQuery({ contract: rpcContract, method: "status", input: {} });
  const prune = useMutation({ contract: rpcContract, method: "prune" });
  if (!data) return isLoading ? <SkeletonBlock rows={3} /> : null;
  const onPrune = () => prune.mutate({}).then((r) => toast.success(t("sources.pruned", { n: fmtInt(r.deletedRows, t) })), (e) => toast.error(errorText(e)));
  return (
    <Section title={t("sources.title")} action={<Button variant="outline" size="sm" disabled={prune.isPending} onClick={onPrune}>{t("sources.prune")}</Button>}>
      <Table>
        <TableHeader>
          <TableRow><TableHead>{t("sources.source")}</TableHead><TableHead>{t("sources.state")}</TableHead><TableHead>{t("sources.lastIngest")}</TableHead><TableHead className="text-right">{t("sources.rows")}</TableHead><TableHead>{t("sources.error")}</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {data.sources.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{(SOURCE_KEYS as readonly string[]).includes(s.id) ? t(`sources.${s.id as (typeof SOURCE_KEYS)[number]}`) : s.id}</TableCell>
              <TableCell><Badge variant="outline">{s.state}</Badge></TableCell>
              <TableCell className="tabular-nums">{s.lastIngestAt === null ? "—" : fmtWhen(s.lastIngestAt, t)}</TableCell>
              <TableCell className="text-right tabular-nums">{fmtInt(s.rows, t)}</TableCell>
              <TableCell className="text-destructive">{s.lastError ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Muted>
        {t("sources.footer", {
          degraded: fmtInt(data.degradedThreads, t), size: fmtBytes(data.disk.bytes, t), pages: t("sources.pages", { n: data.disk.pages }),
          free: fmtInt(data.disk.freePages, t), rows: Object.entries(data.disk.rows).map(([name, n]) => `${name}: ${fmtInt(n, t)}`).join(" · "),
        })}
      </Muted>
    </Section>
  );
}

type Entry = PricesOutput["entries"][number];

function PriceRow({ entry }: { entry: Entry }) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Record<keyof Rates, string>>>({});
  const save = useMutation({ contract: rpcContract, method: "setPriceOverride" });
  // Each rate saves itself when its field loses focus (or on Enter), like bb's own settings; only reset is a button.
  const run = (rates: Partial<Rates> | null) =>
    save.mutate({ model: entry.model, rates }).then(() => { setDraft({}); if (!rates) toast.success(t("prices.resetDone")); }, (e) => { setDraft({}); toast.error(errorText(e)); });
  const commit = (k: keyof Rates) => {
    const v = draft[k];
    if (v === undefined || v === "" || Number(v) === entry.rates[k] || !(Number(v) >= 0)) { setDraft((d) => ({ ...d, [k]: undefined })); return; }
    void run({ [k]: Number(v) });
  };
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap font-medium">
        {entry.model}
        {entry.overridden && <Badge variant="secondary" className="ml-2 px-1.5 py-0 font-normal">{t("prices.changed")}</Badge>}
        {!entry.verified && <Badge variant="outline" className="ml-2 px-1.5 py-0 font-normal">{t("prices.unverified")}</Badge>}
      </TableCell>
      {FIELDS.map((k) => (
        <TableCell key={k}>
          <Input type="number" min={0} step="any" aria-label={`${entry.model}: ${t(`prices.${k}`)}`} className="h-7 w-full px-2 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            value={draft[k] ?? String(entry.rates[k])} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
            onBlur={() => commit(k)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        </TableCell>
      ))}
      <TableCell className="whitespace-nowrap text-right">
        {entry.overridden && <Button size="sm" variant="ghost" className="h-7" disabled={save.isPending} onClick={() => run(null)}>{t("prices.reset")}</Button>}
      </TableCell>
    </TableRow>
  );
}

function Prices() {
  const t = useT();
  const { data, isLoading } = useQuery({ contract: rpcContract, method: "prices", input: {} });
  if (!data) return isLoading ? <SkeletonBlock rows={4} /> : null;
  return (
    <Section title={t("prices.title", { version: data.version })}>
      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t("prices.model")}</TableHead>{/* Fixed rate columns; the header text ends where the field's value does (cell 8px + border 1px + field 8px). */}
            {FIELDS.map((k) => <TableHead key={k} className="w-20 pr-[17px] text-right align-bottom leading-tight">{t(`prices.${k}`)}</TableHead>)}<TableHead /></TableRow>
          </TableHeader>
          <TableBody>{data.entries.map((e) => <PriceRow key={e.model} entry={e} />)}</TableBody>
        </Table>
      </div>
    </Section>
  );
}

export function TokenomosSettings() {
  useHideNativeSettings();
  return <div data-tokenomos-settings className="space-y-6"><Configuration /><Sources /><Prices /></div>;
}
