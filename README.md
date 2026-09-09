# EK030 flight status dashboard

Smartphone-friendly live board for **Emirates EK030** (London Heathrow **LHR** → Dubai **DXB**).

Intended URL: `https://flights.mrg.im/ek030`

## Layout

```
public/
  ek030/
    index.html      # mobile-first dark UI
    styles.css
    app.js          # loads status.json every 60s
    status.json     # written by update.mjs
  status.json       # same payload (for /api/status.json)
update.mjs          # fetch flight + news → status.json
server.mjs          # Express: /ek030, /api/status.json
wrangler.jsonc      # Cloudflare Workers static assets (flights-mrg)
```

## Run locally

```bash
cd /workspace/flights-ek030
npm install
node update.mjs          # populate status.json (needs network)
npm start                # http://127.0.0.1:8787/ek030/
```

Open `/ek030` or `/ek030/` — assets are relative (`./status.json`, `./styles.css`).

### Env vars

| Variable | Required | Purpose |
|----------|----------|---------|
| `AVIATIONSTACK_KEY` | No | If set, tried first for flight status |
| `PORT` | No | Express port (default `8787`) |

No keys are required. Without AviationStack the updater scrapes FlightAware’s public UAE30 page for structured `trackpollBootstrap` data. If all sources fail, the UI shows **Status unavailable** and keeps any last-known times from a previous successful write (never invents times).

News comes from Google News RSS (LHR / DXB / Emirates). Failures leave an empty news list.

### Cron / Domvs

Run `node update.mjs` every 1–5 minutes (cron, systemd timer, or Flynn routine). Serve `public/` behind your reverse proxy with path `/ek030` → `public/ek030`, or use `server.mjs`.

## Cloudflare Worker (assets)

Worker name: **`flights-mrg`**  
Route: **`flights.mrg.im/*`**  
`not_found_handling`: **`single-page-application`**

```bash
npx wrangler deploy
# or: npx wrangler pages deploy public --project-name=flights-mrg
```

Ensure DNS for `flights.mrg.im` already points at Cloudflare (do not change production DNS from this repo). After deploy, `https://flights.mrg.im/ek030/` serves the dashboard; refresh `status.json` by running `update.mjs` in CI/cron and redeploying assets, or sync the JSON to the bucket/R2 your pipeline uses.

## Status JSON shape

```json
{
  "flight": "EK030",
  "status": "Delayed (+45m)",
  "statusCode": "delayed",
  "departure": { "airport": "LHR", "scheduled": "...", "estimated": "...", "actual": null },
  "arrival": { "airport": "DXB", "scheduled": "...", "estimated": "...", "actual": null },
  "updatedAt": "2026-09-09T…Z",
  "available": true,
  "news": [{ "title": "", "url": "", "source": "", "summary": "" }],
  "sources": [{ "name": "FlightAware", "url": "…" }]
}
```

## Notes

- Dark black/white mobile UI; large status type.
- Auto-refresh every 60 seconds in the browser.
- Do not invent live times — failures → “Status unavailable”.
