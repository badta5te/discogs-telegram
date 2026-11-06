import { handleUpdate } from "./bot";
import { Env } from "./env";
import { poll } from "./poll";

export type { Env };

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await poll(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("discogs-telegram is running\n");
    }
    // Telegram echoes the secret given to setWebhook; anything else isn't Telegram.
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      await handleUpdate(env, await request.json());
    } catch (err) {
      // Always 200: otherwise Telegram keeps redelivering the same broken update.
      console.error("update failed", err);
    }
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
