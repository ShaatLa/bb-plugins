/**
 * Stable entry for other plugins that render a Work Board task inside their own UI.
 * The view is the one Work Board's thread "task" tab shows, bound to Work Board's
 * backend through `host` instead of the embedding plugin's SDK hooks.
 */
import { useEffect, useMemo, useState } from "react";
import { DialogScope } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TasksRefreshProvider } from "./shell/refresh.js";
import { TaskStatusesProvider } from "./shell/task-statuses.js";
import { TasksNavigationContext, tasksRouteToSubPath, type TasksNavigation } from "./shell/routes.js";
import { WorkBoardHostProvider, type WorkBoardHost } from "./shell/host.js";
import { DetailView } from "./views/detail/index.js";

export type { WorkBoardHost } from "./shell/host.js";

export interface WorkBoardTaskEmbedProps {
  /** Task key such as `TSK-4`. */
  taskKey: string;
  host: WorkBoardHost;
  /** Back button target once the user is on `taskKey` itself; the button does nothing without it. */
  onBack?: () => void;
}

export function WorkBoardTaskEmbed({ taskKey, host, onBack }: WorkBoardTaskEmbedProps) {
  // Links to other tasks open in place; back returns to the requested task first.
  const [shownKey, setShownKey] = useState(taskKey);
  useEffect(() => setShownKey(taskKey), [taskKey]);
  const navigation = useMemo<TasksNavigation>(() => ({
    go: (route) => {
      if (route.kind === "task") setShownKey(route.taskKey);
      else host.openInWorkBoard?.(tasksRouteToSubPath(route));
    },
  }), [host]);
  const openInWorkBoard = host.openInWorkBoard;

  return (
    <WorkBoardHostProvider value={host}>
      <DialogScope className="relative h-full min-h-0">
        <TasksRefreshProvider>
          <TaskStatusesProvider>
            <TasksNavigationContext.Provider value={navigation}>
              <div className="h-full min-h-0 overflow-y-auto">
                <DetailView
                  taskKey={shownKey}
                  onBack={() => (shownKey === taskKey ? onBack?.() : setShownKey(taskKey))}
                  backLabel={shownKey === taskKey ? "Back" : `Back to ${taskKey}`}
                  headerActions={openInWorkBoard ? (
                    <Button
                      className="size-6 shrink-0"
                      size="icon"
                      variant="ghost"
                      aria-label={`Open ${shownKey} in Work Board`}
                      onClick={() => openInWorkBoard(tasksRouteToSubPath({ kind: "task", taskKey: shownKey }))}
                    >
                      <Icon name="ArrowUpRight" className="size-4" />
                    </Button>
                  ) : undefined}
                />
              </div>
            </TasksNavigationContext.Provider>
          </TaskStatusesProvider>
        </TasksRefreshProvider>
      </DialogScope>
    </WorkBoardHostProvider>
  );
}
