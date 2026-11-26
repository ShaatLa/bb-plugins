import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { taskHref } from "../shared/task-link.js";
import { findTaskKeys, taskKeyTitle, type ResolvedTaskKey } from "../shared/task-keys.js";

export type TaskKeyLookup = (key: string) => ResolvedTaskKey | undefined;

// A transaction carrying a new lookup: the set of keys that are cards changed.
interface LinksState { lookup: TaskKeyLookup | null; decorations: DecorationSet }
export const taskKeyLinksKey = new PluginKey<LinksState>("taskKeyLinks");

/** Key-shaped text in the document's plain text: never inside inline code, a link or a code block. */
function keyRanges(doc: ProseMirrorNode): Array<{ key: string; from: number; to: number }> {
  const out: Array<{ key: string; from: number; to: number }> = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent?.type.spec.code || node.marks.some((mark) => mark.type.name === "code" || mark.type.name === "link")) return;
    for (const { key, start, end } of findTaskKeys(node.text ?? "")) out.push({ key, from: pos + start, to: pos + end });
  });
  return out;
}

function decorate(doc: ProseMirrorNode, lookup: TaskKeyLookup | null): DecorationSet {
  if (!lookup) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  for (const { key, from, to } of keyRanges(doc)) {
    const task = lookup(key);
    if (task) decorations.push(Decoration.inline(from, to, { nodeName: "a", href: taskHref(task.currentKey), title: taskKeyTitle(task), "data-task-key": task.currentKey }));
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * Renders the keys of existing cards as links without touching the document: the stored Markdown stays as written.
 * `onKeys` gets every distinct key-shaped word whenever that set changes; the lookup comes back through a transaction.
 */
export const TaskKeyLinks = Extension.create<{ onKeys: (keys: string[]) => void }>({
  name: "taskKeyLinks",
  addProseMirrorPlugins() {
    const { onKeys } = this.options;
    return [
      new Plugin<LinksState>({
        key: taskKeyLinksKey,
        state: {
          init: () => ({ lookup: null, decorations: DecorationSet.empty }),
          apply(tr, value) {
            const lookup = (tr.getMeta(taskKeyLinksKey) as TaskKeyLookup | undefined) ?? value.lookup;
            if (!tr.docChanged && lookup === value.lookup) return value;
            return { lookup, decorations: decorate(tr.doc, lookup) };
          },
        },
        props: { decorations: (state) => taskKeyLinksKey.getState(state)?.decorations },
        view(view) {
          let last: string | null = null;
          const report = () => {
            const keys = [...new Set(keyRanges(view.state.doc).map((range) => range.key))];
            const joined = keys.join(" ");
            if (joined === last) return;
            last = joined;
            onKeys(keys);
          };
          report();
          return { update: report };
        },
      }),
    ];
  },
});
