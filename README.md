# Eire Daily Dashboard

Irish news, weather, ambience, and mood dashboard for an old Lenovo Yoga Tab 3.

Live Worker:
https://eire-daily-dashboard.gav-s-may.workers.dev

## What it does

- Serves the static kiosk UI from Cloudflare Workers assets.
- Provides live Irish headlines at `/api/news`.
- Provides live Dublin weather at `/api/weather` using Open-Meteo.
- Provides `/api/health` for a quick uptime check.
- Provides `/api/mood` for "The State of It", a small Gemini-powered news mood gauge.
- Falls back quietly in the browser so the kiosk does not look broken if an API call fails.

## Useful commands

```bash
npm install
npm run dev
npm run deploy
npm run tail
npm run validate-feeds
```

## Notes

The production Worker uses `wrangler.toml`. Do not merge older Cloudflare auto-config PRs that add a separate `wrangler.jsonc` unless you deliberately want to replace the current deploy setup.

Keep API keys and local secrets out of Git. The repo uses `.gitignore` and `.assetsignore` to avoid committing or serving private files.
