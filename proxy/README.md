# Discogs proxy

Discogs limits API requests per source IP. Cloudflare Workers share their outgoing IPs with
everyone else's workers, so those IPs often have no requests left (`x-discogs-ratelimit-remaining: 0`),
even though your token hasn't used any. This proxy sends the bot's requests from a server
with its own IP. The worker, D1 and Telegram stay as they are.

Any small Linux server with a public IP works (a €4 VPS, or an always-free Oracle Cloud VM).

## Setup

On the server (Debian/Ubuntu):

```sh
sudo apt install -y caddy
```

Pick a hostname. You don't need a domain: `<ip-with-dashes>.sslip.io` resolves to that IP,
e.g. `203-0-113-7.sslip.io`, and Caddy gets an HTTPS certificate for it automatically.
Ports 80 and 443 must be open.

Copy `Caddyfile` to `/etc/caddy/Caddyfile`, then set the variables and restart:

```sh
sudo systemctl edit caddy
# add:
# [Service]
# Environment=PROXY_HOST=203-0-113-7.sslip.io
# Environment=PROXY_SECRET=<openssl rand -hex 32>
sudo systemctl restart caddy
```

Check it from your laptop: the first request returns 403, the second returns Discogs JSON.

```sh
curl -i https://203-0-113-7.sslip.io/marketplace/stats/38083371
curl -i -H "X-Proxy-Secret: <secret>" -H "Authorization: Discogs token=<token>" \
  https://203-0-113-7.sslip.io/marketplace/stats/38083371
```

## Point the bot at it

In the bot's folder:

```sh
npx wrangler secret put DISCOGS_API_URL        # https://203-0-113-7.sslip.io
npx wrangler secret put DISCOGS_PROXY_SECRET   # the same secret
```

The secrets take effect immediately, no redeploy needed. Without `DISCOGS_API_URL` the bot calls `api.discogs.com` directly.
