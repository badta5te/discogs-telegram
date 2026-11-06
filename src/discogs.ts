const API = "https://api.discogs.com";
export const USER_AGENT = "discogs-telegram-bot/1.0 (+https://github.com/badta5te/discogs-telegram)";

export type Kind = "release" | "master";

export interface Ref {
  kind: Kind;
  id: number;
}

// Accepts "38083371", "r38083371", "m12345", "[r38083371]" and discogs.com release/master links.
export function parseRef(input: string): Ref | null {
  const text = input.trim();
  const link = text.match(/discogs\.com\/(?:[a-z]{2}\/)?(release|master)\/(\d+)/i);
  if (link) return { kind: link[1].toLowerCase() as Kind, id: Number(link[2]) };

  const short = text.match(/^\[?([rm]?)(\d+)\]?$/i);
  if (!short) return null;
  return { kind: short[1].toLowerCase() === "m" ? "master" : "release", id: Number(short[2]) };
}

export class RateLimited extends Error {}
export class NotFound extends Error {}

export interface ReleaseInfo {
  id: number;
  title: string;
  details: string;
  thumb?: string;
}

export interface MasterInfo {
  id: number;
  title: string;
}

export interface Stats {
  numForSale: number;
  lowestPrice: number | null;
  blocked: boolean;
}

export class Discogs {
  constructor(private token: string) {}

  async release(id: number): Promise<ReleaseInfo> {
    const r = await this.get<RawRelease>(`/releases/${id}`);
    const format = (r.formats ?? [])
      .map((f) => [f.name, ...(f.descriptions ?? [])].join(", "))
      .join(" + ");
    const label = r.labels?.[0] ? `${r.labels[0].name} – ${r.labels[0].catno}` : "";
    return {
      id: r.id,
      title: `${artistNames(r.artists)} – ${r.title}`,
      details: [format, label, r.country, r.year || ""].filter(Boolean).join(" · "),
      thumb: r.images?.[0]?.uri || r.thumb || undefined,
    };
  }

  async master(id: number): Promise<MasterInfo> {
    const m = await this.get<RawMaster>(`/masters/${id}`);
    return { id: m.id, title: `${artistNames(m.artists)} – ${m.title}` };
  }

  // Versions of a master, optionally only one format (e.g. "Vinyl"), at most `limit` of them.
  async versions(masterId: number, format: string | null, limit: number): Promise<ReleaseInfo[]> {
    const out: ReleaseInfo[] = [];
    for (let page = 1; out.length < limit; page++) {
      const params = new URLSearchParams({ per_page: "100", page: String(page) });
      if (format) params.set("format", format);
      const res = await this.get<RawVersions>(`/masters/${masterId}/versions?${params}`);
      for (const v of res.versions) {
        out.push({
          id: v.id,
          title: v.title,
          details: [v.format, v.label && v.catno ? `${v.label} – ${v.catno}` : v.label, v.country, v.released]
            .filter(Boolean)
            .join(" · "),
          thumb: v.thumb || undefined,
        });
      }
      if (page >= res.pagination.pages) break;
    }
    return out.slice(0, limit);
  }

  // Only the count and the lowest price across all conditions: the API has no per-listing data for a release.
  async stats(releaseId: number, currency: string): Promise<Stats> {
    const s = await this.get<RawStats>(`/marketplace/stats/${releaseId}?curr_abbr=${currency}`);
    return {
      numForSale: s.num_for_sale ?? 0,
      lowestPrice: s.lowest_price?.value ?? null,
      blocked: Boolean(s.blocked_from_sale),
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(API + path, {
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Discogs token=${this.token}`,
        Accept: "application/vnd.discogs.v2.discogs+json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) throw new RateLimited("Discogs rate limit hit");
    if (res.status === 404) throw new NotFound(`Discogs ${path} not found`);
    if (!res.ok) throw new Error(`Discogs ${path} responded ${res.status}`);
    return res.json() as Promise<T>;
  }
}

// Discogs marks duplicate artist names as "Name (2)"; drop that for display.
function artistNames(artists?: { name: string; join?: string }[]): string {
  if (!artists?.length) return "Unknown Artist";
  return artists
    .map((a, i) => {
      const name = a.name.replace(/\s\(\d+\)$/, "");
      if (i === artists.length - 1) return name;
      const join = a.join?.trim() || ",";
      return join === "," ? `${name}, ` : `${name} ${join} `;
    })
    .join("");
}

interface RawRelease {
  id: number;
  title: string;
  year?: number;
  country?: string;
  thumb?: string;
  artists?: { name: string; join?: string }[];
  labels?: { name: string; catno: string }[];
  formats?: { name: string; descriptions?: string[] }[];
  images?: { uri: string }[];
}

interface RawMaster {
  id: number;
  title: string;
  artists?: { name: string; join?: string }[];
}

interface RawVersions {
  pagination: { pages: number };
  versions: {
    id: number;
    title: string;
    format?: string;
    label?: string;
    catno?: string;
    country?: string;
    released?: string;
    thumb?: string;
  }[];
}

interface RawStats {
  num_for_sale?: number;
  lowest_price?: { value: number; currency: string } | null;
  blocked_from_sale?: boolean;
}
