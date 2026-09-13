import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnakinClient } from "./anakin.js";
import { ethGlobalEventUrls, normalizeAnakinFeed, normalizeEthGlobalEvent, rankAndDedupe } from "./opportunities.js";
import type { OpportunityCatalog } from "./types.js";

const file = resolve(process.cwd(), "data", "opportunities.json");
const anakinFeedFile = resolve(process.cwd(), "data", "anakin-feed.json");
export const emptyCatalog = (): OpportunityCatalog => ({ opportunities: [], lastSyncedAt: null, sourcesQueried: 0, failures: [] });
export function readCatalog(): OpportunityCatalog { try { return { ...emptyCatalog(), ...JSON.parse(readFileSync(file, "utf8")) }; } catch { return emptyCatalog(); } }
function writeCatalog(value: OpportunityCatalog) { mkdirSync(dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2)); renameSync(temporary, file); }

export async function refreshCatalog(anakin: AnakinClient) {
  const groups: OpportunityCatalog["opportunities"][] = []; const failures: string[] = [];
  const previous = readCatalog();
  try {
    const index = await anakin.scrapePublicPage("https://ethglobal.com/events");
    const urls = ethGlobalEventUrls(index.markdown);
    const events: OpportunityCatalog["opportunities"] = [];
    let rejected = 0;
    for (const url of urls) {
      try {
        const event = normalizeEthGlobalEvent((await anakin.scrapePublicPage(url)).markdown, url);
        if (event) events.push(event);
      } catch { rejected += 1; }
    }
    groups.push(events.length ? events : previous.opportunities.filter(item => item.category === "hackathon" && item.sourceHost === "ethglobal.com"));
    if (rejected) failures.push(`ETHGlobal: ${rejected} event page${rejected === 1 ? "" : "s"} could not be read`);
  } catch (error) {
    failures.push(`ETHGlobal: ${error instanceof Error ? error.message : "failed"}`);
    groups.push(previous.opportunities.filter(item => item.category === "hackathon" && item.sourceHost === "ethglobal.com"));
  }

  // Anakin pipeline feed (Devpost, Unstop, Devfolio, MLH, DoraHacks, Kajimelo,
  // Superteam Earn) — refreshed independently by scripts/anakin_pipeline/pipeline.py,
  // not by this server. Re-read and re-normalized on every sync so it's never
  // silently dropped the way a plain static copy would be; on any read/parse
  // failure it falls back to whatever anakin-tagged rows survived the previous
  // sync, same pattern as the ETHGlobal fallback above.
  try {
    const raw = JSON.parse(readFileSync(anakinFeedFile, "utf8")) as Array<Record<string, unknown>>;
    groups.push(normalizeAnakinFeed(raw));
  } catch (error) {
    failures.push(`Anakin feed: ${error instanceof Error ? error.message : "failed"}`);
    groups.push(previous.opportunities.filter(item => item.id.startsWith("anakin-")));
  }

  const fresh = rankAndDedupe(groups);
  const next: OpportunityCatalog = { opportunities: fresh, lastSyncedAt: new Date().toISOString(), sourcesQueried: groups.length, failures };
  writeCatalog(next); return next;
}
