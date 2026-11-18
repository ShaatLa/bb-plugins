// The Markdown message a quote reply or a reply pool sends; shared so the Inbox can show it before ingest catches up.
export function buildReplyMessage(entries: readonly {quote:string;note:string}[]): string {
  const message = entries.filter(({quote,note}) => quote || note.trim()).map(({quote,note}) => {
    if (quote.length > 20000) throw new Error('Quote exceeds 20,000 characters');
    if (!quote) return note;
    const quoted = quote.split('\n').map(line=>line ? '> '+line : '>').join('\n');
    return quoted + (note ? '\n\n'+note : '');
  }).join('\n\n');
  if (message.length > 32000) throw new Error('Message exceeds 32,000 characters — split the pool');
  return message;
}
