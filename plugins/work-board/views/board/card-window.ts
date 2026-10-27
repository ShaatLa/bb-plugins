export const CARD_GAP = 8;
export const ESTIMATED_CARD_HEIGHT = 112;

export function cardLayout(ids: readonly string[], sizes: ReadonlyMap<string, number>) {
  const offsets = [0];
  const heights = ids.map((id) => sizes.get(id) ?? ESTIMATED_CARD_HEIGHT);
  for (const height of heights) offsets.push(offsets.at(-1)! + height + CARD_GAP);
  return { offsets, heights, total: Math.max(0, offsets.at(-1)! - CARD_GAP) };
}

export function cardWindow(layout: ReturnType<typeof cardLayout>, scrollTop: number, viewportHeight: number) {
  const count = layout.heights.length;
  const height = viewportHeight || 600;
  const scroll = Math.min(Math.max(0, scrollTop), Math.max(0, layout.total - height));
  const lower = Math.max(0, scroll - 400);
  const upper = scroll + height + 400;
  const bound = (position: number) => {
    let low = 0, high = count;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (layout.offsets[mid]! < position) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const start = count <= 30 ? 0 : Math.max(0, bound(lower) - 1);
  const end = count <= 30 ? count : Math.min(count, bound(upper) + 1);
  return {
    start, end,
    before: start ? Math.max(0, layout.offsets[start]! - CARD_GAP) : 0,
    after: end < count ? Math.max(0, layout.total - layout.offsets[end]!) : 0,
  };
}
