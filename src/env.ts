import { Message, send } from "./telegram";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string; // one id or several, comma-separated
  TELEGRAM_WEBHOOK_SECRET: string;
  DISCOGS_TOKEN: string;
  DISCOGS_API_URL?: string; // proxy base URL, see proxy/README.md; defaults to https://api.discogs.com
  DISCOGS_PROXY_SECRET?: string;
  CURRENCY: string;
  BATCH_SIZE: string;
  MAX_MASTER_VERSIONS: string;
  FAILURE_ALERT_THRESHOLD: string;
}

export function chatIds(env: Env): string[] {
  return env.TELEGRAM_CHAT_ID.split(",").map((id) => id.trim()).filter(Boolean);
}

export async function broadcast(env: Env, msg: Message): Promise<void> {
  for (const chatId of chatIds(env)) {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, msg);
  }
}

export async function getState(env: Env, key: string): Promise<string | null> {
  return env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first<string>("value");
}

export async function setState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

export function sellUrl(releaseId: number, currency: string): string {
  return `https://www.discogs.com/sell/release/${releaseId}?currency=${currency}&sort=price%2Casc`;
}
