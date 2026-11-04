import { z } from "zod";

export const dispatchMarker = (taskId: string) => `<!-- work-board-task:${taskId} -->`;
const textInput = z.object({ type: z.literal("text"), text: z.string() });
const requestSchema = z.object({ requestId: z.string(), input: z.array(z.unknown()), inputGroups: z.array(z.array(z.unknown())).optional() });

/** Only an explicit dispatch header establishes focus; ordinary key mentions do not. */
export function dispatchedTask(data: unknown, requestId: string): string | null {
  const parsed = requestSchema.safeParse(data);
  if (!parsed.success || parsed.data.requestId !== requestId) return null;
  const groups = parsed.data.inputGroups ?? [parsed.data.input];
  const ids = groups.map((group) => {
    const texts = group.map((item) => textInput.safeParse(item)).filter((item) => item.success).map((item) => item.data!.text).filter((text) => text.trim());
    if (texts.length !== 1) return null;
    return texts[0]!.match(/^<!-- work-board-task:([0-9A-Z]{26}) -->\r?\n/)?.[1] ?? null;
  });
  return ids.length > 0 && ids.every((id) => id !== null && id === ids[0]) ? ids[0]! : null;
}
