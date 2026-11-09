export function parseInlineComments(text: string): { text: string; comments: { label: string; passage: string; comment: string }[] } {
  const header = /^Context for @(.+?) \(resolved by plugin "inline-comments"\):[ \t]*$/gm;
  const matches = [...text.matchAll(header)];
  if (!matches.length) return { text, comments: [] };
  const comments: { label: string; passage: string; comment: string }[] = [];
  let remaining = '', cursor = 0;
  for (const match of matches) {
    const start = match.index!, end = matches.find(other => other.index! > start)?.index ?? text.length;
    const block = text.slice(start, end);
    const lines = block.split('\n');
    const intro = lines.findIndex(line => line === 'The user attached this passage from the conversation to their message:');
    if (intro < 0) continue;
    const passage = lines.slice(intro + 1).filter(line => line.startsWith('> ')).map(line => line.slice(2)).join('\n');
    const commentLine = lines.findIndex(line => line.startsWith('Their comment on it: '));
    // The plugin appends blocks after the message, so a comment runs to the next block or the end and may span lines.
    const comment = commentLine < 0 ? '' : [lines[commentLine]!.slice('Their comment on it: '.length), ...lines.slice(commentLine + 1)].join('\n').trim();
    const label = match[1]!;
    remaining += text.slice(cursor, start);
    comments.push({ label, passage, comment });
    const lastLine = commentLine >= 0 ? lines.length - 1 : Math.max(intro, lines.map(line => line.startsWith('> ')).lastIndexOf(true));
    const consumed = lines.slice(0, lastLine + 1).join('\n').length;
    cursor = start + consumed;
  }
  if (!comments.length) return { text, comments: [] };
  remaining += text.slice(cursor);
  for (const { label } of comments) remaining = remaining.replace(`@${label}`, '');
  return { text: remaining.trim(), comments };
}

export function inlineCommentPreview(text: string): string {
  const parsed = parseInlineComments(text);
  return [parsed.comments.map(({ comment, passage }) => comment || passage).filter(Boolean).join(' '), parsed.text].filter(Boolean).join(' ');
}
