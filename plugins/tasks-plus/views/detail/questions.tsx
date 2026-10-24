import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import type { TaskQuestion } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";

// shortcut: Honor explicit legacy suffixes until old questions carry recommendation metadata.
const LEGACY_RECOMMENDATION = /\s*\((?:рекомендую|recommended)\)\s*$/i;

function OptionText({ option }: { option: TaskQuestion["options"][number] }) {
  const legacy =
    option.recommended === undefined &&
    LEGACY_RECOMMENDATION.test(option.label);
  const label = legacy
    ? option.label.replace(LEGACY_RECOMMENDATION, "")
    : option.label;
  return (
    <span className="min-w-0 break-words">
      {option.recommended || legacy ? (
        <strong className="font-semibold">{label}</strong>
      ) : (
        label
      )}
      {option.recommendationReason ? (
        <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
          {option.recommendationReason}
        </span>
      ) : null}
    </span>
  );
}

function QuestionAnswer({
  question,
  onSave,
  onEdit,
  onError,
}: {
  question: TaskQuestion;
  onSave: (ids: string[], answerText: string | null) => Promise<void>;
  onEdit: () => void;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState(question.selectedOptionIds);
  const [other, setOther] = useState(question.answerText !== null);
  const [text, setText] = useState(question.answerText ?? "");
  const answerText = other ? text.trim() || null : null;
  const [saving, setSaving] = useState(false);
  const unchanged =
    JSON.stringify([...selected].sort()) ===
      JSON.stringify([...question.selectedOptionIds].sort()) &&
    answerText === question.answerText;
  return (
    <fieldset
      className="space-y-2 rounded-md border border-border p-3"
      disabled={saving}
    >
      <legend className="max-w-full px-1 text-sm font-medium break-words">
        {question.prompt}
      </legend>
      <p className="text-xs text-muted-foreground">
        {question.mode === "single"
          ? "Choose one answer"
          : "Choose one or more answers"}
      </p>
      {question.options.map((option) => (
        <label
          key={option.id}
          className="flex cursor-pointer items-start gap-2 text-sm"
        >
          <input
            className="mt-0.5 size-4 shrink-0 accent-primary"
            type={question.mode === "single" ? "radio" : "checkbox"}
            name={question.id}
            checked={selected.includes(option.id)}
            onChange={(event) => {
              if (question.mode === "single") setOther(false);
              setSelected(
                question.mode === "single"
                  ? [option.id]
                  : event.target.checked
                    ? [...selected, option.id]
                    : selected.filter((id) => id !== option.id),
              );
            }}
          />
          <OptionText option={option} />
        </label>
      ))}
      {question.allowOther ? (
        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type={question.mode === "single" ? "radio" : "checkbox"}
              name={question.id}
              checked={other}
              onChange={(event) => {
                setOther(event.target.checked);
                if (question.mode === "single") setSelected([]);
              }}
            />
            Other answer
          </label>
          {other ? (
            <Textarea
              aria-label="Your answer"
              value={text}
              maxLength={10_000}
              required
              onChange={(event) => setText(event.target.value)}
            />
          ) : null}
        </div>
      ) : null}
      {question.answeredBy ? (
        <p className="text-xs text-muted-foreground">
          Answered by {question.answeredBy}
        </p>
      ) : null}
      {!question.answeredBy &&
      question.history.some((entry) => entry.answeredBy) ? (
        <p className="text-xs text-warning">
          A new answer is required. Previous decisions are retained in history.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={unchanged || saving || (other && !answerText)}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(selected, answerText);
            } catch (error) {
              onError(errorMessage(error));
            } finally {
              setSaving(false);
            }
          }}
        >
          Save answer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={(selected.length === 0 && !other) || saving}
          onClick={() => {
            setSelected([]);
            setOther(false);
            setText("");
          }}
        >
          Clear selection
        </Button>
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit question
      </Button>
      {question.history.length ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            History · {question.history.length}
          </summary>
          <ol className="mt-2 space-y-3">
            {[...question.history].reverse().map((entry) => (
              <li
                key={entry.revision}
                className="space-y-1 border-t border-border pt-2"
              >
                <p>
                  Revision {entry.revision} · {entry.updatedAt}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  {entry.prompt}
                </p>
                <p>
                  {entry.mode === "single"
                    ? "Single choice"
                    : "Multiple choice"}
                  {entry.allowOther ? " · Other answer allowed" : ""}
                </p>
                <ul>
                  {entry.options.map((option) => (
                    <li key={option.id} className="break-words">
                      {entry.selectedOptionIds.includes(option.id)
                        ? "✓ "
                        : "• "}
                      <OptionText option={option} />
                    </li>
                  ))}
                </ul>
                <p className="whitespace-pre-wrap break-words">
                  Answer:{" "}
                  {[
                    ...entry.options
                      .filter((option) =>
                        entry.selectedOptionIds.includes(option.id),
                      )
                      .map((option) => option.label),
                    ...(entry.answerText ? [entry.answerText] : []),
                  ].join("; ") || "(unanswered)"}
                  {entry.answeredBy ? ` · ${entry.answeredBy}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </fieldset>
  );
}

export function QuestionsSection({
  taskId,
  adding,
  onAddingChange,
  onError,
}: {
  taskId: string;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onError: (message: string) => void;
}) {
  const rpc = useTasksRpc();
  const query = useTasksQuery(
    async (client) =>
      (await client.call("listQuestions", { taskId })).questions,
    ["tasks:changed"],
    [taskId],
  );
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState<
    (Omit<TaskQuestion["options"][number], "id"> & { id?: string })[]
  >([{ label: "" }, { label: "" }]);
  const [multiple, setMultiple] = useState(false);
  const [allowOther, setAllowOther] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<TaskQuestion | null>(null);
  const [reopen, setReopen] = useState(false);
  useEffect(() => {
    if (!adding) return;
    setEditing(null);
    setPrompt("");
    setOptions([{ label: "" }, { label: "" }]);
    setMultiple(false);
    setAllowOther(false);
    setReopen(false);
  }, [adding]);
  const closeForm = () => {
    setEditing(null);
    onAddingChange(false);
  };
  if (!adding && !editing && !query.error && !query.data?.length) return null;
  return (
    <section aria-label="Questions" className="mt-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Questions</h2>
        {adding || editing ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={closeForm}
          >
            Cancel question
          </Button>
        ) : null}
      </div>
      {query.error ? (
        <div className="text-sm text-muted-foreground">
          Couldn't load questions.{" "}
          <Button variant="ghost" size="sm" onClick={query.refresh}>
            Retry questions
          </Button>
        </div>
      ) : null}
      {(query.data ?? []).map((question) => (
        <QuestionAnswer
          key={`${question.id}:${question.revision}`}
          question={question}
          onError={onError}
          onEdit={() => {
            onAddingChange(false);
            setEditing(question);
            setPrompt(question.prompt);
            setOptions(question.options);
            setMultiple(question.mode === "multiple");
            setAllowOther(question.allowOther);
            setReopen(false);
          }}
          onSave={async (selectedOptionIds, answerText) => {
            const result = await rpc.call("answerQuestion", {
              questionId: question.id,
              revision: question.revision,
              selectedOptionIds,
              answerText,
              authorName: "You",
            });
            query.refresh();
            if (result.notification === "failed")
              onError(
                "Answer saved, but the agent could not be notified. Notify its thread manually.",
              );
          }}
        />
      ))}
      {adding || editing ? (
        <form
          className="space-y-3 rounded-md border border-border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            try {
              const normalizedOptions = options.map((option) => ({
                ...(option.id ? { id: option.id } : {}),
                label: option.label,
                ...(option.recommended !== undefined
                  ? { recommended: option.recommended }
                  : {}),
                ...(option.recommendationReason !== undefined
                  ? { recommendationReason: option.recommendationReason }
                  : {}),
              }));
              if (editing) {
                await rpc.call("updateQuestion", {
                  questionId: editing.id,
                  revision: editing.revision,
                  prompt,
                  mode: multiple ? "multiple" : "single",
                  options: normalizedOptions,
                  allowOther,
                  reopen,
                  authorName: "You",
                });
              } else {
                await rpc.call("createQuestion", {
                  taskId,
                  prompt,
                  mode: multiple ? "multiple" : "single",
                  options: normalizedOptions.map(({ id, ...option }) => option),
                  allowOther,
                });
              }
              closeForm();
              query.refresh();
            } catch (error) {
              onError(errorMessage(error));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Textarea
            autoFocus
            aria-label="Question"
            placeholder="What needs to be decided?"
            value={prompt}
            maxLength={10_000}
            required
            disabled={saving}
            onChange={(event) => setPrompt(event.target.value)}
          />
          {options.map((value, index) => (
            <div key={index} className="space-y-2">
              <div className="flex items-center gap-2">
                <Input
                  aria-label={`Option ${index + 1}`}
                  placeholder={`Option ${index + 1}`}
                  value={value.label}
                  maxLength={500}
                  required
                  disabled={saving}
                  onChange={(event) =>
                    setOptions((current) =>
                      current.map((option, at) =>
                        at === index
                          ? { ...option, label: event.target.value }
                          : option,
                      ),
                    )
                  }
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label={`Recommend option ${index + 1}`}
                    checked={value.recommended === true}
                    disabled={saving}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setOptions((current) =>
                        current.map((option, at) =>
                          at === index
                            ? {
                                ...option,
                                recommended: checked || undefined,
                                recommendationReason: checked
                                  ? option.recommendationReason
                                  : undefined,
                              }
                            : !multiple && checked
                              ? {
                                  ...option,
                                  recommended: undefined,
                                  recommendationReason: undefined,
                                }
                              : option,
                        ),
                      );
                    }}
                  />
                  Recommend
                </label>
                {options.length > 2 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    aria-label={`Remove option ${index + 1}`}
                    onClick={() =>
                      setOptions((current) =>
                        current.filter((_, at) => at !== index),
                      )
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              {value.recommended ? (
                <Textarea
                  aria-label={`Recommendation reason ${index + 1}`}
                  placeholder="Why this option? (optional)"
                  value={value.recommendationReason ?? ""}
                  maxLength={2000}
                  disabled={saving}
                  onChange={(event) => {
                    const reason = event.target.value;
                    setOptions((current) =>
                      current.map((option, at) =>
                        at === index
                          ? {
                              ...option,
                              recommendationReason: reason.trim()
                                ? reason
                                : undefined,
                            }
                          : option,
                      ),
                    );
                  }}
                />
              ) : null}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || options.length >= 20}
              onClick={() =>
                setOptions((current) => [...current, { label: "" }])
              }
            >
              Add option
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={multiple}
                disabled={saving}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setMultiple(checked);
                  if (!checked) {
                    const first = options.findIndex(
                      (option) => option.recommended,
                    );
                    setOptions((current) =>
                      current.map((option, index) =>
                        index === first
                          ? option
                          : {
                              ...option,
                              recommended: undefined,
                              recommendationReason: undefined,
                            },
                      ),
                    );
                  }
                }}
              />
              Allow multiple answers
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowOther}
                disabled={saving}
                onChange={(event) => setAllowOther(event.target.checked)}
              />
              Allow other answer
            </label>
            {editing?.answeredBy ? (
              <label className="flex items-start gap-2 text-sm text-warning">
                <input
                  type="checkbox"
                  checked={reopen}
                  disabled={saving}
                  onChange={(event) => setReopen(event.target.checked)}
                />
                Clear the saved answer and request a new decision
              </label>
            ) : null}
            <Button
              type="submit"
              size="sm"
              disabled={
                saving ||
                !prompt.trim() ||
                options.some((option) => !option.label.trim()) ||
                Boolean(editing?.answeredBy && !reopen)
              }
            >
              {editing ? "Save question" : "Create question"}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
