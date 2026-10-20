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
