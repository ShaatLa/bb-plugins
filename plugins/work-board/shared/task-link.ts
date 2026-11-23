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

When a reply to the person mentions a Work Board task, write its key as an inline Markdown link: [EXA-12](/plugins/work-board/work-board/task/EXA-12) (replace both EXA-12 with the real key). Clicking it opens the task in the thread side panel. \`bb work-board show KEY\` and \`create\` print this link ready to copy. Use \`::task{key="EXA-12"}\` on its own line only when the person needs the live status card. Plain keys and these links are for bb chat only; GitHub, Slack and task comments use plain keys.

Before starting a task, read its dependencies with \`bb work-board dependency list KEY --json\`. Only Done satisfies a predecessor; canceled or reopened tasks remain blockers. Links warn without disabling commands: respect the ordering and report blockers. When you take a task from Backlog or Todo, move it as \`bb work-board show\` suggests (In progress, or the planning status when the project requires a plan) before you start; its epic follows automatically. Agents can add/remove links with \`bb work-board dependency add KEY --blocked-by OTHER\` and \`dependency remove KEY --blocked-by OTHER\`.

If a card you work on shows a \`Plan debt\` advisory (in \`bb work-board show KEY\`), it is in work without an approved plan: write the plan and submit it with \`bb work-board plan submit KEY --reviewer …\` now. Work Board reminds the card's executors after a decision is answered, a PR is linked and 24 h; \`bb work-board list --plan-debt\` lists such cards.

When you need the owner, ask on the task, not in chat, with \`bb work-board question add KEY --kind decision|check\`. One question asks one decision or one check in one or two short plain sentences, with at most one link. Put what the owner has to do in \`--step\` (repeat it; the steps show as a numbered list under the question), not in a comment. Split a multi-part acceptance into several \`--kind check\` questions, each answerable on its own with its own link. Evidence, tables, quotes of earlier remarks, inventories and history go into a task comment, not the question. Acceptance material is a link to a local design server or the product, never screenshots. When an existing check's state changes, never add a parallel check: edit an open one with \`question update\`, \`--reopen\` an answered one whose prompt and steps are unchanged, and replace it after any changed link or step with \`bb work-board question add KEY --kind check --supersedes ID --supersedes-revision N\`.

Repository-checks ownership: Work Board's row per BB project decides whether Work Board or Sweep runs the checks. Install Work Board first, then Sweep. Move state only for the owner or on the owner's instruction, with \`bb work-board checks import-from-sweep|export-to-sweep --project KEY\`; each leaves the receiver disabled and enabling stays the owner's action. When \`checks status\` shows an unconfirmed send to Sweep, rerun \`export-to-sweep\` (it resumes the same send); use \`abort-send\` only when Sweep keeps refusing it, and do not enable, run, reset, relink or delete meanwhile.`;
