# OpenShelf

OpenShelf is a source-verified opportunity feed powered by Anakin.

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
- Serves a responsive, source-linked opportunity feed.

## Run locally

```cmd
cd /d "C:\Users\yezir\Documents\Codex\2026-09-11\bidkit-anakin"
npm install
npm run dev
```

Open `http://localhost:8090`.

The ETHGlobal feed uses Anakin's public Zero Touch read surface. `ANAKIN_API_KEY` remains supported by the older compiler modules but is not required to read the current public shelf.

## Commands

```cmd
npm run sync
npm run build
npm test
npm run dev
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
- `src/catalog.ts` — refresh pipeline (ETHGlobal + the Anakin feed) and
  last-known-good behavior for each.
- `src/server.ts` — JSON endpoints and static frontend server.
- `scripts/anakin_pipeline/` — the standalone Python pipeline that
  produces `data/anakin-feed.json` (Devpost, Unstop, Devfolio, MLH,
  DoraHacks, Kajimelo, Superteam Earn) — see its README.
- `public/` — the OpenShelf interface.
- `tests/` — normalization and compiler regression coverage.
