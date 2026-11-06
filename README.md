# discogs-telegram

A Telegram bot that watches the Discogs marketplace for a short "most wanted" list and tells you only when something worth buying shows up.

## How it works

- You manage the list in Telegram: send a Discogs release or master link, or `/add 38083371`, `/add m12345 Vinyl`.
- A Cloudflare Worker runs on a cron every minute and checks marketplace stats (`/marketplace/stats/{release_id}`) for the releases that have waited longest, up to `BATCH_SIZE` per run. With a short list every release is checked every minute; a longer list stretches the interval on its own. `/list` shows the current interval.
- A master is expanded into its versions, optionally only one format (`/add m12345 Vinyl`). Its version list is re-read once a day to pick up reissues.
- Without a price limit you get a message when a copy appears, another copy is listed, or the lowest price drops. With `/price 3 40` you get one only when the lowest price falls to 40 € or below, and again only if it drops further.
- The first check of anything new is silent: the `/add` reply already shows what is on sale.
- If Discogs can't be read 10 runs in a row, the bot warns you, and tells you again once it recovers.

### Limits

The Discogs API has no "all listings for a release" endpoint. It gives the number of copies for sale and the lowest price **across all conditions, without shipping**. So an alert can be about a Poor copy; open the listing to see the details. Filtering by condition, seller country or shipping would need scraping the sell page, which this bot doesn't do.

### Discogs rate limit from Workers

Discogs counts its 60 requests a minute per source IP, and Cloudflare Workers share their IPs with everyone else's workers. If `wrangler tail` shows `Discogs rate limit hit … x-discogs-ratelimit-remaining=0` while the same request from your laptop works, route the bot through a small proxy with its own IP: see [proxy/README.md](proxy/README.md).

## Commands

| Command | |
| --- | --- |
| link or `/add <id>` | add a release (`38083371`) or a master (`m12345`, optionally followed by a format) |
| `/list` | the list with what's on sale, with remove buttons |
| `/price <n> <amount>` / `/price <n> off` | set or clear the price limit for item `n` from `/list` |
| `/remove <n>` | remove item `n` |

## Deploy

You need a Cloudflare account (the free plan is enough), Node.js 22+ and a Discogs personal access token (Discogs → Settings → Developers).

```sh
npm install
npx wrangler login

# Database; copy database_id into wrangler.toml
npx wrangler d1 create discogs-telegram
npm run db:migrate

# Secrets
npx wrangler secret put TELEGRAM_BOT_TOKEN       # token from @BotFather
npx wrangler secret put TELEGRAM_CHAT_ID         # your chat id, several allowed, comma-separated
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET  # any random string, e.g. `openssl rand -hex 32`
npx wrangler secret put DISCOGS_TOKEN            # Discogs personal access token

npm run deploy
```

Then point Telegram at the worker, using the URL `wrangler deploy` printed and the same webhook secret:

```sh
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d url="https://discogs-telegram.<your-subdomain>.workers.dev/telegram" \
  -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
```

To find your `TELEGRAM_CHAT_ID`, send the bot any message *before* setting the webhook and open
`https://api.telegram.org/bot<TOKEN>/getUpdates`: the number is in `message.chat.id`.
The bot ignores messages from any other chat.

## Testing

Send `/help` to the bot, then a release link. To force a test alert, make the bot forget a release's market and wait a minute:

```sh
npx wrangler d1 execute discogs-telegram --remote \
  --command "UPDATE targets SET num_for_sale = 0, lowest_price = NULL WHERE release_id = 38083371"
```

Logs: `npx wrangler tail`.

## Development

```sh
npm test          # alert rules, parsing, bot commands and poller against in-memory SQLite
npm run typecheck
npm run dev       # local run; trigger the cron with curl "http://localhost:8787/__scheduled"
```

Settings live in `wrangler.toml` under `[vars]`: currency, requests per run, the version cap for masters and the failure warning threshold.
