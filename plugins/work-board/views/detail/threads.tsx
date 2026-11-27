import { BbLink } from "../../components/bb-link";
import { migrateBrowserPreferences } from "../../shell/migrate-preferences.js";
import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type {
  Preset,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import {
  PR_STATE_META,
} from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import { useTasksRpc } from "../../shell/data.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { ThreadChooserDialog } from "./thread-chooser-dialog";
import { useDefaultThread } from "./thread-preference";

export function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];
    return (
      <BbLink
        href={pullRequest.url}
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs font-medium shadow-2xs hover:border-input"
      >
        <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />#
        {pullRequest.number}
      </BbLink>
    );
  }
  if (unavailable) {
    return (
      <span
        title="Couldn't check this thread's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR unavailable
      </span>
    );
  }
  return null;
}

const LAST_PRESET_STORAGE_KEY = "bb-work-board:last-dispatch-preset";

function loadLastPresetId(): string | null {
  migrateBrowserPreferences();
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  migrateBrowserPreferences();
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  projectId: string;
  threads: TaskThread[];
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

function PresetDispatchControl({
  taskId,
  presets,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId: string) => {
    setDispatching(true);
    try {
      await rpc.call("delegate", { taskId, presetId });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  const primarySegment =
    "bg-primary text-primary-foreground hover:bg-primary/90";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("h-7 gap-1.5", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add a preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          size="sm"
          disabled={dispatching || !current}
          className={cn(
            "h-7 min-w-0 flex-1 gap-1.5 rounded-r-none",
            primarySegment,
          )}
          onClick={() => {
            if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching ? "Dispatching…" : (current?.name ?? "Dispatch")}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

export function DispatchControl(props: DispatchControlProps) {
  const [choosingThread, setChoosingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const defaultThread = useDefaultThread(props.projectId);
  const hasShortcut = Boolean(defaultThread);
  const rpc = useRpc<DelegationRpcContract>();
  const dispatch = async () => {
    if (!defaultThread) { setChoosingThread(true); return; }
    setSending(true);
    try {
      await rpc.call("delegateToThread", { taskId: props.taskId, threadId: defaultThread.id });
    } catch (error) {
      props.onError(errorMessage(error));
      setChoosingThread(true);
    } finally { setSending(false); }
  };
  if (props.threads.length) return null;
  return (
    <div className={cn("grid w-full min-w-0 gap-1.5", props.className)}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Unassigned</span>
      </div>
      {/* The chevron is a second door only when the main button does something else than open the chooser. */}
      <div className="flex min-w-0">
        <Button size="sm" variant="outline" disabled={sending} className={cn("h-7 min-w-0 flex-1", hasShortcut && "rounded-r-none")} aria-label={defaultThread ? `Send task to ${defaultThread.title}` : "Send to thread…"} onClick={() => void dispatch()}>
          <span className="truncate">{sending ? "Dispatching…" : defaultThread?.title ?? "Send to thread…"}</span>
        </Button>
        {hasShortcut ? <Button size="sm" variant="outline" disabled={sending} className="h-7 shrink-0 rounded-l-none border-l-0 px-1" aria-label="Choose another thread" onClick={() => setChoosingThread(true)}>
          <Icon name="ChevronDown" className="size-3.5" />
        </Button> : null}
      </div>
      <PresetDispatchControl {...props} className="w-full" />
      {choosingThread ? <ThreadChooserDialog kind="task" taskId={props.taskId} projectId={props.projectId} onClose={() => setChoosingThread(false)} /> : null}
    </div>
  );
}
