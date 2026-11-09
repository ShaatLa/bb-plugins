import type { ExperimentalComposerMentionTarget, PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
export type ThreadLabel = { projectId?: string; label: string };
export const threadToken = /@thread:(thr_[a-zA-Z0-9_-]+)/g;
type SentResource = Extract<Parameters<PluginBrowserBbSdk['threads']['send']>[0]['input'][number], { type: 'text' }>['mentions'][number]['resource'];
const pasted = new Map<string, ExperimentalComposerMentionTarget>();
export function rememberMention(text: string, resource: ExperimentalComposerMentionTarget) { pasted.set(text, resource); }
export function pastedMentions() { return pasted; }

/** SDK text-input offsets are JavaScript string offsets (UTF-16), not UTF-8 bytes. */
export function mentionsForText(text: string, lookup: (id: string) => ThreadLabel | undefined = () => undefined) {
  const mentions: { start: number; end: number; resource: SentResource }[] = [];
  for (const match of text.matchAll(threadToken)) {
    const details = lookup(match[1]);
    mentions.push({ start: match.index, end: match.index + match[0].length,
      resource: { kind: 'thread', threadId: match[1], ...(details?.projectId ? { projectId: details.projectId } : {}), label: details?.label ?? match[1] } });
  }
  for (const [token, resource] of pasted) {
    let at = text.indexOf(token);
    while (at !== -1) {
      if (!mentions.some(m => at < m.end && at + token.length > m.start)) mentions.push({ start: at, end: at + token.length, resource: resource.kind === 'plugin' ? { kind: 'plugin', pluginId: resource.pluginId, itemId: resource.id, label: resource.label, icon: resource.icon } : resource as SentResource });
      at = text.indexOf(token, at + token.length);
    }
  }
  return mentions.sort((a,b) => a.start - b.start);
}
