export async function mapWithConcurrency(items, fn, limit = 10) {
  const list = Array.isArray(items) ? items : [];
  const results = [];
  const concurrency = Math.max(1, Number(limit) || 1);

  for (let index = 0; index < list.length; index += concurrency) {
    const batch = list.slice(index, index + concurrency);
    const batchResults = await Promise.allSettled(batch.map((item, batchIndex) => fn(item, index + batchIndex)));
    results.push(...batchResults);
  }

  return results;
}

