// The admission is on the second line. Some builders use a versioned
// key=value record on the first line. Keep the original prompt for BB.
const envelope = /^\[bb message from plugin:spawn-gate\]\s*/;
const admission = /^([^\n]*)\nagent-admission v1 token=[a-f0-9]{64}\r?(?:\n|$)/;
const builderHeader = /^[a-z][\w.-]* v[1-9]\d*(?:[ \t]+[a-z][\w.-]*=\S+){2,}$/i;

export function spawnGateMessageBody(text: string): string {
  const prefix = envelope.exec(text)?.[0] ?? '';
  const prompt = text.slice(prefix.length);
  const match = admission.exec(prompt);
  if (!match) return text;
  const firstLine = match[1]!;
  const rest = prompt.slice(match[0].length);
  if (builderHeader.test(firstLine.trimEnd())) {
    return prefix + (rest.replace(/^(?:[ \t]*\r?\n)+/, '') || 'Session admitted.');
  }
  return prefix + firstLine + (rest ? '\n' + rest : '');
}
