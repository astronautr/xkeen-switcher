/** Values used by the API may repeat. Number occurrences of each value so
 * unrelated insertions, removals and reordering preserve the other rows. */
export function withOccurrenceKeys<T>(items: readonly T[], valueOf: (item: T) => string) {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const value = valueOf(item);
    const occurrence = counts.get(value) ?? 0;
    counts.set(value, occurrence + 1);
    return { item, key: occurrence + ":" + value };
  });
}
