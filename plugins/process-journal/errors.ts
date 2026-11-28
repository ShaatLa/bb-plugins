export class JournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new JournalError(code, message);
}
