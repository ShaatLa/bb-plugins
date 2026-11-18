/** In-app route of a task page; bb chat opens it as a normal Markdown link. */
export function taskHref(key: string): string {
  return `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;
}

/** Inline chat link for a task, e.g. [EXA-12](/plugins/work-board/work-board/task/EXA-12). */
export function taskMarkdownLink(key: string): string {
  return `[${key}](${taskHref(key)})`;
}

/** Standing guidance for agents in bb projects linked to Work Board. */
export const TASK_LINK_INSTRUCTIONS = `# Work Board task links

When a reply to the person mentions a Work Board task, write its key as an inline Markdown link: [EXA-12](/plugins/work-board/work-board/task/EXA-12) (replace both EXA-12 with the real key). Clicking it opens the task in the thread side panel. \`bb work-board show KEY\` and \`create\` print this link ready to copy. Use \`::task{key="EXA-12"}\` on its own line only when the person needs the live status card. Plain keys and these links are for bb chat only; GitHub, Slack and task comments use plain keys.

Before starting a task, read its dependencies with \`bb work-board dependency list KEY --json\`. Only Done satisfies a predecessor; canceled or reopened tasks remain blockers. Links warn without disabling commands: respect the ordering and report blockers. Agents can add/remove links with \`bb work-board dependency add KEY --blocked-by OTHER\` and \`dependency remove KEY --blocked-by OTHER\`.

When you need the owner, ask on the task with \`bb work-board question add KEY --kind decision|check\`. One question asks one decision or one check in one or two short plain sentences, with at most one link. Split a multi-part acceptance into several \`--kind check\` questions, each answerable on its own with its own link. Evidence, tables, quotes of earlier remarks, inventories and history go into a task comment, not the question. Acceptance material is a link to a local design server or the product, never screenshots.`;
