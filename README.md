# OpenShelf

OpenShelf is a source-verified opportunity feed powered by Anakin. The current public shelf intentionally contains only actionable ETHGlobal hackathons recovered from official event pages.

## Current experience

- Reads the live ETHGlobal event index through Anakin.
- Opens each current event page and extracts its application link, dates, location, prize pool, team size and official logo.
- Excludes past events and events that no longer expose an application path.
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
- Every displayed logo comes from the official ETHGlobal event page.
- Cached live responses, local environment files and credentials are excluded from Git.

## Architecture

- `src/anakin.ts` — Anakin Wire and URL Scraper client.
- `src/opportunities.ts` — source parsing, validation and normalization.
- `src/catalog.ts` — allow-listed ETHGlobal refresh pipeline and last-known-good behavior.
- `src/server.ts` — JSON endpoints and static frontend server.
- `public/` — the OpenShelf interface.
- `tests/` — normalization and compiler regression coverage.

## Planned source audition

Superteam Earn is the next candidate. Anakin successfully recovers its rendered HTML, listing routes and hosted media, but it should not be added to the public feed until a dedicated parser verifies bounty/project status, deadline, reward, sponsor and application URL for each listing.
