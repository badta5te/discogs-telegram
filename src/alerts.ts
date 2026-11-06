import { Stats } from "./discogs";

export interface Previous {
  num_for_sale: number | null;
  lowest_price: number | null;
  under_max: number;
  checked_at: string | null;
}

export type Reason =
  | { kind: "appeared" }
  | { kind: "cheaper"; was: number }
  | { kind: "more"; was: number }
  | { kind: "under_max"; max: number };

export interface Decision {
  reason: Reason | null;
  underMax: boolean;
}

// Decides whether a change in the market is worth a message.
// The API only gives the count and the lowest price over all conditions, so that's all we compare.
export function decide(prev: Previous, now: Stats, maxPrice: number | null): Decision {
  const lowest = now.numForSale > 0 ? now.lowestPrice : null;
  const underMax = maxPrice !== null && lowest !== null && lowest <= maxPrice;

  // First check: just remember the market. The /add reply already showed it.
  if (prev.checked_at === null || lowest === null) return { reason: null, underMax };

  if (maxPrice !== null) {
    if (!underMax) return { reason: null, underMax };
    const entered = !prev.under_max;
    const dropped = prev.lowest_price !== null && lowest < prev.lowest_price;
    return { reason: entered || dropped ? { kind: "under_max", max: maxPrice } : null, underMax };
  }

  const prevCount = prev.num_for_sale ?? 0;
  if (prevCount === 0) return { reason: { kind: "appeared" }, underMax };
  if (prev.lowest_price !== null && lowest < prev.lowest_price) {
    return { reason: { kind: "cheaper", was: prev.lowest_price }, underMax };
  }
  if (now.numForSale > prevCount) return { reason: { kind: "more", was: prevCount }, underMax };
  return { reason: null, underMax };
}
