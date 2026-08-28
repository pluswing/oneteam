export type DiffVirtualRange = {
  start: number;
  end: number;
  beforeHeight: number;
  afterHeight: number;
};

export function calculateDiffVirtualRange(input: {
  itemCount: number;
  scrollTop: number;
  viewportHeight: number;
  estimatedRowHeight: number;
  overscan: number;
}): DiffVirtualRange {
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  const rowHeight = Math.max(1, input.estimatedRowHeight);
  const overscan = Math.max(0, Math.floor(input.overscan));
  const firstVisible = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, input.viewportHeight) / rowHeight));
  const start = Math.max(0, Math.min(itemCount, firstVisible - overscan));
  const end = Math.max(start, Math.min(itemCount, firstVisible + visibleCount + overscan));

  return {
    start,
    end,
    beforeHeight: start * rowHeight,
    afterHeight: Math.max(0, itemCount - end) * rowHeight
  };
}
