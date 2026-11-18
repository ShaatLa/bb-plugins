import { summaryLine } from './reports.ts';

const sections = { ANSWER: 'Owner answers', ACTION: 'Actions', WAIT: 'Waiting', STATE: 'State changes' };
const taskKey = '[A-Z][A-Z0-9]{0,9}-\\d+';
const leadingTask = new RegExp(`^(${taskKey})(?=[:\\s]|$)`);
const leadingThread = /^(?:@thread:)?(thr_[a-zA-Z0-9_-]+)(?=[:\s]|$)/;
const answer = new RegExp(`^(${taskKey}) ([\\w-]+): (.*)$`);
const blocker = new RegExp(`^(${taskKey}): blocker (${taskKey})$`);
const escapeInline = (text: string) => text.replace(/[\\`*_~\[\]<>|&]/g, '\\$&');
const taskLink = (key: string) => `[${key}](/plugins/work-board/work-board/task/${key})`;

function formatReference(text: string) {
  const key = leadingTask.exec(text)?.[1];
  if (key) return taskLink(key) + escapeInline(text.slice(key.length));
  const thread = leadingThread.exec(text);
  if (thread) return `@thread:${thread[1]}${escapeInline(text.slice(thread[0].length))}`;
  return escapeInline(text);
}

function formatItem(kind: string, detail: string) {
  if (kind === 'ANSWER') {
    const match = answer.exec(detail);
    if (match) return `${taskLink(match[1])} — ${escapeInline(match[3])} · \`${match[2]}\``;
  }
  if (kind === 'WAIT') {
    const match = blocker.exec(detail);
    if (match) return `${taskLink(match[1])} — blocked by ${taskLink(match[2])}`;
  }
  if (kind === 'ACTION') {
    const match = /^([a-z][a-z0-9-]*)[: ]\s*(\S.*)$/.exec(detail);
    if (match) return `\`${match[1].replaceAll('-', ' ')}\` · ${formatReference(match[2])}`;
  }
  return formatReference(detail);
}

function outputBlock(output: string) {
  let fenceLength = 3;
  for (const match of output.matchAll(/`{3,}/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}text\n${output}\n${fence}`;
}

export function formatNotification(status: 'alive' | number, output: string) {
  if (typeof status === 'number' && status >= 2) {
    const title = `**Sweep** · \`Check failed\` (exit ${status})`;
    return output.trim() ? `${title}\n\n${outputBlock(output.trimEnd())}` : title;
  }

  const title = status === 'alive' ? 'No new actions' : status === 1 ? 'Needs attention' : 'Check complete';
  const blocks = [`**Sweep** · \`${title}\``];
  const groups = new Map<string, string[]>();
  const other: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const summary = summaryLine.exec(line);
    if (summary) {
      blocks[0] += ` · ${summary[3]} to review · ${summary[1]} threads · ${summary[2]} cards checked`;
      continue;
    }
    const item = /^(ANSWER|ACTION|WAIT|STATE) (\S.*)$/.exec(line);
    if (!item) {
      other.push(line);
      continue;
    }
    const label = sections[item[1] as keyof typeof sections];
    const items = groups.get(label) ?? [];
    items.push(`- ${formatItem(item[1], item[2])}`);
    groups.set(label, items);
  }
  for (const [label, items] of groups) blocks.push(`**${label}**\n\n${items.join('\n')}`);
  const remaining = other.join('\n').trimEnd();
  if (remaining.trim()) blocks.push(outputBlock(remaining));
  return blocks.join('\n\n');
}
