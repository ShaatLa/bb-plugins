import { useState } from "react";
import { toast } from "sonner";
import { experimental_useRpcMutation as useMutation, experimental_useRpcQuery as useQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Rates } from "../contract";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { fmtBytes, fmtWhen } from "./format";
import { Muted, Section, SkeletonBlock } from "./shared";
import type { PricesOutput } from "./types";

const SOURCES: Record<string, string> = {
  "claude-file": "Claude Code (файлы)", "codex-file": "Codex (файлы)", "local-log": "Локальные модели (лог)",
  "agy-log": "Antigravity (лог)", "bb-events": "События bb",
};
const FIELDS: [keyof Rates, string][] = [
  ["input", "Вход"], ["output", "Выход"], ["cacheRead", "Чтение кэша"], ["cacheWriteShort", "Запись (короткая)"], ["cacheWriteLong", "Запись (длинная)"],
];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Sources() {
  const { data, isLoading } = useQuery({ contract: rpcContract, method: "status", input: {} });
  const prune = useMutation({ contract: rpcContract, method: "prune" });
  if (!data) return isLoading ? <SkeletonBlock rows={3} /> : null;
  const onPrune = () => prune.mutate({}).then((r) => toast.success(`Удалено строк: ${r.deletedRows}`), (e) => toast.error(errorText(e)));
  return (
    <Section title="Источники" action={<Button variant="outline" size="sm" disabled={prune.isPending} onClick={onPrune}>Очистить старые данные</Button>}>
      <Table>
        <TableHeader>
          <TableRow><TableHead>Источник</TableHead><TableHead>Состояние</TableHead><TableHead>Последний приём</TableHead><TableHead className="text-right">Строк</TableHead><TableHead>Ошибка</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {data.sources.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="font-medium">{SOURCES[s.id] ?? s.id}</TableCell>
              <TableCell><Badge variant="outline">{s.state}</Badge></TableCell>
              <TableCell className="tabular-nums">{s.lastIngestAt === null ? "—" : fmtWhen(s.lastIngestAt)}</TableCell>
              <TableCell className="text-right tabular-nums">{s.rows}</TableCell>
              <TableCell className="text-destructive">{s.lastError ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Muted>
        Деградировавших тредов: {data.degradedThreads} · база {fmtBytes(data.disk.bytes)} ({data.disk.pages} страниц, свободных {data.disk.freePages}) ·{" "}
        {Object.entries(data.disk.rows).map(([name, n]) => `${name}: ${n}`).join(" · ")}
      </Muted>
    </Section>
  );
}

type Entry = PricesOutput["entries"][number];

function PriceRow({ entry }: { entry: Entry }) {
  const [draft, setDraft] = useState<Partial<Record<keyof Rates, string>>>({});
  const save = useMutation({ contract: rpcContract, method: "setPriceOverride" });
  const changed = FIELDS.filter(([k]) => draft[k] !== undefined && draft[k] !== "" && Number(draft[k]) !== entry.rates[k]);
  const run = (rates: Partial<Rates> | null) =>
    save.mutate({ model: entry.model, rates }).then(() => { setDraft({}); toast.success(rates ? "Цена сохранена" : "Цена сброшена"); }, (e) => toast.error(errorText(e)));
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap font-medium">
        {entry.model}
        {entry.overridden && <Badge variant="secondary" className="ml-2 px-1.5 py-0 font-normal">изменено</Badge>}
        {!entry.verified && <Badge variant="outline" className="ml-2 px-1.5 py-0 font-normal">не проверено</Badge>}
      </TableCell>
      {FIELDS.map(([k, label]) => (
        <TableCell key={k}>
          <Input type="number" min={0} step="any" aria-label={`${entry.model}: ${label}`} className="h-8 w-24 text-right tabular-nums"
            value={draft[k] ?? String(entry.rates[k])} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        </TableCell>
      ))}
      <TableCell className="whitespace-nowrap text-right">
        <Button size="sm" variant="outline" disabled={!changed.length || save.isPending} onClick={() => run(Object.fromEntries(changed.map(([k]) => [k, Number(draft[k])])))}>Сохранить</Button>
        {entry.overridden && <Button size="sm" variant="ghost" className="ml-1" disabled={save.isPending} onClick={() => run(null)}>Сбросить</Button>}
      </TableCell>
    </TableRow>
  );
}

function Prices() {
  const { data, isLoading } = useQuery({ contract: rpcContract, method: "prices", input: {} });
  if (!data) return isLoading ? <SkeletonBlock rows={4} /> : null;
  return (
    <Section title={`Цены, $ за 1 млн токенов (версия ${data.version})`}>
      <div className="max-h-96 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow><TableHead>Модель</TableHead>{FIELDS.map(([k, label]) => <TableHead key={k} className="text-right">{label}</TableHead>)}<TableHead /></TableRow>
          </TableHeader>
          <TableBody>{data.entries.map((e) => <PriceRow key={e.model} entry={e} />)}</TableBody>
        </Table>
      </div>
    </Section>
  );
}

export function TokenomosSettings() {
  return <div className="space-y-6"><Sources /><Prices /></div>;
}
