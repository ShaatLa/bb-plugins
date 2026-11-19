import { useState } from "react";
import { PLAN_SUMMARY_MAX } from "../../shared/plan.js";
import { errorMessage } from "../../shared/errors.js";
import { useTasksRpc } from "../../shell/data.js";
import { PERSON_AUTHOR, planDrafts, type PlanDraft } from "./data.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** Where a refused save left the editor: someone else saved a newer version meanwhile. */
interface Conflict {
  /** The newest version now; null when it could not be read. */
  version: number | null;
}

/**
 * Plain Markdown source editor for a person. It edits the exact text that is stored (no rich-text round trip),
 * so the version diffs stay meaningful. The text is kept as a draft per task until it is saved or discarded.
 */
export function PlanEditor({
  taskId,
  taskKey,
  start,
  headVersion,
  onSaved,
  onCancel,
  onShowNew,
  onConflict,
}: {
  taskId: string;
  taskKey: string;
  /** Where a fresh edit starts from; a draft kept from earlier wins over it. */
  start: { text: string; version: number };
  headVersion: number;
  onSaved: () => void;
  /** Cancel: the draft is dropped. */
  onCancel: () => void;
  /** Leave the editor to read the newest version; the draft stays. */
  onShowNew: () => void;
  /** A save was refused because the plan moved on, so the view should reload it. */
  onConflict: () => void;
}) {
  const rpc = useTasksRpc();
  const [draft, setDraft] = useState<PlanDraft>(() => planDrafts.get(taskId) ?? { text: start.text, summary: "", baseVersion: start.version, original: start.text });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const change = (patch: Partial<Pick<PlanDraft, "text" | "summary">>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    if (next.text !== next.original || next.summary !== "") planDrafts.set(taskId, next);
    else planDrafts.delete(taskId);
  };

  const save = async (baseVersion: number) => {
    const summary = draft.summary.trim();
    if (summary === "") return setError("Describe what you changed in the summary");
    if (summary.length > PLAN_SUMMARY_MAX) return setError(`The summary exceeds ${PLAN_SUMMARY_MAX} characters`);
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      const result = await rpc.call("saveTaskPlan", { op: "replace", taskId, baseVersion, summary, body: draft.text, author: PERSON_AUTHOR });
      if (result.ok) {
        planDrafts.delete(taskId);
        onSaved();
      } else if (result.error.code === "plan_conflict") {
        const overview = await rpc.call("listTaskPlanVersions", { taskId }).catch(() => null);
        setConflict({ version: overview?.plan?.version ?? null });
        onConflict();
      } else setError(result.error.message);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <p className="text-xs text-muted-foreground">
        {draft.baseVersion === 0 ? `Writing the first plan for ${taskKey}` : `Editing ${taskKey} from v${draft.baseVersion}`} · Markdown source
      </p>
      <Textarea
        aria-label="Plan Markdown"
        spellCheck={false}
        autoFocus
        value={draft.text}
        disabled={saving}
        placeholder={"# Plan\n\n## Steps\n- …"}
        className="min-h-40 max-h-none flex-1 resize-none font-mono text-xs leading-5 [field-sizing:fixed]"
        onChange={(event) => change({ text: event.target.value })}
      />
      {conflict ? (
        <div role="alert" className="space-y-2 rounded-md border border-warning/40 p-2 text-sm">
          <p>{conflict.version === null ? "The plan changed while you were editing." : `The plan changed to v${conflict.version} while you were editing.`}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onShowNew}>Show the new version</Button>
            <Button size="sm" variant="destructive" disabled={saving} onClick={() => void save(conflict.version ?? headVersion)}>Overwrite with mine</Button>
          </div>
          <p className="text-xs text-muted-foreground">“Show the new version” keeps your text; copy it from the draft notice above the plan.</p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Summary of change"
          placeholder="Summary of change (required)"
          maxLength={PLAN_SUMMARY_MAX}
          value={draft.summary}
          disabled={saving}
          className="h-8 min-w-48 flex-1"
          onChange={(event) => change({ summary: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">{draft.summary.length}/{PLAN_SUMMARY_MAX}</span>
        <Button size="sm" disabled={saving} onClick={() => void save(draft.baseVersion)}>Save</Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => { planDrafts.delete(taskId); onCancel(); }}>Cancel</Button>
      </div>
    </div>
  );
}
