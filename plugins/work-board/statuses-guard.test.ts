import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/**
 * No status id is special: what a status means comes from the project's workflow roles (`shared/status-roles.ts`). This
 * test fails when non-test source names a former system id in quotes outside the allow-list below, so a new hard-coded
 * status check cannot slip in. Every entry says why it may stay.
 */
const ROOT = __dirname;
const SCAN = /['"`](backlog|todo|in_progress|in_review|done|canceled)['"`]/;

/** file → [line pattern, reason]. A line is allowed when a pattern of its file matches it. */
const ALLOWED: Record<string, Array<[RegExp, string]>> = {
  "shared/status-roles.ts": [[/./, "the defaults of the roles a project leaves out: the one place that names the ids"]],
  "shared/statuses.ts": [[/./, "the default project statuses, their icons and the display fallbacks by id"]],
  "components/status-icon.tsx": [[/./, "default glyphs of a status with no icon set (display only)"]],
  "views/board/drop-position.ts": [[/./, "skeleton placeholder columns of the loading board (display only)"]],
  "views/embed/index.tsx": [[/StatusIcon status="backlog"/, "placeholder glyph of a card that was not found; no project is known"]],
  "db/schema.ts": [[/./, "migrations are immutable: they ran with these ids and keep their text"]],
  "cli/seed.ts": [[/./, "seed data creates statuses, it does not interpret them"]],
  "db/legacy-schedule-fixture.ts": [[/./, "fixture"]],
  "closure/fixture.ts": [[/./, "fixture"]],
  "attention/fixtures.ts": [[/./, "fixture"]],
  "test-fixtures.ts": [[/./, "fixture"]],
  "shared/scheduled.ts": [[/canceled/, "schedule-run states, not task statuses"]],
  "shared/plan.ts": [[/in_review/, "plan states"]],
  "shared/contract.ts": [[/SETTABLE_PLAN_STATES/, "plan states"], [/"launching"/, "scheduled-start states"]],
  "schedule/store.ts": [[/canceled/, "scheduled-start states and events, not task statuses"]],
  "schedule/service.ts": [[/state !== "canceled"|state: "canceled"/, "scheduled-start state, not a task status"]],
  "schedule/cli.ts": [[/case "canceled"/, "scheduled-start state, not a task status"]],
  "schedule/fixture.ts": [[/./, "fixture"]],
  "shared/badge.ts": [[/in_review/, "the badge criterion name"]],
  "shared/project-settings.ts": [[/statusNotificationsSchema/, "the notification mode value"]],
  "views/settings.tsx": [[/Done only/, "the notification mode value"]],
  "cli/index.ts": [[/status-notifications/, "the notification mode value"]],
  "plans/store.ts": [[/in_review|state/, "plan states"]],
  "plans/pause.ts": [[/in_review/, "plan states"]],
  "plans/notes.ts": [[/in_review/, "plan states"]],
  "attention/service.ts": [[/withdrawals/, "withdrawal states"]],
  "attention/dispatch-gate.ts": [[/withdrawals/, "withdrawal states"]],
  "pause/executor.ts": [[/withdrawals/, "withdrawal states"]],
  "steer/index.ts": [[/kind: "done"|"done"\)|=== "done"/, "append results"]],
  "git-sync/events.ts": [[/"done"/, "event-claim outcomes"]],
  "components/task-search.tsx": [[/BodyStatus|BODY_DONE/, "body loading states"]],
  "views/plan/card.tsx": [[/copied|setCopied/, "copy states"]],
  "status-notifications.ts": [[/statusNotifications === /, "the notification mode value"]],
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("names no former system status id outside the allow-list", () => {
  const offenders: string[] = [];
  for (const path of sources(ROOT)) {
    const file = relative(ROOT, path);
    const allowed = ALLOWED[file] ?? [];
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      if (SCAN.test(line) && !allowed.some(([pattern]) => pattern.test(line))) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  expect(offenders).toEqual([]);
});
