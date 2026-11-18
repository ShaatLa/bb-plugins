import { isQuestionOpen } from "../../shared/questions";
import { useEffect, useMemo, useState, useRef } from "react";
import { experimental_ImageLightbox as ImageLightbox } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import type { TaskQuestion } from "../../shared/contract";
import { errorMessage } from "../../shared/errors";
import { LinkedText } from "../../components/linked-text";
import { clearAnswerDraft, readAnswerDraft, readAnswerFiles, sweepAnswerDrafts, writeAnswerDraft, writeAnswerFiles } from "./answer-draft";

import { uploadAttachment, Lightbox } from "./attachments";
import { AttachmentTracks } from "../activity/task-activity";
import { formatFileSize } from "../activity/time";
import { MAX_ATTACHMENT_SIZE_BYTES } from "../../shared/attachments";
import type { Attachment } from "../../shared/contract";

/** Files chosen for an answer, shown inside the answer box like bb's chat composer. */
function PendingFiles({ files, onRemove }: { files: readonly File[]; onRemove: (index: number) => void }) {
  const urls = useMemo(() => files.map(file => file.type.startsWith("image/") ? URL.createObjectURL(file) : null), [files]);
  useEffect(() => () => urls.forEach(url => url && URL.revokeObjectURL(url)), [urls]);
  const images = files.map((_, index) => index).filter(index => urls[index]);
  const [open, setOpen] = useState<number | null>(null);
  const at = open === null ? -1 : images.indexOf(open);
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-2">
      {files.map((file, index) => (
        <span key={`${index}:${file.name}`} className="group relative inline-flex items-center">
          {urls[index] ? (
            <button type="button" className="block size-14 overflow-hidden rounded-md border border-border" aria-label={`Preview ${file.name}`} onClick={() => setOpen(index)}>
              <img src={urls[index]!} alt={file.name} className="size-full object-cover" />
            </button>
          ) : (
            <span className="inline-flex h-14 max-w-48 items-center gap-1.5 rounded-md border border-border px-2 text-xs">
              <Icon name="File" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0"><span className="block truncate">{file.name}</span><span className="text-muted-foreground">{formatFileSize(file.size)}</span></span>
            </span>
          )}
          <button type="button" aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`}
            className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background text-[10px] leading-none text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(index)}>×</button>
        </span>
      ))}
      {open !== null && urls[open] ? (
        <ImageLightbox
          isOpen
          imageSrc={urls[open]!}
          imageAlt={files[open]!.name}
          title={files[open]!.name}
          hasMultipleImages={images.length > 1}
          previousDisabled={at <= 0}
          nextDisabled={at >= images.length - 1}
          onPrevious={() => setOpen(images[at - 1] ?? open)}
          onNext={() => setOpen(images[at + 1] ?? open)}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Saving an answer snapshots the unanswered state it replaces; that snapshot repeats the
 * current question, so only versions that were answered or worded differently are shown.
 */
function meaningfulHistory(question: TaskQuestion) {
  const states = [...question.history, question];
  return question.history.filter((entry, index) => {
    const next = states[index + 1]!;
    return Boolean(entry.answeredBy) || entry.prompt !== next.prompt || entry.mode !== next.mode ||
      JSON.stringify(entry.options.map(option => option.label)) !== JSON.stringify(next.options.map(option => option.label));
  });
}

function AnswerAttachments({ commentId }: { commentId: string }) {
  const query = useTasksQuery(async rpc => (await rpc.call("listAttachments", { commentId })).attachments, ["tasks:changed", "comments:changed"], [commentId]);
  const [image, setImage] = useState<Attachment | null>(null);
  return <>
    <AttachmentTracks attachments={query.data ?? []} onOpenImage={setImage} />
    {image ? <Lightbox attachment={image} onClose={() => setImage(null)} /> : null}
  </>;
}

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
  onSave: (ids: string[], answerText: string | null, files: File[]) => Promise<void>;
  onEdit: () => void;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const filesLoaded = useRef(false);
  useEffect(() => {
    let live = true;
    void readAnswerFiles(question.id, question.revision).then(saved => {
      if (!live) return;
      filesLoaded.current = true;
      if (saved.length) setFiles(current => current.length ? current : saved);
    });
    return () => { live = false; };
  }, [question.id, question.revision]);
  useEffect(() => {
    if (filesLoaded.current) void writeAnswerFiles(question.id, question.revision, files);
  }, [files, question.id, question.revision]);
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = (chosen: File[]) => {
    const valid = chosen.filter(file => {
      if (file.size <= MAX_ATTACHMENT_SIZE_BYTES) return true;
      onError(`File "${file.name}" exceeds the 25 MB attachment limit`);
      return false;
    });
    setFiles(current => [...current, ...valid]);
  };
  const [draft] = useState(() => readAnswerDraft(question.id, question.revision));
  const [selected, setSelected] = useState(draft?.selected ?? question.selectedOptionIds);
  const [other, setOther] = useState(draft?.other ?? question.answerText !== null);
  const [text, setText] = useState(draft?.text ?? question.answerText ?? "");
  useEffect(() => {
    const saved = JSON.stringify([...selected].sort()) === JSON.stringify([...question.selectedOptionIds].sort()) && text === (question.answerText ?? "");
    writeAnswerDraft(question.id, question.revision, saved ? null : { selected, other, text });
  }, [selected, other, text, question.id, question.revision, question.selectedOptionIds, question.answerText]);
  const answerText = other ? text.trim() || null : null;
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [saving, setSaving] = useState(false);
  const unchanged =
    JSON.stringify([...selected].sort()) ===
      JSON.stringify([...question.selectedOptionIds].sort()) &&
    answerText === question.answerText;
  return (
    <fieldset
      aria-label={question.prompt}
      className="space-y-2 rounded-md border border-border p-3"
      disabled={saving}
    >
      <legend className="max-w-full px-1 text-sm font-medium break-words">
        <LinkedText text={question.prompt} /> <span className="text-xs text-muted-foreground">{question.kind === "check" ? "Check" : "Decision"}</span>
      </legend>
      {question.steps.length ? (
        <ol aria-label="How to check" className="list-decimal space-y-1 pl-6 text-sm">
          {question.steps.map((step, index) => <li key={index} className="break-words"><LinkedText text={step} /></li>)}
        </ol>
      ) : null}
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
              if (question.mode === "single") { setOther(false); setText(""); }
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
      <div
        className="rounded-md border border-input focus-within:ring-1 focus-within:ring-ring"
        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={event => {
          if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }
        }}
      >
        {files.length ? <PendingFiles files={files} onRemove={index => setFiles(current => current.filter((_, at) => at !== index))} /> : null}
        <Textarea
          className="border-0 shadow-none focus-visible:ring-0"
          onPaste={event => {
            const pasted = Array.from(event.clipboardData.files);
            if (pasted.length) { event.preventDefault(); addFiles(pasted); }
          }}
          aria-label="Your answer"
          placeholder="Your answer (optional)"
          value={text}
          maxLength={10_000}
          onChange={(event) => {
            setText(event.target.value);
            setOther(Boolean(event.target.value.trim()));
            if (question.mode === "single") setSelected([]);
          }}
        />
        <div className="flex px-1.5 pb-1.5">
          <input ref={picker} type="file" multiple hidden aria-label="Answer files" onChange={event => {
            addFiles(Array.from(event.target.files ?? [])); event.target.value = "";
          }} />
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Attach files" onClick={() => picker.current?.click()}>
            <Icon name="Paperclip" className="size-4" />
          </Button>
        </div>
      </div>
      {question.answerCommentId ? <AnswerAttachments commentId={question.answerCommentId} /> : null}
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
          disabled={(unchanged && !files.length) || saving || (other && !answerText) || (files.length > 0 && !selected.length && !answerText)}
          onClick={async () => {
            setSaving(true);
            try {
              await onSave(selected, answerText, files);
              clearAnswerDraft(question.id);
              setFiles([]);
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
        {question.answeredBy ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={async () => {
              if (!confirmWithdraw) { setConfirmWithdraw(true); return; }
              setSaving(true);
              try {
                await onSave([], null, []);
                setSelected([]); setOther(false); setText("");
              } catch (error) {
                onError(errorMessage(error));
              } finally {
                setSaving(false);
                setConfirmWithdraw(false);
              }
            }}
          >
            {confirmWithdraw ? "Confirm: withdraw and notify the agent" : "Withdraw answer"}
          </Button>
        ) : null}
      </div>
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit question
      </Button>
      {meaningfulHistory(question).length ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            History · {meaningfulHistory(question).length}
          </summary>
          <ol className="mt-2 space-y-3">
            {[...meaningfulHistory(question)].reverse().map((entry) => (
              <li
                key={entry.revision}
                className="space-y-1 border-t border-border pt-2"
              >
                <p>
                  Revision {entry.revision} · {new Date(entry.updatedAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap break-words">
                  <LinkedText text={entry.prompt} />
                </p>
                <p>
                  {entry.mode === "single"
                    ? "Single choice"
                    : "Multiple choice"}
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
                  ].join("; ") || "none, replaced before an answer"}
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
  query,
  adding,
  onAddingChange,
  onError,
}: {
  taskId: string;
  query: ReturnType<typeof useTasksQuery<TaskQuestion[]>>;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onError: (message: string) => void;
}) {
  const rpc = useTasksRpc();
  useEffect(() => { void sweepAnswerDrafts(); }, []);
  const [prompt, setPrompt] = useState("");
  const [options, setOptions] = useState<
    (Omit<TaskQuestion["options"][number], "id"> & { id?: string })[]
  >([{ label: "" }, { label: "" }]);
  const [multiple, setMultiple] = useState(false);
  const [kind, setKind] = useState<"decision" | "check">("decision");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<TaskQuestion | null>(null);
  const [reopen, setReopen] = useState(false);
  useEffect(() => {
    if (!adding) return;
    setEditing(null);
    setPrompt("");
    setOptions([{ label: "" }, { label: "" }]);
    setMultiple(false);
    setKind("decision");
    setReopen(false);
  }, [adding]);
  const closeForm = () => {
    setEditing(null);
    onAddingChange(false);
  };
  const renderQuestion = (question: TaskQuestion) => (
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
            setKind(question.kind);
            setReopen(false);
          }}
          onSave={async (selectedOptionIds, answerText, files) => {
            const attachmentIds: string[] = [];
            let result;
            try {
              for (const file of files) attachmentIds.push((await uploadAttachment(file, { taskId })).attachmentId);
              result = await rpc.call("answerQuestion", {
              attachmentIds,
              questionId: question.id,
              revision: question.revision,
              selectedOptionIds,
              answerText,
              authorName: "You",
            });
            } catch (error) {
              await Promise.allSettled(attachmentIds.map(attachmentId => rpc.call("deleteAttachment", { attachmentId })));
              throw error;
            }
            query.refresh();
            if (result.notification === "failed")
              onError(
                "Answer saved, but the agent could not be notified. Notify its thread manually.",
              );
          }}
        />
  );
  // Open questions read in the order they were asked, like the Earlier list below.
  const open = (query.data ?? []).filter(isQuestionOpen)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const earlier = (query.data ?? []).filter(question => !isQuestionOpen(question))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
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
      {open.map(renderQuestion)}
      {earlier.length ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Earlier ({earlier.length})
          </summary>
          <div className="mt-3 space-y-3">{earlier.map(renderQuestion)}</div>
        </details>
      ) : null}
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
                  reopen,
                  authorName: "You",
                });
              } else {
                await rpc.call("createQuestion", {
                  taskId,
                  prompt,
                  mode: multiple ? "multiple" : "single",
                  options: normalizedOptions.map(({ id, ...option }) => option),
                  kind,
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
          {!editing ? (
            <label className="block text-sm">
              Type
              <select aria-label="Question type" value={kind} disabled={saving}
                onChange={event => {
                  const next = event.target.value as "decision" | "check";
                  setKind(next);
                  setOptions(next === "check"
                    ? [{ label: "Confirmed" }, { label: "Problem found" }]
                    : [{ label: "" }]);
                }}
              >
                <option value="decision">Decision</option>
                <option value="check">Check</option>
              </select>
            </label>
          ) : null}
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
                {options.length > 1 ? (
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
