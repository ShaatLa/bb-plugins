/** In-app route of a task page; bb chat opens it as a normal Markdown link. */
export function taskHref(key: string): string {
  return `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;
}

/** Inline chat link for a task, e.g. [ANV-12](/plugins/work-board/work-board/task/ANV-12). */
export function taskMarkdownLink(key: string): string {
  return `[${key}](${taskHref(key)})`;
}

/** Standing guidance for agents in bb projects linked to Work Board. */
export const TASK_LINK_INSTRUCTIONS = `# Work Board task links

When a reply to the person mentions a Work Board task, write its key as an inline Markdown link: [ANV-12](/plugins/work-board/work-board/task/ANV-12) (replace both ANV-12 with the real key). bb opens it in the app. \`bb work-board show KEY\` and \`create\` print this link ready to copy. Use \`::task{key="ANV-12"}\` on its own line only when the person needs the live status card. Plain keys and these links are for bb chat only; GitHub, Slack and task comments use plain keys.`;
