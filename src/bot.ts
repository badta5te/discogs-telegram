import { Discogs, NotFound, parseRef, RateLimited, Ref } from "./discogs";
import { chatIds, Env, sellUrl } from "./env";
import { insertTargets } from "./poll";
import { answerCallback, escapeHtml, formatPrice, Keyboard, Message, send } from "./telegram";

interface Update {
  message?: { chat: { id: number }; text?: string };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number } } };
}

const HELP = [
  "Слежу за маркетплейсом Discogs по твоему списку most wanted.",
  "",
  "<b>Добавить</b>: пришли ссылку на релиз или мастер, или",
  "/add 38083371 — релиз",
  "/add m12345 Vinyl — мастер, только версии в этом формате",
  "",
  "/list — список",
  "/price 3 40 — алерт, только когда дешевле 40 (3 — номер из /list)",
  "/price 3 off — снять порог",
  "/remove 3 — убрать",
  "",
  "Без порога присылаю, когда копия появилась в продаже, добавилась ещё одна или подешевела. С порогом — когда минимальная цена опустилась до него или ниже.",
].join("\n");

export async function handleUpdate(env: Env, update: Update): Promise<void> {
  const chatId = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? "");
  // Only the configured chats may manage the list.
  if (!chatIds(env).includes(chatId)) return;

  const reply = (msg: Message | string) =>
    send(env.TELEGRAM_BOT_TOKEN, chatId, typeof msg === "string" ? { text: msg } : msg);

  if (update.callback_query) {
    const cb = update.callback_query;
    const remove = cb.data?.match(/^rm:(\d+)$/);
    if (remove) {
      const title = await removeWant(env, Number(remove[1]));
      await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id, title ? "Удалил" : "Уже удалён");
      if (title) await reply(`🗑 Убрал «${escapeHtml(title)}»`);
    } else {
      await answerCallback(env.TELEGRAM_BOT_TOKEN, cb.id);
    }
    return;
  }

  const text = update.message?.text?.trim();
  if (!text) return;
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@\w+$/, "");

  try {
    switch (command) {
      case "/start":
      case "/help":
        return await reply(HELP);
      case "/add":
        return await reply(await add(env, args[0] ?? "", args.slice(1).join(" ")));
      case "/list":
        return await reply(await list(env));
      case "/remove": {
        const title = await removeWant(env, Number(args[0]));
        return await reply(title ? `🗑 Убрал «${escapeHtml(title)}»` : "Нет такого номера, смотри /list");
      }
      case "/price":
        return await reply(await setPrice(env, Number(args[0]), args[1]));
    }
    // A bare link or id adds it, so you can just share a Discogs page to the bot.
    if (parseRef(rawCommand)) return await reply(await add(env, rawCommand, args.join(" ")));
    await reply("Не понял. /help — что я умею.");
  } catch (err) {
    console.error("command failed", text, err);
    if (err instanceof NotFound) return await reply("Discogs такого не знает, проверь id.");
    if (err instanceof RateLimited) return await reply("Discogs ответил «слишком много запросов». Попробуй через минуту.");
    await reply(`Что-то пошло не так: ${escapeHtml(String(err instanceof Error ? err.message : err)).slice(0, 300)}`);
  }
}

async function add(env: Env, input: string, format: string): Promise<Message | string> {
  const ref = parseRef(input);
  if (!ref) return "Пришли id релиза (38083371), мастера (m12345) или ссылку на Discogs.";

  const existing = await env.DB.prepare("SELECT id FROM wants WHERE kind = ? AND discogs_id = ?")
    .bind(ref.kind, ref.id)
    .first<number>("id");
  if (existing) return `Уже в списке под номером ${existing}.`;

  const discogs = Discogs.fromEnv(env);
  return ref.kind === "release" ? addRelease(env, discogs, ref) : addMaster(env, discogs, ref, format || null);
}

async function addRelease(env: Env, discogs: Discogs, ref: Ref): Promise<Message> {
  const [release, stats] = await Promise.all([discogs.release(ref.id), discogs.stats(ref.id, env.CURRENCY)]);
  const now = new Date().toISOString();
  const want = await env.DB.prepare(
    "INSERT INTO wants (kind, discogs_id, title, added_at) VALUES ('release', ?, ?, ?) RETURNING id",
  )
    .bind(ref.id, release.title, now)
    .first<number>("id");
  const lowest = stats.numForSale > 0 ? stats.lowestPrice : null;
  // Checked right now, so the poller won't alert about what is already on sale.
  await env.DB.prepare(
    `INSERT INTO targets (want_id, release_id, title, details, thumb, num_for_sale, lowest_price, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(want, ref.id, release.title, release.details, release.thumb ?? null, stats.numForSale, lowest, now)
    .run();

  const market =
    lowest !== null
      ? `Сейчас в продаже: ${stats.numForSale}, от ${formatPrice(lowest, env.CURRENCY)}`
      : "Сейчас в продаже нет, напишу, как только появится.";
  return {
    text: [
      `✅ Добавил под номером ${want}`,
      "",
      `<b>${escapeHtml(release.title)}</b>`,
      escapeHtml(release.details),
      "",
      market,
      `Порог цены: /price ${want} 40`,
    ].join("\n"),
    photo: release.thumb,
    keyboard: [[{ text: "Открыть на Discogs", url: sellUrl(ref.id, env.CURRENCY) }]],
  };
}

async function addMaster(env: Env, discogs: Discogs, ref: Ref, format: string | null): Promise<string> {
  const limit = Number(env.MAX_MASTER_VERSIONS);
  const [master, versions] = await Promise.all([
    discogs.master(ref.id),
    discogs.versions(ref.id, format, limit + 1),
  ]);
  if (versions.length === 0) {
    return format ? `У мастера нет версий в формате «${escapeHtml(format)}».` : "У мастера нет версий.";
  }

  const now = new Date().toISOString();
  const want = await env.DB.prepare(
    `INSERT INTO wants (kind, discogs_id, title, format_filter, added_at, versions_synced_at)
     VALUES ('master', ?, ?, ?, ?, ?) RETURNING id`,
  )
    .bind(ref.id, master.title, format, now, now)
    .first<number>("id");
  await insertTargets(env, want!, master.title, versions.slice(0, limit));

  const lines = [
    `✅ Добавил мастер под номером ${want}`,
    "",
    `<b>${escapeHtml(master.title)}</b>`,
    `Слежу за версиями: ${Math.min(versions.length, limit)}${format ? ` (формат: ${escapeHtml(format)})` : ""}`,
  ];
  if (versions.length > limit) {
    lines.push(`Версий больше ${limit}, взял первые. Сузь формат, например /add m${ref.id} Vinyl`);
  } else if (!format && versions.length > 20) {
    lines.push(`Версий много. Если нужен только винил, удали и добавь заново: /add m${ref.id} Vinyl`);
  }
  lines.push("", `Первая проверка займёт пару минут и пройдёт молча. Порог цены: /price ${want} 40`);
  return lines.join("\n");
}

interface ListRow {
  id: number;
  kind: string;
  title: string;
  format_filter: string | null;
  max_price: number | null;
  versions: number;
  on_sale: number | null;
  lowest: number | null;
}

async function list(env: Env): Promise<Message | string> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.kind, w.title, w.format_filter, w.max_price,
            COUNT(t.release_id) AS versions,
            SUM(t.num_for_sale) AS on_sale,
            MIN(CASE WHEN t.num_for_sale > 0 THEN t.lowest_price END) AS lowest
     FROM wants w LEFT JOIN targets t ON t.want_id = w.id
     GROUP BY w.id ORDER BY w.id`,
  ).all<ListRow>();
  if (results.length === 0) return "Список пуст. Пришли ссылку на релиз или мастер.";

  const price = (v: number) => formatPrice(v, env.CURRENCY);
  const lines = results.map((r) => {
    const kind = r.kind === "master" ? ` · мастер, версий: ${r.versions}${r.format_filter ? `, ${escapeHtml(r.format_filter)}` : ""}` : "";
    const market = r.on_sale ? `в продаже ${r.on_sale}, от ${price(r.lowest!)}` : "в продаже нет";
    const max = r.max_price !== null ? ` · порог ${price(r.max_price)}` : "";
    return `<b>${r.id}.</b> ${escapeHtml(r.title)}${kind}\n    ${market}${max}`;
  });

  const targets = results.reduce((sum, r) => sum + r.versions, 0);
  const minutes = Math.max(1, Math.ceil(targets / Number(env.BATCH_SIZE)));
  lines.push("", `Всего релизов на проверке: ${targets}, каждый проверяю раз в ${minutes} мин.`);

  const keyboard: Keyboard = [];
  for (let i = 0; i < results.length; i += 4) {
    keyboard.push(results.slice(i, i + 4).map((r) => ({ text: `❌ ${r.id}`, callback_data: `rm:${r.id}` })));
  }
  return { text: lines.join("\n"), keyboard };
}

async function removeWant(env: Env, id: number): Promise<string | null> {
  if (!Number.isInteger(id)) return null;
  const title = await env.DB.prepare("SELECT title FROM wants WHERE id = ?").bind(id).first<string>("title");
  if (!title) return null;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM targets WHERE want_id = ?").bind(id),
    env.DB.prepare("DELETE FROM wants WHERE id = ?").bind(id),
  ]);
  return title;
}

export function parsePrice(input: string | undefined): number | "off" | null {
  if (!input) return null;
  if (/^(off|нет|-)$/i.test(input)) return "off";
  const value = Number(input.replace(",", ".").replace(/[€$£]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function setPrice(env: Env, id: number, input: string | undefined): Promise<string> {
  const price = parsePrice(input);
  if (!Number.isInteger(id) || price === null) return "Формат: /price 3 40 или /price 3 off";

  const maxPrice = price === "off" ? null : price;
  const result = await env.DB.prepare("UPDATE wants SET max_price = ? WHERE id = ?").bind(maxPrice, id).run();
  if (result.meta.changes === 0) return "Нет такого номера, смотри /list";

  // Mark targets already under the new limit, so we alert only on new drops, not on what /list already shows.
  await env.DB.prepare(
    `UPDATE targets SET under_max = CASE
       WHEN ? IS NOT NULL AND num_for_sale > 0 AND lowest_price <= ? THEN 1 ELSE 0 END
     WHERE want_id = ?`,
  )
    .bind(maxPrice, maxPrice, id)
    .run();

  return maxPrice === null
    ? `Порог для ${id} снят.`
    : `Для ${id} пришлю алерт, когда минимальная цена будет ${formatPrice(maxPrice, env.CURRENCY)} или ниже.`;
}
