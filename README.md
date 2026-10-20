# 4xD website

Static site for the 4xD VST3 plug-in, served by the Cloudflare Worker `4xd-website` (static assets only).

- `public/` — everything that gets deployed. Nothing else in the repo is published.
- `wrangler.jsonc` — Worker config. `name` must match the Worker name in Cloudflare.

## Local preview

```sh
npm install
npm run dev
```

## Deploying

Pushes to `main` deploy to production through Cloudflare Workers Builds. Work on a branch and merge when ready.

## Feedback form

`src/index.js` handles `POST /api/feedback`: it checks Cloudflare Turnstile, a honeypot field, field limits and a per-connection hourly cap, then stores the report in the D1 database `4xd-feedback`.

- The Turnstile secret is a **runtime** secret on the Worker (Settings → Variables and Secrets), named `TURNSTILE_SECRET_KEY`. Build variables are not visible to the Worker.
- For local development, put Cloudflare's test secret in `.dev.vars` (git-ignored): `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`.
- Read reports in the dashboard: Storage & databases → D1 → `4xd-feedback` → Console, then `SELECT * FROM reports ORDER BY id DESC;`
