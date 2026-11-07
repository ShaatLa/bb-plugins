import { describe, expect, it } from "vitest";
import { withNativeThreadMentions } from "./thread-links.js";

const ORIGIN = "http://127.0.0.1:38886";
const PATH = "/projects/proj_example1/threads/thr_example1";
const run = (body: string, origin: string | null = ORIGIN) =>
  withNativeThreadMentions(body, origin);

describe("withNativeThreadMentions", () => {
  it("turns same-origin absolute, autolink and relative thread references into mentions", () => {
    expect(run(`See ${ORIGIN}${PATH}.`)).toBe("See @thread:thr_example1.");
    expect(run(`<${ORIGIN}${PATH}>`)).toBe("@thread:thr_example1");
    expect(run(`(${PATH})`)).toBe("(@thread:thr_example1)");
    expect(run("/threads/thr_abc123")).toBe("@thread:thr_abc123");
    expect(run(`${ORIGIN}${PATH}/`)).toBe("@thread:thr_example1");
  });

  it("keeps a message anchor and drops nothing else", () => {
    expect(run(`${ORIGIN}${PATH}#msg=42`)).toBe("@thread:thr_example1#msg=42");
    expect(run(`${ORIGIN}${PATH}#other`)).toBe(`${ORIGIN}${PATH}#other`);
    expect(run(`${ORIGIN}${PATH}?tab=files`)).toBe(`${ORIGIN}${PATH}?tab=files`);
  });

  it("leaves external sites with a look-alike path untouched", () => {
    const external = [
      `https://example.com${PATH}`,
      `http://127.0.0.1:9999${PATH}`,
      `https://evil.test/?u=${ORIGIN}${PATH}`,
      "https://example.com/docs/page",
      `https://example.com${PATH}.git`,
    ];
    for (const url of external) expect(run(`Link ${url} end`)).toBe(`Link ${url} end`);
    expect(run(`${ORIGIN}${PATH}`, null)).toBe(`${ORIGIN}${PATH}`);
  });

  it("does not rewrite labeled links, code, fences or non-thread routes", () => {
    const untouched = [
      `[Manager](${ORIGIN}${PATH})`,
      `[Manager](${PATH})`,
      `![x](${ORIGIN}${PATH})`,
      `\`${ORIGIN}${PATH}\``,
      `[ref]: ${ORIGIN}${PATH}`,
      `\`\`\`\n${ORIGIN}${PATH}\n\`\`\``,
      `~~~sh\ncurl ${PATH}\n~~~`,
      `${ORIGIN}/projects/proj_example1`,
      `${ORIGIN}/plugins/work-board/work-board/task/WB-1`,
      `see src/threads/thr_abc.ts`,
    ];
    for (const body of untouched) expect(run(body)).toBe(body);
  });

  it("resumes rewriting after a closed fence and keeps surrounding text", () => {
    expect(run(`\`\`\`\n${PATH}\n\`\`\`\nAfter ${PATH}, then \`${PATH}\` and ${PATH}`)).toBe(
      `\`\`\`\n${PATH}\n\`\`\`\nAfter @thread:thr_example1, then \`${PATH}\` and @thread:thr_example1`,
    );
  });
});
