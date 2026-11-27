/** A scheduled start must be at least this far ahead when it is set or changed. */
export const MIN_LEAD_MS = 2 * 60_000;
/** The first instant an ISO time cannot be: later years stop sorting as text. */
const END_BOUND_MS = Date.UTC(10000, 0, 1);
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * An ISO time with an offset (`2026-11-29T02:00:00+03:00`, `…Z`) or a relative `+30m`, `+2h`, `+1d`, as a UTC ISO string.
 * A time without an offset is refused: the machine's zone and the setter's are not the same thing.
 */
export function parseStartTime(text: string, now = Date.now()): string {
  const value = text.trim();
  const relative = /^\+(\d{1,5})([mhd])$/.exec(value);
  const ms = relative ? now + Number(relative[1]) * UNITS[relative[2]!]! : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms >= END_BOUND_MS) throw new Error(`Cannot read the start time "${value}": use an ISO time with an offset such as 2026-11-29T02:00:00+03:00 or Z, or a relative +30m, +2h, +1d`);
  if (ms < now + MIN_LEAD_MS) throw new Error(`The start time must be at least ${MIN_LEAD_MS / 60_000} minutes ahead`);
  return new Date(ms).toISOString();
}

/** `2026-11-29 02:00 (UTC)`. */
export const formatStartTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} (UTC)`;

/** Splits builder arguments like a shell would, without expanding anything: quotes group, a backslash escapes the next character. */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  let current = "", quote: string | null = null, started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) current += text[++index]!;
      else current += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === "\\" && index + 1 < text.length) { current += text[++index]!; started = true; }
    else if (/\s/.test(char)) { if (started || current) args.push(current); current = ""; started = false; }
    else { current += char; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in the launch arguments");
  if (started || current) args.push(current);
  return args;
}

/** The reverse of `splitArgs`: an argument that is empty or holds anything but plain characters is single-quoted (a quote becomes `'\\''`). */
export function joinArgs(args: readonly string[]): string {
  return args.map((arg) => (/^[\w\-./:=@%+,]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}
