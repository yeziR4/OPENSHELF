# Anakin opportunity pipeline

A standalone Python script (not part of the Node app, no shared runtime)
that pulls real, currently-live opportunities from seven sources —
Devpost, Unstop (hackathons + competitions + quizzes), Devfolio, MLH,
DoraHacks, Kajimelo, and Superteam Earn — normalizes them to one schema,
and exports `data/anakin-feed.json`. `src/opportunities.ts`'s
`normalizeAnakinFeed()` reads that file and maps it into OpenShelf's own
`Opportunity` type; `src/catalog.ts` re-reads and re-normalizes it on
every sync, same as the ETHGlobal source.

## Why a separate Python script instead of another TypeScript normalizer

Every fetch in this pipeline goes through Anakin's `url-scraper` API too
(same product, `POST /v1/url-scraper/scrape`) — it was originally built
and iterated on independently of this repo. Porting it into
`src/anakin.ts`'s client is a reasonable future step; for now it's kept
separate to avoid a large, higher-risk rewrite touching working code.

## Regenerating the feed

```bash
cd scripts/anakin_pipeline
ANAKIN_API_KEY=your_key python3 pipeline.py --out ./out
cp out/hackathons.json ../../data/anakin-feed.json
```

A full run is ~85 Anakin calls and takes 15-20 minutes — budget real
credit spend; this pipeline has hit `402 insufficient_credits` mid-run
more than once. See the module docstring and inline comments in
`pipeline.py` for the full per-source breakdown, what's guaranteed
non-null (organizer/location/prize — `--require-complete`, on by
default), how cross-source duplicates are merged rather than shown
twice, and the known gaps (currency isn't normalized across sources,
MLH is entirely excluded because its listing page never exposes
organizer/prize, Kajimelo's `organizer` is the festival's own name
since no separate organizing entity is exposed on its listing page,
etc). Nothing in `normalizeAnakinFeed()` hides those gaps — it surfaces
the same caveats as this repo's own `dataWarnings` convention.

## Data integrity note

Every row here does resolve to a specific official event/listing page —
never a search result or a collection/directory page — same bar as the
rest of this repo. It's verified via each platform's own structured
listing API or a deterministic HTML parse (confirmed against the real
page structure, not guessed), rather than Codex's per-page
AI-extraction-with-quoted-evidence pass. `normalizeAnakinFeed()` marks
it `"page-verified"` so it's served by the public feed, and adds an
explicit `dataWarnings` line saying so on every row, rather than
letting that distinction blur into the existing "page-verified" rows
that came from a different verification method.
