/** In-app route of a task page; bb chat opens it as a normal Markdown link. */
export function taskHref(key: string): string {
  return `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;
}

/** Inline chat link for a task, e.g. [EXA-12](/plugins/work-board/work-board/task/EXA-12). */
export function taskMarkdownLink(key: string): string {
  return `[${key}](${taskHref(key)})`;
}

/** In-app route of a task's plan page. */
export function taskPlanHref(key: string): string {
  return `${taskHref(key)}/plan`;
}

/** Inline chat link for a task's plan, e.g. [EXA-12 plan](/plugins/work-board/work-board/task/EXA-12/plan). */
export function taskPlanMarkdownLink(key: string): string {
  return `[${key} plan](${taskPlanHref(key)})`;
}

/** Standing guidance for agents in bb projects linked to Work Board. */
export const TASK_LINK_INSTRUCTIONS = `# Work Board task links

When a reply to the person mentions a Work Board task, write its key as an inline Markdown link: [EXA-12](/plugins/work-board/work-board/task/EXA-12) (replace both EXA-12 with the real key). Clicking it opens the task in the thread side panel. Plain keys and these links are for bb chat only; GitHub, Slack and task comments use plain keys.

Before starting a task, read its dependencies with \`bb work-board dependency list KEY --json\`. Only Done satisfies a predecessor; canceled or reopened tasks remain blockers. Links warn without disabling commands: respect the ordering and report blockers.

When you need the owner, ask on the task, not in chat, with \`bb work-board question add KEY --kind decision|check\`.

Open the work-board skill before you take, plan, hand off or ask the owner on a task.`;
