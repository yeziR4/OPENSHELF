# OpenShelf

OpenShelf is a source-verified opportunity feed powered by Anakin. It's a
static site — no live backend, no server-held secrets shipped to
visitors. Data is refreshed on a schedule (not on click) and the result
is just JSON + HTML/CSS/JS served as-is.

## Current experience

- Reads the live ETHGlobal event index through Anakin, opens each current
  event page, and extracts its application link, dates, location, prize
  pool, team size and official logo.
- Also serves hackathons, competitions, quizzes, AI video contests and
  bounties from Devpost, Unstop, Devfolio, MLH, DoraHacks, Kajimelo and
  Superteam Earn, via a separate feed (`data/anakin-feed.json`, produced
  by `scripts/anakin_pipeline/pipeline.py` — see its README for what's
  in it and how to refresh it).
- Excludes past events and events that no longer expose an application
  path.
- Keeps missing deadlines visibly missing instead of manufacturing dates.
- Serves a responsive, source-linked opportunity feed, filterable by
  category and sortable by rank/deadline/recency — all client-side.

## Run locally

```bash
pnpm install
ANAKIN_API_KEY=your_key pnpm run sync   # writes public/data/opportunities.json
pnpm run dev                            # static preview at http://localhost:8090
```

`pnpm run sync` is the only step that needs `ANAKIN_API_KEY` — it's what
talks to Anakin (reading ETHGlobal live, and re-normalizing
`data/anakin-feed.json`). `pnpm run dev`/`pnpm start` is a plain static
file server with no key requirement at all; it just needs
`public/data/opportunities.json` to already exist, which is why `sync`
runs first.

## Hosting (GitHub Pages)

`.github/workflows/refresh-and-deploy.yml` runs `pnpm run sync` on a
schedule (every 6 hours, plus on push to `main` and on manual dispatch),
then publishes `public/` to GitHub Pages. Two one-time setup steps on
GitHub, neither of which this repo's code can do for you:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → New repository secret:**
   `ANAKIN_API_KEY` (the workflow reads it as `secrets.ANAKIN_API_KEY`).

After that, every scheduled run re-reads ETHGlobal + `data/anakin-feed.json`
and redeploys — no server to keep running, nothing to restart if it
crashes, no secret ever reaches the browser.

To refresh `data/anakin-feed.json` itself (the 7-source pipeline feed,
as opposed to the live ETHGlobal read), see
`scripts/anakin_pipeline/README.md` — that's a separate, occasional step
since it's a real Anakin credit spend (~85 calls), not something to run
every 6 hours the way the ETHGlobal read is.

## Commands

```bash
pnpm run sync    # refresh + write public/data/opportunities.json (needs ANAKIN_API_KEY)
pnpm run build   # tsc --noEmit
pnpm test        # vitest run
pnpm run dev     # static preview server, tsx watch
```

## Data integrity

- The public feed is source allow-listed; broad search results are not published.
- A record must resolve to an official individual event page.
- An event without a published application deadline may appear only while its official application link is present.
- Every displayed logo comes from the official event page.
- The Anakin pipeline feed is verified via each source's own structured
  listing API or a deterministic HTML parse rather than a per-page
  AI-extraction pass — every row from it says so explicitly in its
  `dataWarnings`, so that distinction is never blurred with the
  ETHGlobal rows' verification method.
- Cached live responses, local environment files and credentials are excluded from Git.

## Architecture

- `src/anakin.ts` — Anakin Wire and URL Scraper client.
- `src/opportunities.ts` — source parsing, validation and normalization
  (includes `normalizeAnakinFeed` for the pipeline feed below).
- `src/catalog.ts` — refresh logic (ETHGlobal + the Anakin feed) and
  last-known-good behavior for each; called by `src/sync.ts`.
- `src/sync.ts` — the only thing that talks to Anakin; writes
  `public/data/opportunities.json`. Run via `pnpm run sync`, locally or
  in `.github/workflows/refresh-and-deploy.yml`.
- `src/server.ts` — a static file server for local preview only (matches
  what GitHub Pages serves in production). No API routes, no secrets.
- `scripts/anakin_pipeline/` — the standalone Python pipeline that
  produces `data/anakin-feed.json` (Devpost, Unstop, Devfolio, MLH,
  DoraHacks, Kajimelo, Superteam Earn) — see its README.
- `public/` — the OpenShelf interface; `public/app.js` fetches
  `data/opportunities.json` and does all filtering/sorting client-side.
- `tests/` — normalization and compiler regression coverage.
