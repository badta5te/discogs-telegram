import { describe, expect, it } from "vitest";
import { decide, Previous } from "../src/alerts";
import { parsePrice } from "../src/bot";
import { parseRef } from "../src/discogs";

const checked = (p: Partial<Previous>): Previous => ({
  num_for_sale: 0,
  lowest_price: null,
  under_max: 0,
  checked_at: "2026-11-06T00:00:00Z",
  ...p,
});
const stats = (numForSale: number, lowestPrice: number | null) => ({ numForSale, lowestPrice, blocked: false });

describe("decide without a price limit", () => {
  it("stays silent on the first check", () => {
    expect(decide(checked({ checked_at: null }), stats(3, 20), null).reason).toBeNull();
  });

  it("alerts when the first copy appears", () => {
    expect(decide(checked({}), stats(1, 50), null).reason).toEqual({ kind: "appeared" });
  });

  it("alerts when the lowest price drops", () => {
    const prev = checked({ num_for_sale: 2, lowest_price: 30 });
    expect(decide(prev, stats(2, 25), null).reason).toEqual({ kind: "cheaper", was: 30 });
  });

  it("alerts when another copy is listed", () => {
    const prev = checked({ num_for_sale: 2, lowest_price: 30 });
    expect(decide(prev, stats(3, 30), null).reason).toEqual({ kind: "more", was: 2 });
  });

  it("stays silent when copies sell or get pricier", () => {
    const prev = checked({ num_for_sale: 3, lowest_price: 30 });
    expect(decide(prev, stats(2, 35), null).reason).toBeNull();
    expect(decide(prev, stats(0, null), null).reason).toBeNull();
  });
});

describe("decide with a price limit", () => {
  it("alerts when the price enters the range", () => {
    const prev = checked({ num_for_sale: 2, lowest_price: 50 });
    expect(decide(prev, stats(2, 40), 40)).toEqual({ reason: { kind: "under_max", max: 40 }, underMax: true });
  });

  it("ignores listings above the limit", () => {
    expect(decide(checked({}), stats(5, 60), 40)).toEqual({ reason: null, underMax: false });
  });

  it("does not repeat while the price stays in range", () => {
    const prev = checked({ num_for_sale: 2, lowest_price: 35, under_max: 1 });
    expect(decide(prev, stats(3, 35), 40).reason).toBeNull();
    expect(decide(prev, stats(1, 38), 40).reason).toBeNull();
  });

  it("alerts again on a further drop", () => {
    const prev = checked({ num_for_sale: 2, lowest_price: 35, under_max: 1 });
    expect(decide(prev, stats(3, 30), 40).reason).toEqual({ kind: "under_max", max: 40 });
  });

  it("remembers the range on the first check without alerting", () => {
    expect(decide(checked({ checked_at: null }), stats(1, 20), 40)).toEqual({ reason: null, underMax: true });
  });
});

describe("parseRef", () => {
  it.each([
    ["38083371", { kind: "release", id: 38083371 }],
    ["r38083371", { kind: "release", id: 38083371 }],
    ["[r38083371]", { kind: "release", id: 38083371 }],
    ["m12345", { kind: "master", id: 12345 }],
    ["https://www.discogs.com/release/38083371-Various-44028", { kind: "release", id: 38083371 }],
    ["https://www.discogs.com/de/master/12345-Rammstein-Mutter", { kind: "master", id: 12345 }],
  ])("%s", (input, ref) => {
    expect(parseRef(input)).toEqual(ref);
  });

  it("rejects other text", () => {
    expect(parseRef("hello")).toBeNull();
    expect(parseRef("https://www.discogs.com/artist/123")).toBeNull();
  });
});

describe("parsePrice", () => {
  it("reads amounts and off", () => {
    expect(parsePrice("40")).toBe(40);
    expect(parsePrice("40,5€")).toBe(40.5);
    expect(parsePrice("off")).toBe("off");
    expect(parsePrice("abc")).toBeNull();
    expect(parsePrice("0")).toBeNull();
  });
});
