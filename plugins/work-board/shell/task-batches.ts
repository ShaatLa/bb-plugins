// Bound both the RPC payload and concurrent requests for large projects.
export async function taskBatches<T>(ids: readonly string[], read: (batch: string[]) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < ids.length; start += 2000) {
    const batches = [0, 500, 1000, 1500].filter((offset) => start + offset < ids.length);
    const responses = await Promise.all(batches.map((offset) => read(ids.slice(start + offset, start + offset + 500))));
    for (const response of responses) results.push(...response);
  }
  return results;
}
