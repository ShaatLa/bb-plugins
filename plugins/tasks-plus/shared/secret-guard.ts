const SECRET_PATTERNS: readonly [string, RegExp][] = [
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "AWS secret key",
    /\b(?:aws[_ -]?)?secret[_ -]?(?:access[_ -]?)?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?:[^A-Za-z0-9/+]|$)/i,
  ],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
];

export class SecretDetectedError extends Error {
  constructor(field: string, pattern: string) {
    super(
      `Cannot save ${field}: detected ${pattern}. Remove the secret and retry.`,
    );
    this.name = "SecretDetectedError";
  }
}

export function assertNoSecrets(text: string | undefined, field: string): void {
  if (text === undefined) return;
  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new SecretDetectedError(field, name);
  }
}

export function assertNoSecretsInValue(value: unknown, field: string): void {
  if (typeof value === "string") assertNoSecrets(value, field);
  else if (value && typeof value === "object")
    for (const child of Object.values(value))
      assertNoSecretsInValue(child, field);
}
