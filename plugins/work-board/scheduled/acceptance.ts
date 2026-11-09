import { z } from "zod";

export const scheduledRunMarker = (runId: string) => `<!-- work-board-scheduled-run:${runId} -->`;

const requestSchema = z.object({
  requestId: z.string(),
  input: z.array(z.unknown()),
  inputGroups: z.array(z.array(z.unknown())).optional(),
});
const textSchema = z.object({ type: z.literal("text"), text: z.string() });

/** A queued message is not evidence of accepted input. */
export function acceptedScheduledRuns(request: unknown, acceptedRequestId: string): string[] {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success || parsed.data.requestId !== acceptedRequestId) return [];
  const runs = new Set<string>();
  for (const group of parsed.data.inputGroups ?? [parsed.data.input]) {
    for (const item of group) {
      const text = textSchema.safeParse(item);
      if (!text.success) continue;
      const match = text.data.text.match(/^<!-- work-board-scheduled-run:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->\r?\n/i);
      if (match) runs.add(match[1]!);
    }
  }
  return [...runs];
}
