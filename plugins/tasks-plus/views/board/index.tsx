import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  type Label,
  type Task,
  type TaskStatus,
  type TaskThread,
} from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { NewTaskDialog } from "../manage/new-task-dialog.js";
import {
  applyBoardMove,
  BOARD_STATUSES,
  dropIndexForPointer,
  dropNeighborsForIndex,
  visibleBoardStatuses,
} from "./drop-position.js";
import { PriorityIcon, StatusIcon } from "./icons.js";
import {
  EMPTY_META,
  fetchBoard,
  patchBoard,
  type BoardCardMeta,
  type BoardData,
} from "./board-data.js";
import { labelFilterOptions, selectedLabelIds, STATUS_LABELS } from "../list/lib.js";
import { ListFilterBar, type ListFilterState } from "../list/filter-bar.js";
import { listPreferenceScope, loadListPreference, storeListPreference } from "../list/list-preference.js";
import { matchesFilters } from "../list/optimistic.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { QuestionCount, useQuestionCounts } from "../../components/question-count";

const DRAG_THRESHOLD_PX = 5;

type ColumnMap = Record<TaskStatus, Task[]>;

function groupColumns(tasks: readonly Task[]): ColumnMap {
  const columns: ColumnMap = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  };
  for (const task of tasks) columns[task.status].push(task);
  return columns;
}

interface DragState {
  taskId: string;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  width: number;
  overStatus: TaskStatus | null;
  dropIndex: number;
}

function WorkingAgentsChip({ threads }: { threads: TaskThread[] }) {
  if (threads.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-success">
      <span
        aria-hidden
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
      />
      <span className="truncate">
        {threads.length === 1
          ? threads[0]!.presetName
          : `${threads.length} agents`}
      </span>
    </span>
  );
}

interface TaskCardProps {
  unansweredQuestions?: number;
  task: Task;
  labelsById: Map<string, Label>;
  meta: BoardCardMeta;
  ghost?: boolean;
  dragging?: boolean;
  cardRef?: (element: HTMLDivElement | null) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}

function TaskCard({
  unansweredQuestions,
  task,
  labelsById,
  meta,
  ghost = false,
  dragging = false,
  cardRef,
  onPointerDown,
  onClick,
}: TaskCardProps) {
  const labels = task.labelIds
    .map((labelId) => labelsById.get(labelId))
    .filter((label): label is Label => label !== undefined);
  return (
    <div
      ref={cardRef}
      data-task-key={task.key}
      title={task.title}
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-lg border border-border bg-card px-2.5 py-2 shadow-2xs select-none",
        ghost
          ? "rotate-2 shadow-md"
          : "cursor-pointer touch-none hover:border-input",
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="tabular-nums">{task.key}</span>
        {task.type === "epic" ? <span className="inline-flex items-center gap-1"><Icon name="Zap" className="size-3" />Epic</span> : null}
        <WorkingAgentsChip threads={meta.workingThreads} />
      </div>
      <div className="mt-1 line-clamp-3 text-sm leading-snug font-medium">
        {task.title}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <QuestionCount count={unansweredQuestions} />
        <PriorityIcon priority={task.priority} />
        {labels.map((label) => (
          <span
            key={label.id}
            className="flex items-center gap-1 rounded-md border border-border px-1.5 text-2xs text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            {label.name}
          </span>
        ))}
        {meta.subTotal > 0 ? (
          <span className="flex items-center gap-0.5 text-2xs text-muted-foreground">
            <Icon name="GitBranch" className="size-3" />
            {meta.subDone}/{meta.subTotal}
          </span>
        ) : null}
        {meta.attachmentCount > 0 ? (
          <Icon
            name="Paperclip"
            className="size-3 text-muted-foreground"
            aria-label={`${meta.attachmentCount} attachments`}
          />
        ) : null}
      </div>
    </div>
  );
}

function BoardSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex h-full items-start gap-3 overflow-x-auto p-4">
        {BOARD_STATUSES.map((status) => (
          <div
            key={status}
            className="flex w-[230px] shrink-0 flex-col gap-2 p-1"
          >
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

interface BoardViewProps {
  projectId: string;
}

export function BoardView({ projectId }: BoardViewProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const preferenceScope = listPreferenceScope(projectId, false);
  const [filters, setFilters] = useState(() => loadListPreference(preferenceScope).filters);
  useEffect(() => {
    setFilters(loadListPreference(preferenceScope).filters);
  }, [preferenceScope]);
  const changeFilters = (next: ListFilterState) => {
    storeListPreference(preferenceScope, { ...loadListPreference(preferenceScope), filters: next });
    setFilters(next);
  };
  const board = useTasksQuery<BoardData>(
    (queryRpc) => fetchBoard(queryRpc, projectId),
    ["tasks:changed", "projects:changed", "threads:changed"],
    [projectId],
    {
      applySignals: (queryRpc, current, signals) =>
        patchBoard(queryRpc, projectId, current, signals),
    },
  );

  const [columns, setColumns] = useState<ColumnMap | undefined>(undefined);
  const questionCounts = useQuestionCounts(board.data?.tasks ?? []);
  useEffect(() => {
    setColumns(undefined);
  }, [projectId]);
  useEffect(() => {
    if (board.data) setColumns(groupColumns(board.data.tasks));
  }, [board.data]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const labelOptions = labelFilterOptions([...(board.data?.labelsById.values() ?? [])]);
  const labelIds = selectedLabelIds(labelOptions, filters.labelNames);
  const visibleColumns = columns && groupColumns(Object.values(columns).flat().filter((task) =>
    (!filters.unansweredOnly || (questionCounts.data?.get(task.id) ?? 0) > 0) &&
    (filters.type === undefined || task.type === filters.type) &&
    (filters.labelNames.length === 0 || labelIds.length > 0) &&
    matchesFilters(task, filters.statuses, filters.priorities, labelIds),
  ));
  const visibleColumnsRef = useRef(visibleColumns);
  visibleColumnsRef.current = visibleColumns;

  const [drag, setDrag] = useState<DragState | null>(null);
  const [quickAddStatus, setQuickAddStatus] = useState<TaskStatus | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<TaskStatus, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const findDropTarget = (
    x: number,
    y: number,
    draggedTaskId: string,
  ): { status: TaskStatus; index: number } | null => {
    const current = visibleColumnsRef.current;
    if (!current) return null;
    const boardRect = boardRef.current?.getBoundingClientRect();
    if (
      boardRect &&
      (y < boardRect.top - 24 ||
        y > boardRect.bottom + 24 ||
        x < boardRect.left ||
        x > boardRect.right)
    ) {
      return null;
    }
    for (const status of visibleBoardStatuses(current)) {
      const columnElement = columnRefs.current.get(status);
      if (!columnElement) continue;
      const rect = columnElement.getBoundingClientRect();
      if (x < rect.left - 6 || x > rect.right + 6) continue;
      const centers = current[status]
        .filter((task) => task.id !== draggedTaskId)
        .map((task) => {
          const cardElement = cardRefs.current.get(task.id);
          if (!cardElement) return Number.NEGATIVE_INFINITY;
          const cardRect = cardElement.getBoundingClientRect();
          return cardRect.top + cardRect.height / 2;
        });
      return { status, index: dropIndexForPointer(centers, y) };
    }
    return null;
  };

  const commitDrop = (
    taskId: string,
    toStatus: TaskStatus,
    dropIndex: number,
  ) => {
    const current = columnsRef.current;
    const visible = visibleColumnsRef.current;
    if (!current || !visible) return;
    const neighbors = dropNeighborsForIndex(
      visible[toStatus].map((task) => task.id),
      taskId,
      dropIndex,
    );
    // Keep hidden cards in place when translating a filtered drop to the full column.
    const remaining = current[toStatus].filter((task) => task.id !== taskId);
    const fullIndex = neighbors.afterTaskId !== null
      ? remaining.findIndex((task) => task.id === neighbors.afterTaskId)
      : neighbors.beforeTaskId !== null
        ? remaining.findIndex((task) => task.id === neighbors.beforeTaskId) + 1
        : remaining.length;
    setColumns(applyBoardMove(current, taskId, toStatus, fullIndex));
    void rpc
      .call("boardMove", {
        taskId,
        status: toStatus,
        beforeTaskId: neighbors.beforeTaskId,
        afterTaskId: neighbors.afterTaskId,
        authorName: "You",
      })
      .then(
        (result) => {
          if (!result.ok) board.refresh();
        },
        () => board.refresh(),
      );
  };

  const handleCardPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    task: Task,
  ) => {
    if (event.button !== 0 || dragCleanupRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const start = {
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    };
    let active = false;

    const updateDrag = (moveEvent: PointerEvent) => {
      const target = findDropTarget(
        moveEvent.clientX,
        moveEvent.clientY,
        task.id,
      );
      setDrag({
        taskId: task.id,
        x: moveEvent.clientX,
        y: moveEvent.clientY,
        offsetX: start.offsetX,
        offsetY: start.offsetY,
        width: start.width,
        overStatus: target?.status ?? null,
        dropIndex: target?.index ?? 0,
      });
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!active) {
        const distance = Math.hypot(
          moveEvent.clientX - start.x,
          moveEvent.clientY - start.y,
        );
        if (distance < DRAG_THRESHOLD_PX) return;
        active = true;
      }
      moveEvent.preventDefault();
      updateDrag(moveEvent);
    };
    const finish = (upEvent: PointerEvent | null) => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      if (!active) return;
      if (upEvent) {
        const target = findDropTarget(
          upEvent.clientX,
          upEvent.clientY,
          task.id,
        );
        if (target) commitDrop(task.id, target.status, target.index);
      }
      setDrag(null);
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const onUp = (upEvent: PointerEvent) => finish(upEvent);
    const onCancel = () => finish(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  const openTask = (task: Task) => {
    if (suppressClickRef.current) return;
    navigation.go({ kind: "task", taskKey: task.key });
  };

  if (columns === undefined || visibleColumns === undefined) {
    if (board.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
          <p>Failed to load the board: {board.error}</p>
          <Button variant="outline" size="sm" onClick={board.refresh}>
            Retry
          </Button>
        </div>
      );
    }
    return <BoardSkeleton />;
  }

  const labelsById = board.data?.labelsById ?? new Map<string, Label>();
  const metaByTaskId =
    board.data?.metaByTaskId ?? new Map<string, BoardCardMeta>();
  const ghostTask = drag
    ? Object.values(columns)
        .flat()
        .find((task) => task.id === drag.taskId)
    : undefined;

  const renderColumn = (status: TaskStatus) => {
    const cards = visibleColumns[status];
    const isDragOver = drag !== null && drag.overStatus === status;
    const remaining = drag
      ? cards.filter((task) => task.id !== drag.taskId)
      : cards;
    const indicatorBeforeTaskId = isDragOver
      ? (remaining[drag.dropIndex]?.id ?? null)
      : undefined;
    const indicator = (
      <div
        key="drop-indicator"
        className="h-0.5 shrink-0 rounded-full bg-primary"
      />
    );
    const children: ReactNode[] = [];
    for (const task of cards) {
      if (task.id === indicatorBeforeTaskId) children.push(indicator);
      children.push(
        <TaskCard
          key={task.id}
          task={task}
          labelsById={labelsById}
          meta={metaByTaskId.get(task.id) ?? EMPTY_META}
          unansweredQuestions={questionCounts.data?.get(task.id)}
          dragging={drag?.taskId === task.id}
          cardRef={(element) => {
            if (element) cardRefs.current.set(task.id, element);
            else cardRefs.current.delete(task.id);
          }}
          onPointerDown={(event) => handleCardPointerDown(event, task)}
          onClick={() => openTask(task)}
        />,
      );
    }
    if (indicatorBeforeTaskId === null) children.push(indicator);

    return (
      <div key={status} className="flex max-h-full min-w-[230px] flex-1 basis-[230px] flex-col">
        <div className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold">
          <StatusIcon status={status} />
          <span>{STATUS_LABELS[status]}</span>
          <span className="font-normal text-muted-foreground">
            {cards.length}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-6 text-muted-foreground"
            aria-label={`New ${STATUS_LABELS[status]} task`}
            onClick={() => setQuickAddStatus(status)}
          >
            <Icon name="Plus" className="size-3.5" />
          </Button>
        </div>
        <div
          ref={(element) => {
            if (element) columnRefs.current.set(status, element);
            else columnRefs.current.delete(status);
          }}
          data-board-column={status}
          className={cn(
            "flex min-h-16 flex-col gap-2 overflow-y-auto rounded-lg p-1",
            isDragOver &&
              "bg-surface-selected outline-2 outline-dashed outline-input",
          )}
        >
          {children}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        projectId={projectId}
        filters={filters}
        onChange={changeFilters}
        labelOptions={labelOptions}
        taskCount={Object.values(visibleColumns).reduce((count, tasks) => count + tasks.length, 0)}
      />
      {filters.unansweredOnly && questionCounts.error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">Couldn't load question counts. <Button size="sm" variant="ghost" onClick={questionCounts.refresh}>Retry questions</Button></p>
      ) : null}
    <div
      ref={boardRef}
      className={cn(
        "flex min-h-0 flex-1 items-start gap-3 overflow-x-auto p-4",
        drag !== null && "cursor-grabbing",
      )}
    >
      {visibleBoardStatuses(visibleColumns).map(renderColumn)}
      {drag && ghostTask ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: drag.x - drag.offsetX,
            top: drag.y - drag.offsetY,
            width: drag.width,
          }}
        >
          <TaskCard
            task={ghostTask}
            labelsById={labelsById}
            meta={metaByTaskId.get(ghostTask.id) ?? EMPTY_META}
            unansweredQuestions={questionCounts.data?.get(ghostTask.id)}
            ghost
          />
        </div>
      ) : null}
      <NewTaskDialog
        open={quickAddStatus !== null}
        onOpenChange={(open) => {
          if (!open) setQuickAddStatus(null);
        }}
        projectId={projectId}
        defaultStatus={quickAddStatus ?? undefined}
      />
    </div>
    </div>
  );
}
