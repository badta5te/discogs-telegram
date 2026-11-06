export type Keyboard = { text: string; url?: string; callback_data?: string }[][];

export interface Message {
  text: string; // HTML
  photo?: string;
  keyboard?: Keyboard;
}

const CAPTION_LIMIT = 1024;

export async function send(token: string, chatId: string, msg: Message): Promise<void> {
  const reply_markup = msg.keyboard ? { inline_keyboard: msg.keyboard } : undefined;

  if (msg.photo && msg.text.length <= CAPTION_LIMIT) {
    const ok = await call(token, "sendPhoto", {
      chat_id: chatId,
      photo: msg.photo,
      caption: msg.text,
      parse_mode: "HTML",
      reply_markup,
    }).then(() => true, () => false);
    if (ok) return;
    // Telegram sometimes can't fetch the image; fall through to plain text.
  }

  await call(token, "sendMessage", {
    chat_id: chatId,
    text: msg.text,
    parse_mode: "HTML",
    reply_markup,
    link_preview_options: { is_disabled: true },
  });
}

export async function answerCallback(token: string, id: string, text?: string): Promise<void> {
  await call(token, "answerCallbackQuery", { callback_query_id: id, text });
}

export async function call(token: string, method: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Telegram ${method} failed: ${res.status} ${await res.text()}`);
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CURRENCY_SIGNS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function formatPrice(value: number, currency: string): string {
  const sign = CURRENCY_SIGNS[currency.toUpperCase()] ?? currency;
  return `${value.toFixed(2)} ${sign}`;
}
