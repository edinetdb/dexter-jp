/** 固定並列数のワーカープール。同時実行数の上限（設計: 16）を守るための最小実装。 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function runner(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await worker(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runner()));
}
