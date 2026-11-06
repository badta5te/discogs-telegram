import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdate } from "../src/bot";
import { Env } from "../src/env";
import { poll } from "../src/poll";

const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

// Just enough of the D1 API, backed by an in-memory SQLite.
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...args: unknown[]) => statement(sql, args),
    async run() {
      const r = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
    async all() {
      return { results: db.prepare(sql).all(...(params as never[])) };
    },
    async first(column?: string) {
      const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : row;
    },
  });
  return {
    prepare: (sql: string) => statement(sql),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function makeEnv(): Env {
  return {
    DB: fakeD1(),
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    DISCOGS_TOKEN: "discogs",
    CURRENCY: "EUR",
    BATCH_SIZE: "40",
    MAX_MASTER_VERSIONS: "100",
    FAILURE_ALERT_THRESHOLD: "3",
  };
}

const RELEASE = {
  id: 38083371,
  title: "44028",
  year: 2026,
  country: "Germany",
  artists: [{ name: "Various", join: "" }],
  labels: [{ name: "44 Label", catno: "44028" }],
  formats: [{ name: "Vinyl", descriptions: ['12"'] }],
  images: [{ uri: "https://i.discogs.com/cover.jpg" }],
};

let market: Record<number, { num_for_sale: number; lowest_price: { value: number; currency: string } | null }>;
let telegram: { method: string; body: Record<string, unknown> }[];
let discogsCalls: string[];

beforeEach(() => {
  telegram = [];
  discogsCalls = [];
  market = { 38083371: { num_for_sale: 0, lowest_price: null } };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.telegram.org") {
      telegram.push({ method: url.pathname.split("/").pop()!, body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }
    discogsCalls.push(url.pathname);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Discogs token=discogs");
    const stats = url.pathname.match(/^\/marketplace\/stats\/(\d+)$/);
    if (stats) return Response.json(market[Number(stats[1])] ?? { num_for_sale: 0, lowest_price: null });
    if (url.pathname === "/releases/38083371") return Response.json(RELEASE);
    if (url.pathname === "/masters/100") {
      return Response.json({ id: 100, title: "Mutter", artists: [{ name: "Rammstein" }] });
    }
    if (url.pathname === "/masters/100/versions") {
      expect(url.searchParams.get("format")).toBe("Vinyl");
      return Response.json({
        pagination: { pages: 1 },
        versions: [
          { id: 1, title: "Mutter", format: "2xLP", label: "Universal", catno: "549 639-1", country: "Germany", released: "2001" },
          { id: 2, title: "Mutter", format: "2xLP, RE", label: "Universal", catno: "2734431", country: "Europe", released: "2015" },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  });
});

const say = (env: Env, text: string) => handleUpdate(env, { message: { chat: { id: 42 }, text } });
const lastText = () => {
  const b = telegram.at(-1)!.body;
  return String(b.text ?? b.caption);
};

describe("bot + poller", () => {
  it("adds a release by link and alerts when the first copy appears", async () => {
    const env = makeEnv();
    await say(env, "https://www.discogs.com/release/38083371-Various-44028");
    expect(lastText()).toContain("Добавил под номером 1");
    expect(lastText()).toContain("Various – 44028");
    expect(lastText()).toContain("Сейчас в продаже нет");

    await poll(env);
    expect(telegram).toHaveLength(1); // nothing changed

    market[38083371] = { num_for_sale: 1, lowest_price: { value: 55, currency: "EUR" } };
    await poll(env);
    expect(telegram.at(-1)!.method).toBe("sendPhoto");
    expect(lastText()).toContain("Появился в продаже");
    expect(lastText()).toContain("от 55.00 €");

    await poll(env);
    expect(telegram).toHaveLength(2); // no repeat
  });

  it("respects the price limit", async () => {
    const env = makeEnv();
    market[38083371] = { num_for_sale: 2, lowest_price: { value: 60, currency: "EUR" } };
    await say(env, "/add 38083371");
    await say(env, "/price 1 40");
    expect(lastText()).toContain("40.00 €");

    market[38083371] = { num_for_sale: 3, lowest_price: { value: 50, currency: "EUR" } };
    await poll(env);
    expect(telegram).toHaveLength(2); // cheaper, but still over the limit

    market[38083371] = { num_for_sale: 4, lowest_price: { value: 39, currency: "EUR" } };
    await poll(env);
    expect(lastText()).toContain("Дешевле твоего порога 40.00 €");
  });

  it("adds a master with a format filter and seeds its versions silently", async () => {
    const env = makeEnv();
    await say(env, "/add m100 Vinyl");
    expect(lastText()).toContain("Слежу за версиями: 2 (формат: Vinyl)");

    market[2] = { num_for_sale: 5, lowest_price: { value: 30, currency: "EUR" } };
    await poll(env);
    expect(telegram).toHaveLength(1); // first check is silent

    market[1] = { num_for_sale: 1, lowest_price: { value: 120, currency: "EUR" } };
    await poll(env);
    expect(lastText()).toContain("Rammstein – Mutter");
    expect(lastText()).toContain("Версия мастера «Rammstein – Mutter»");

    await say(env, "/list");
    expect(lastText()).toContain("мастер, версий: 2, Vinyl");
    expect(lastText()).toContain("в продаже 6, от 30.00 €");
  });

  it("checks the longest-waiting targets first within the batch size", async () => {
    const env = { ...makeEnv(), BATCH_SIZE: "1" };
    await say(env, "/add m100 Vinyl");
    discogsCalls = [];
    await poll(env);
    await poll(env);
    expect(discogsCalls.sort()).toEqual(["/marketplace/stats/1", "/marketplace/stats/2"]);
  });

  it("removes from the list and ignores strangers", async () => {
    const env = makeEnv();
    await say(env, "/add 38083371");
    await handleUpdate(env, { message: { chat: { id: 7 }, text: "/remove 1" } });
    await say(env, "/remove 1");
    expect(lastText()).toContain("Убрал «Various – 44028»");
    await say(env, "/list");
    expect(lastText()).toContain("Список пуст");
  });

  it("warns once when Discogs keeps failing", async () => {
    const env = makeEnv();
    await say(env, "/add 38083371");
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "api.telegram.org") {
        telegram.push({ method: "sendMessage", body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }
      return new Response("down", { status: 500 });
    });
    for (let i = 0; i < 5; i++) await poll(env);
    expect(telegram.filter((t) => String(t.body.text).includes("⚠️"))).toHaveLength(1);
  });
});

describe("Discogs failures", () => {
  it("logs who answered a 429 and tells the user", async () => {
    const env = makeEnv();
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args));
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "api.telegram.org") {
        telegram.push({ method: "sendMessage", body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }
      return new Response("<html>blocked</html>", { status: 429, headers: { server: "cloudflare", "cf-ray": "abc-FRA" } });
    });
    await say(env, "/add 38083371");
    expect(lastText()).toContain("слишком много запросов");
    expect(String(errors[0][2])).toContain("server=cloudflare cf-ray=abc-FRA | <html>blocked</html>");
  });
});
