import { decide, Reason } from "./alerts";
import { Discogs, RateLimited } from "./discogs";
import { broadcast, Env, getState, sellUrl, setState } from "./env";
import { escapeHtml, formatPrice, Message } from "./telegram";

const DAY_MS = 24 * 60 * 60_000;

export interface TargetRow {
  want_id: number;
  release_id: number;
  title: string;
  details: string;
  thumb: string | null;
  num_for_sale: number | null;
  lowest_price: number | null;
  under_max: number;
  checked_at: string | null;
  kind: "release" | "master";
  max_price: number | null;
  want_title: string;
}

// One cron run: check the targets that have waited longest, as many as fit in the request budget.
// With few targets everything is checked every minute; with more the interval stretches on its own.
export async function poll(env: Env, discogs = new Discogs(env.DISCOGS_TOKEN)): Promise<void> {
  let budget = Number(env.BATCH_SIZE);
  budget -= await syncOneMaster(env, discogs, budget);

  const { results: targets } = await env.DB.prepare(
    `SELECT t.*, w.kind, w.max_price, w.title AS want_title
     FROM targets t JOIN wants w ON w.id = t.want_id
     ORDER BY t.checked_at IS NOT NULL, t.checked_at
     LIMIT ?`,
  )
    .bind(Math.max(budget, 0))
    .all<TargetRow>();
  if (targets.length === 0) return;

  let failed = 0;
  for (const target of targets) {
    try {
      await check(env, discogs, target);
    } catch (err) {
      console.error("check failed", target.release_id, err);
      failed++;
      if (err instanceof RateLimited) break;
    }
  }

  if (failed === targets.length) await recordFailure(env);
  else await recordSuccess(env);
}

async function check(env: Env, discogs: Discogs, target: TargetRow): Promise<void> {
  const stats = await discogs.stats(target.release_id, env.CURRENCY);
  const { reason, underMax } = decide(target, stats, target.max_price);

  // Send before saving: if Telegram fails, the next run sees the same change and retries.
  if (reason) {
    await broadcast(env, alertMessage(env, target, stats.numForSale, stats.lowestPrice!, reason));
    console.log("alerted", target.release_id, reason.kind);
  }

  await env.DB.prepare(
    `UPDATE targets SET num_for_sale = ?, lowest_price = ?, under_max = ?, checked_at = ?
     WHERE want_id = ? AND release_id = ?`,
  )
    .bind(
      stats.numForSale,
      stats.numForSale > 0 ? stats.lowestPrice : null,
      underMax ? 1 : 0,
      new Date().toISOString(),
      target.want_id,
      target.release_id,
    )
    .run();
}

export function alertMessage(
  env: Env,
  target: TargetRow,
  numForSale: number,
  lowest: number,
  reason: Reason,
): Message {
  const price = (v: number) => formatPrice(v, env.CURRENCY);
  const headline: Record<Reason["kind"], string> = {
    appeared: "🆕 Появился в продаже",
    cheaper: reason.kind === "cheaper" ? `📉 Подешевел, было от ${price(reason.was)}` : "",
    more: reason.kind === "more" ? `➕ Новая копия, было ${reason.was}` : "",
    under_max: reason.kind === "under_max" ? `✅ Дешевле твоего порога ${price(reason.max)}` : "",
  };

  const lines = [headline[reason.kind], "", `<b>${escapeHtml(target.title)}</b>`];
  if (target.details) lines.push(escapeHtml(target.details));
  if (target.kind === "master") lines.push(`Версия мастера «${escapeHtml(target.want_title)}»`);
  lines.push("", `💶 от ${price(lowest)} · в продаже: ${numForSale}`);
  lines.push("<i>Цена без доставки, кондиция любая.</i>");

  return {
    text: lines.join("\n"),
    photo: target.thumb ?? undefined,
    keyboard: [[{ text: "Открыть на Discogs", url: sellUrl(target.release_id, env.CURRENCY) }]],
  };
}

// Masters get new versions (reissues), so re-read one master's version list a day.
// Returns how many requests it used.
async function syncOneMaster(env: Env, discogs: Discogs, budget: number): Promise<number> {
  if (budget < 5) return 0;
  const cutoff = new Date(Date.now() - DAY_MS).toISOString();
  const want = await env.DB.prepare(
    `SELECT id, discogs_id, format_filter FROM wants
     WHERE kind = 'master' AND (versions_synced_at IS NULL OR versions_synced_at < ?)
     ORDER BY versions_synced_at LIMIT 1`,
  )
    .bind(cutoff)
    .first<{ id: number; discogs_id: number; format_filter: string | null }>();
  if (!want) return 0;

  const limit = Number(env.MAX_MASTER_VERSIONS);
  try {
    const versions = await discogs.versions(want.discogs_id, want.format_filter, limit);
    await insertTargets(env, want.id, (await masterTitle(env, want.id)) ?? "", versions);
  } catch (err) {
    console.error("master sync failed", want.discogs_id, err);
  }
  await env.DB.prepare("UPDATE wants SET versions_synced_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), want.id)
    .run();
  return Math.ceil(limit / 100);
}

async function masterTitle(env: Env, wantId: number): Promise<string | null> {
  return env.DB.prepare("SELECT title FROM wants WHERE id = ?").bind(wantId).first<string>("title");
}

// New targets start unchecked, so their first check only records the market.
export async function insertTargets(
  env: Env,
  wantId: number,
  artistTitle: string,
  versions: { id: number; title: string; details: string; thumb?: string }[],
): Promise<void> {
  if (versions.length === 0) return;
  // Version titles come without the artist; take it from the master's "Artist – Title".
  const artist = artistTitle.includes(" – ") ? artistTitle.split(" – ")[0] : "";
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO targets (want_id, release_id, title, details, thumb) VALUES (?, ?, ?, ?, ?)",
  );
  await env.DB.batch(
    versions.map((v) =>
      stmt.bind(wantId, v.id, artist ? `${artist} – ${v.title}` : v.title, v.details, v.thumb ?? null),
    ),
  );
}

// A silently broken bot means a missed record, so say when checks keep failing.
async function recordFailure(env: Env): Promise<void> {
  const failures = Number((await getState(env, "failures")) ?? 0) + 1;
  await setState(env, "failures", String(failures));
  if (failures === Number(env.FAILURE_ALERT_THRESHOLD)) {
    await broadcast(env, {
      text: `⚠️ Не могу получить данные Discogs уже ${failures} раз подряд. Проверь токен или логи.`,
    }).catch((err) => console.error(err));
  }
}

async function recordSuccess(env: Env): Promise<void> {
  const failures = Number((await getState(env, "failures")) ?? 0);
  if (failures === 0) return;
  await setState(env, "failures", "0");
  if (failures >= Number(env.FAILURE_ALERT_THRESHOLD)) {
    await broadcast(env, { text: "✅ Discogs снова отвечает, слежу дальше." }).catch((err) =>
      console.error(err),
    );
  }
}
