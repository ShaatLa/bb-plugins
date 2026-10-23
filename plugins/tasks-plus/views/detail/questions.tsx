import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import type { TaskQuestion } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";

function QuestionAnswer({
  question,
  onSave,
  onError,
}: {
  question: TaskQuestion;
  onSave: (ids: string[]) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [selected, setSelected] = useState(question.selectedOptionIds);
  const [saving, setSaving] = useState(false);
  const unchanged =
    JSON.stringify([...selected].sort()) ===
    JSON.stringify([...question.selectedOptionIds].sort());
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
            onChange={(event) =>
              setSelected(
                question.mode === "single"
                  ? [option.id]
                  : event.target.checked
                    ? [...selected, option.id]
                    : selected.filter((id) => id !== option.id),
              )
            }
          />
          <span className="min-w-0 break-words">{option.label}</span>
        </label>
      ))}
      {question.answeredBy ? (
        <p className="text-xs text-muted-foreground">
          Answered by {question.answeredBy}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={unchanged || saving}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(selected);
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
          disabled={selected.length === 0 || saving}
          onClick={() => setSelected([])}
        >
          Clear selection
        </Button>
      </div>
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
  const [options, setOptions] = useState(["", ""]);
  const [multiple, setMultiple] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!adding && !query.error && !query.data?.length) return null;
  return (
    <section aria-label="Questions" className="mt-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Questions</h2>
        {adding ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => onAddingChange(false)}
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
          onSave={async (selectedOptionIds) => {
            const result = await rpc.call("answerQuestion", {
              questionId: question.id,
              revision: question.revision,
              selectedOptionIds,
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
      {adding ? (
        <form
          className="space-y-3 rounded-md border border-border p-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            try {
              await rpc.call("createQuestion", {
                taskId,
                prompt,
                mode: multiple ? "multiple" : "single",
                options,
              });
              onAddingChange(false);
              setPrompt("");
              setOptions(["", ""]);
              setMultiple(false);
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
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Option ${index + 1}`}
                placeholder={`Option ${index + 1}`}
                value={value}
                maxLength={500}
                required
                disabled={saving}
                onChange={(event) =>
                  setOptions((current) =>
                    current.map((option, at) =>
                      at === index ? event.target.value : option,
                    ),
                  )
                }
              />
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
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || options.length >= 20}
              onClick={() => setOptions((current) => [...current, ""])}
            >
              Add option
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={multiple}
                disabled={saving}
                onChange={(event) => setMultiple(event.target.checked)}
              />
              Allow multiple answers
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={
                saving ||
                !prompt.trim() ||
                options.some((option) => !option.trim())
              }
            >
              Create question
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
