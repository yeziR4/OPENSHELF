import { createHash } from "node:crypto";
import type { Opportunity, OpportunityCategory } from "./types.js";

const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const deadlinePatterns = [
  new RegExp(`(?:deadline|closes?|closing(?: date)?|apply by|ends?)\\s*[:–-]?\\s*(${month}\\s+\\d{1,2},?\\s+20\\d{2})`, "i"),
  new RegExp(`(?:deadline|closes?|closing(?: date)?|apply by|ends?)\\s*[:–-]?\\s*(\\d{1,2}\\s+${month}\\s+20\\d{2})`, "i"),
  /(?:deadline|closes?|closing(?: date)?|apply by|ends?)\s*[:–-]?\s*(20\d{2}-\d{2}-\d{2})/i,
  /(?:deadline|closes?|closing(?: date)?|apply by|ends?)\s*[:–-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})/i,
];
const rewardPatterns = [/(?:prize(?: pool)?|reward|grant|award|budget|value|up to)\s*(?:of\s*)?[:–-]?\s*((?:US)?[$€£₦]\s?[\d,.]+(?:\s?[KMB])?)/i,/((?:US)?[$€£₦]\s?[\d,.]+(?:\s?[KMB])?)\s+(?:prize|grant|bounty|budget)/i];
const brokenTitleSignals = /PagedResult`|Application\.Common\.|404|page not found/i;
const collectionSignals = /all (?:tenders|grants|jobs)|latest (?:tenders|grants|jobs)|database|directory|search results|browse opportunities|jobs? (?:&|and) projects|open opportunities|hackathons? open|hackathon calendar|grants for (?:startups|small businesses)|live bug bounties|opportunity discovery/i;
const establishedHosts = ["devpost.com", "github.com", "challenge.gov", "grants.gov", "tenders.service.gov.uk", "sam.gov", "unicef.org", "undp.org", "worldbank.org", "europa.eu", "wellfound.com", "upwork.com", "fiverr.com", "indeed.com", "hackerone.com"];

export const feedDefinitions: Array<{ category: OpportunityCategory; prompt: string }> = [
  { category: "tender", prompt: "currently open technology, software, digital services or consulting tenders with direct notice pages; include deadlines and contract values" },
  { category: "hackathon", prompt: "currently open global online hackathons accepting submissions; include deadline, prize and official registration page" },
  { category: "grant", prompt: "currently open grants for startups, developers, creators or small businesses; include eligibility, deadline and award amount" },
  { category: "bounty", prompt: "currently open paid software, open source, AI or security bounties; include reward and direct task page" },
  { category: "freelance", prompt: "currently open remote freelance software, design, writing or AI contracts with a direct public project page; include budget where visible" },
];

const compact = (value: unknown, limit = 300) => { const text = String(value ?? "").replace(/[\r\n*#]+/g, " ").replace(/\s+/g, " ").trim(); return text.length <= limit ? text : `${text.slice(0, limit + 1).replace(/\s+\S*$/, "")}…`; };
function extract(patterns: RegExp[], text: string) { for (const pattern of patterns) { const match = text.match(pattern); if (match?.[1]) return compact(match[1], 80); } return null; }
function parseDate(value: string | null) { if (!value) return null; let normalized = value.match(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/) ? value.replace(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/, "$3-$2-$1") : value; normalized = normalized.replace(/,\s*(\d{1,2}:\d{2})(am|pm)$/i, " $1 $2"); const time = Date.parse(normalized); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function canonicalUrl(value: unknown) { try { const url = new URL(String(value)); url.hash = ""; ["utm_source", "utm_medium", "utm_campaign", "ref"].forEach(key => url.searchParams.delete(key)); return url.toString().replace(/\/$/, ""); } catch { return null; } }
function quality(url: URL) { if (/\.(gov|gov\.[a-z]{2}|int)$/i.test(url.hostname)) return "official" as const; if (establishedHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "established" as const; return "unverified" as const; }

function scoreOpportunity(input: Omit<Opportunity, "score" | "scoreReasons">, today: Date) {
  let score = input.entryType === "collection" ? 5 : 20; const reasons: string[] = [];
  if (input.verification === "page-verified") { score += 20; reasons.push("Source page checked"); }
  if (input.sourceQuality === "official") { score += 15; reasons.push("Government domain"); } else if (input.sourceQuality === "established") { score += 10; reasons.push("Known platform"); }
  if (input.deadlineAt) { const days = Math.ceil((Date.parse(input.deadlineAt) - today.getTime()) / 86_400_000); if (days >= 3 && days <= 45) { score += 20; reasons.push(`${days} days to act`); } else if (days > 45) { score += 12; reasons.push("Long application window"); } else if (days >= 0) { score += 5; reasons.push("Closing very soon"); } }
  if (input.reward) { score += 15; reasons.push("Reward or value disclosed"); }
  if (input.worldwide || input.remote) { score += 10; reasons.push(input.worldwide ? "Open worldwide" : "Remote"); }
  if (input.freeToEnter) { score += 5; reasons.push("Free to enter"); }
  if (input.summary.length > 80) score += 5;
  return { score: Math.min(score, 100), scoreReasons: reasons.slice(0, 4) };
}

export function normalizeOpportunityResults(raw: Array<Record<string, unknown>>, category: OpportunityCategory, today = new Date()): Opportunity[] {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).getTime(); const seen = new Set<string>();
  return raw.flatMap(item => {
    const urlString = canonicalUrl(item.url ?? item.link); if (!urlString || seen.has(urlString)) return [];
    const url = new URL(urlString); const title = compact(item.title ?? item.name, 150); const full = compact(item.content ?? item.snippet, 3_000);
    if (!title || brokenTitleSignals.test(title)) return [];
    const entryType = collectionSignals.test(`${title} ${url.pathname}`) || (/\b(?:\d{2,}|hundreds?) (?:active |open )?(?:grants|jobs|tenders|bounties)\b/i.test(full) && !/issues?\/\d+/.test(url.pathname)) ? "collection" : "opportunity";
    const extractedDeadline = extract(deadlinePatterns, `${title} ${full}`); const deadline = entryType === "collection" ? null : extractedDeadline; const deadlineAt = parseDate(deadline); if (deadlineAt && Date.parse(deadlineAt) < start) return [];
    const reward = entryType === "collection" ? null : extract(rewardPatterns, `${title} ${full}`); const sourceQuality = quality(url); const observedAt = today.toISOString();
    const base: Omit<Opportunity, "score" | "scoreReasons"> = { id: createHash("sha256").update(urlString).digest("hex").slice(0, 16), title, category, organizer: item.organizer ? compact(item.organizer, 100) : null, url: urlString, sourceHost: url.hostname.replace(/^www\./, ""), sourceQuality, entryType, verification: "search-only", status: "unknown", eligibility: null, applicationUrl: null, evidence: null, summary: compact(full), deadline, deadlineAt, reward, location: item.location ? compact(item.location, 80) : null, remote: /\bremote|online|virtual\b/i.test(full) ? true : null, worldwide: /\bworldwide|global|open to (?:anyone|everyone|all countries)\b/i.test(full) ? true : null, freeToEnter: /\bfree to (?:enter|apply|join)|no (?:entry )?fee\b/i.test(full) ? true : null, publishedAt: item.date ? String(item.date) : null, observedAt, dataWarnings: entryType === "collection" ? ["Collection page — review individual listings"] : ["Source page not yet checked"] };
    seen.add(urlString); return [{ ...base, ...scoreOpportunity(base, today) }];
  });
}

function nullableText(value: unknown, limit = 300) { const text = compact(value, limit); return text && !/^(?:null|unknown|not (?:found|provided|specified|available)|n\/a)$/i.test(text) ? text : null; }
function statusValue(value: unknown): Opportunity["status"] { const status = String(value ?? "unknown").toLowerCase(); return ["open", "closed", "upcoming", "rolling"].includes(status) ? status as Opportunity["status"] : "unknown"; }

export function enrichOpportunity(item: Opportunity, extracted: Record<string, unknown>, today = new Date()): Opportunity | null {
  const pageText = compact(extracted.__markdown, 12_000); const combined = `${nullableText(extracted.title, 150) ?? item.title} ${nullableText(extracted.summary, 500) ?? ""} ${pageText}`;
  const collection = collectionSignals.test(combined) || /\b(?:\d{2,}|hundreds?) (?:active |open )?(?:grants|jobs|tenders|bounties|hackathons)\b/i.test(combined);
  let status = statusValue(extracted.status);
  if (status === "unknown" && /\b(?:state\s*:\s*open|applications? (?:are )?open|apply now|accepting (?:applications|submissions))\b/i.test(combined)) status = "open";
  if (/\b(?:applications? closed|submissions? closed|registration closed|state\s*:\s*closed)\b/i.test(combined)) status = "closed";
  if (status === "closed") return null;
  const deadline = collection ? null : nullableText(extracted.deadline, 100) ?? extract(deadlinePatterns, combined); const deadlineAt = parseDate(deadline);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).getTime();
  if (deadlineAt && Date.parse(deadlineAt) < start) return null;
  const applicationUrl = canonicalUrl(extracted.applicationUrl);
  const verified: Omit<Opportunity, "score" | "scoreReasons"> = {
    ...item,
    title: nullableText(extracted.title, 150) ?? item.title,
    organizer: nullableText(extracted.organizer, 100) ?? item.organizer,
    summary: nullableText(extracted.summary, 360) ?? item.summary,
    deadline,
    deadlineAt,
    reward: collection ? null : nullableText(extracted.reward, 100) ?? extract(rewardPatterns, combined),
    eligibility: nullableText(extracted.eligibility, 260),
    applicationUrl,
    evidence: nullableText(extracted.evidence, 240),
    location: nullableText(extracted.location, 100) ?? item.location,
    remote: typeof extracted.remote === "boolean" ? extracted.remote : item.remote,
    worldwide: typeof extracted.worldwide === "boolean" ? extracted.worldwide : item.worldwide,
    freeToEnter: typeof extracted.freeToEnter === "boolean" ? extracted.freeToEnter : item.freeToEnter,
    entryType: collection ? "collection" : "opportunity",
    verification: "page-verified",
    status,
    dataWarnings: collection ? ["Collection page — review individual listings"] : [...(!deadline && status !== "rolling" ? ["No deadline stated on source"] : []), ...(status === "unknown" ? ["Open status not explicit"] : [])],
  };
  if (!collection && !deadline && status === "unknown") return null;
  return { ...verified, ...scoreOpportunity(verified, today) };
}

export function rankAndDedupe(groups: Opportunity[][]) { const byUrl = new Map<string, Opportunity>(); for (const item of groups.flat()) { const current = byUrl.get(item.url); if (!current || item.score > current.score) byUrl.set(item.url, item); } return [...byUrl.values()].sort((a, b) => b.score - a.score || (a.deadlineAt ?? "9999").localeCompare(b.deadlineAt ?? "9999")); }

function structuredOpportunity(input: Omit<Opportunity, "id" | "score" | "scoreReasons" | "observedAt">, today: Date): Opportunity {
  const base: Omit<Opportunity, "score" | "scoreReasons"> = { ...input, id: createHash("sha256").update(input.url).digest("hex").slice(0, 16), observedAt: today.toISOString() };
  return { ...base, ...scoreOpportunity(base, today) };
}

export function normalizeGrantWatch(data: Record<string, unknown>, today = new Date()): Opportunity[] {
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return items.flatMap(item => { const url = canonicalUrl(item.url); const title = nullableText(item.title, 160); if (!url || !title) return []; const summary = compact(item.description, 360); const deadline = nullableText(item.deadline, 80); const deadlineAt = parseDate(deadline); if (!deadlineAt || Date.parse(deadlineAt) < today.getTime()) return []; return [structuredOpportunity({ title, category: "grant", organizer: "GrantWatch listing", url, applicationUrl: url, sourceHost: new URL(url).hostname.replace(/^www\./, ""), sourceQuality: "established", entryType: "opportunity", verification: "page-verified", status: "open", summary, deadline, deadlineAt, reward: extract(rewardPatterns, summary), eligibility: summary.split(/\.(?:\s|$)/)[0] || null, location: null, remote: null, worldwide: /international/i.test(summary), freeToEnter: null, publishedAt: null, evidence: `Deadline: ${deadline}`, dataWarnings: [] }, today)]; });
}

export function normalizeRemoteJobs(data: Record<string, unknown>, today = new Date()): Opportunity[] {
  const items = Array.isArray(data.data) ? data.data as Record<string, unknown>[] : [];
  return items.flatMap(item => { const url = canonicalUrl(item.apply_url ?? item.url); const title = nullableText(item.position, 140); if (!url || !title) return []; const minimum = Number(item.salary_min ?? 0), maximum = Number(item.salary_max ?? 0); const reward = maximum > 0 ? `$${minimum.toLocaleString()}–$${maximum.toLocaleString()} / year` : null; return [structuredOpportunity({ title, category: "freelance", organizer: nullableText(item.company, 100), url, applicationUrl: url, sourceHost: new URL(url).hostname.replace(/^www\./, ""), sourceQuality: "established", entryType: "opportunity", verification: "page-verified", status: "rolling", summary: compact(String(item.description ?? "").replace(/<[^>]+>/g, " "), 360), deadline: null, deadlineAt: null, reward, eligibility: null, location: nullableText(item.location, 100) ?? "Remote", remote: true, worldwide: null, freeToEnter: true, publishedAt: nullableText(item.date, 80), evidence: item.date ? `Published ${String(item.date)}` : "Live RemoteOK listing", dataWarnings: !reward ? ["Compensation not stated"] : [] }, today)]; });
}

export function normalizeTenderWire(data: Record<string, unknown>, today = new Date()): Opportunity[] {
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return items.flatMap(item => { const noticeType = String(item.notice_type ?? ""); if (!/tender notice|preliminary market engagement/i.test(noticeType)) return []; const url = canonicalUrl(item.url); const title = nullableText(item.title, 160); const deadline = nullableText(item.submission_deadline ?? item.engagement_deadline, 100); const deadlineAt = parseDate(deadline); if (!url || !title || !deadline || !deadlineAt || Date.parse(deadlineAt) < today.getTime()) return []; const value = (item.total_value_including_vat ?? item.contract_value_including_vat) as Record<string, unknown> | undefined; const amount = Number(value?.value ?? 0); const reward = amount > 0 ? `${String(value?.currency ?? "GBP")} ${amount.toLocaleString()}` : null; return [structuredOpportunity({ title, category: "tender", organizer: nullableText(item.organisation ?? item.buyer, 120), url, applicationUrl: url, sourceHost: new URL(url).hostname.replace(/^www\./, ""), sourceQuality: "official", entryType: "opportunity", verification: "page-verified", status: "open", summary: noticeType, deadline, deadlineAt, reward, eligibility: null, location: nullableText(item.contract_location, 100) ?? "United Kingdom", remote: null, worldwide: null, freeToEnter: null, publishedAt: nullableText(item.publication_date, 80), evidence: `Submission deadline: ${deadline}`, dataWarnings: [] }, today)]; });
}

const ethMonth: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function ethDeadline(markdown: string, year: number) {
  const match = markdown.match(/([A-Z][a-z]{2}),\s+([A-Z][a-z]{2})\s+(\d{1,2})\s*\n\s*\n(\d{1,2}):(\d{2})(am|pm)\s*\n\s*\n### Deadline to Apply/i);
  if (!match) return { label: null, iso: null };
  let hour = Number(match[4]);
  if (match[6].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (match[6].toLowerCase() === "am" && hour === 12) hour = 0;
  const month = ethMonth[match[2]];
  if (month === undefined) return { label: null, iso: null };
  const date = new Date(Date.UTC(year, month, Number(match[3]), hour, Number(match[5])));
  return { label: `${match[2]} ${Number(match[3])}, ${year} · ${match[4]}:${match[5]}${match[6].toLowerCase()}`, iso: date.toISOString() };
}

export function ethGlobalEventUrls(markdown: string) {
  const currentEvents = markdown.split(/## Past\d*/i)[0];
  const urls = [...currentEvents.matchAll(/https:\/\/ethglobal\.com\/events\/([a-z0-9-]+)/gi)].map(match => `https://ethglobal.com/events/${match[1]}`);
  return [...new Set(urls)].filter(url => !/\/events\/(?:new|showcase)$/i.test(url)).slice(0, 12);
}

export function normalizeEthGlobalEvent(markdown: string, url: string, today = new Date()): Opportunity | null {
  if (!/\b(?:Async|IRL) Hackathon\b|ETHGlobal hackathons enable/i.test(markdown)) return null;
  const title = markdown.match(/\]\(https:\/\/ethglobal\.com\/events\/[a-z0-9-]+\)\s+([^\n]+)/i)?.[1]?.trim()
    ?? markdown.match(/^#\s+([^\n]+)$/m)?.[1]?.replace(/!\[[^\]]+\]\([^)]*\)/, "").trim();
  const dates = markdown.match(/([A-Z][a-z]+ \d{1,2})\s+[–-]\s+(\d{1,2}),\s+(20\d{2})/);
  if (!title || !dates) return null;
  const year = Number(dates[3]);
  const deadline = ethDeadline(markdown, year);
  if (deadline.iso && Date.parse(deadline.iso) < today.getTime()) return null;
  const startMonth = ethMonth[dates[1].slice(0, 3)];
  if (startMonth === undefined) return null;
  const eventEnd = new Date(Date.UTC(year, startMonth, Number(dates[2]), 23, 59, 59));
  if (eventEnd.getTime() < today.getTime()) return null;
  const dateLine = dates[0];
  const afterDate = markdown.slice((dates.index ?? 0) + dateLine.length).split(/\n/).map(value => value.trim()).filter(Boolean);
  const location = afterDate.find(value => !value.startsWith("[") && value.length < 80) ?? null;
  const prizeMatch = markdown.match(/##\s+\$([\d,]+)\s*\n\s*\n### Available in prizes/i);
  const prizeLinks = [...markdown.matchAll(/\$([\d,]+)\]\(https:\/\/ethglobal\.com\/events\/[a-z0-9-]+\/prizes\//gi)];
  const calculatedPrize = [...new Set(prizeLinks.map(match => match[0]))].reduce((sum, item) => sum + Number(item.match(/\$([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0), 0);
  const applyUrl = markdown.match(/\[Apply to attend\]\((https:\/\/ethglobal\.com\/events\/[^)]+\/apply)\)/i)?.[1] ?? null;
  if (!deadline.iso && !applyUrl) return null;
  const imageUrl = markdown.match(/!\[[^\]]*logo\]\((https:\/\/cdn\.ethglobal\.com\/events\/[^)]+\.(?:png|jpe?g|webp))\)/i)?.[1]
    ?? markdown.match(/!\[[^\]]*logo\]\((https:\/\/ethglobal\.storage\/events\/[^)]+)\)/i)?.[1] ?? null;
  const teamSize = markdown.match(/team\\?_size:\s*([0-9]+[–-][0-9]+)/i)?.[1] ?? null;
  const reward = prizeMatch ? `$${prizeMatch[1]} in prizes` : calculatedPrize > 0 ? `$${calculatedPrize.toLocaleString()}+ in partner prizes` : null;
  return {
    id: createHash("sha256").update(url).digest("hex").slice(0, 16), title, category: "hackathon", organizer: "ETHGlobal",
    url, sourceHost: "ethglobal.com", sourceQuality: "official", entryType: "opportunity", verification: "page-verified",
    status: "open", eligibility: teamSize ? `Teams of ${teamSize}` : null, applicationUrl: applyUrl,
    evidence: deadline.label ? `Application deadline: ${deadline.label}` : "Applications are open on the official event page; closing time is not published.", summary: `${dateLine} · ${location ?? "Location not stated"}. Official ETHGlobal hackathon.`,
    deadline: deadline.label ?? "Not announced", deadlineAt: deadline.iso, reward, location, remote: /Async Hackathon|Online/i.test(markdown), worldwide: null,
    freeToEnter: null, publishedAt: null, observedAt: today.toISOString(), score: deadline.iso ? (reward ? 96 : 90) : (reward ? 88 : 82),
    scoreReasons: ["Official event page", ...(deadline.iso ? ["Application deadline verified"] : ["Applications currently open"]), ...(reward ? ["Prize pool disclosed"] : [])],
    dataWarnings: deadline.iso ? ["Deadline time shown as published; confirm the event timezone"] : ["ETHGlobal has not published an application closing time"], imageUrl, imageAlt: `${title} logo`,
  };
}

// --- Anakin pipeline feed (data/anakin-feed.json) ---
// Produced by scripts/anakin_pipeline/pipeline.py — a separate Python tool that
// pulls Devpost, Unstop (hackathons/competitions/quizzes), Devfolio, MLH,
// DoraHacks, Kajimelo and Superteam Earn through Anakin's url-scraper API,
// normalizes them to one schema, requires every row to carry a real
// organizer/location/prize before it's exported, and merges same-event
// listings cross-posted on more than one source into a single row. See
// scripts/anakin_pipeline/README.md for the full pipeline, its known gaps,
// and how to regenerate this file.
//
// Every row here does resolve to a specific official event/listing page
// (never a search result or collection page) — same integrity bar as the
// rest of this file — but verified via each platform's own structured
// listing API/deterministic HTML parse rather than Codex's per-page
// AI-extraction-with-quoted-evidence pass. Marked "page-verified" so it's
// served by the public feed like everything else; the dataWarnings on each
// row say so explicitly rather than blur the distinction.
const anakinCategoryMap: Record<string, OpportunityCategory> = {
  hackathon: "hackathon",
  competition: "competition",
  quiz: "competition",
  "ai-video-contest": "competition",
  bounty: "bounty",
};
const anakinStatusMap: Record<string, Opportunity["status"]> = {
  open: "open", upcoming: "upcoming", ended: "closed",
};

export function normalizeAnakinFeed(raw: Array<Record<string, unknown>>, today = new Date()): Opportunity[] {
  return raw.flatMap(item => {
    const url = canonicalUrl(item.url);
    const title = nullableText(item.title, 150);
    if (!url || !title) return [];
    const parsed = new URL(url);
    const category = anakinCategoryMap[String(item.category)] ?? "competition";
    const status = anakinStatusMap[String(item.status)] ?? "unknown";
    const mode = String(item.mode ?? "unknown");
    const source = String(item.source ?? "unknown");

    const prizeValue = typeof item.prize_amount_value === "number" ? item.prize_amount_value : null;
    // The pipeline validates this, but a currency "code" that's actually a
    // whole formatted price (seen once from a source's own API glitch) would
    // otherwise double up with prizeValue below ("₹ 20,000 20,000") — guard
    // here too rather than trust it's always been sanitized upstream.
    const prizeCurrencyRaw = nullableText(item.prize_currency, 20);
    const prizeCurrency = prizeCurrencyRaw && !/\d/.test(prizeCurrencyRaw) ? prizeCurrencyRaw : null;
    const reward = prizeValue != null && prizeValue > 0
      ? `${prizeCurrency ?? ""} ${prizeValue.toLocaleString()}`.trim()
      : (prizeValue === 0 ? null : nullableText(item.prize_amount_raw, 100));

    const deadlineAt = nullableText(item.deadline_iso, 40);
    const deadline = deadlineAt
      ? new Date(deadlineAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      : nullableText(item.date_text_raw, 100) ?? nullableText(item.time_left_text, 60);

    const evidence = [
      deadline ? `Deadline: ${deadline}` : null,
      reward ? `Prize: ${reward}` : null,
      `Listed on ${source}`,
    ].filter(Boolean).join(" · ") || null;

    const dataWarnings: string[] = [
      `Verified via ${source}'s own structured listing data, not Codex's per-page AI extraction pass`,
    ];
    if (prizeValue === 0) dataWarnings.push("Prize is non-cash (swag/certificate/recognition), not withheld data");
    if (!deadline && status !== "rolling") dataWarnings.push("No deadline published by the source yet");

    const base: Omit<Opportunity, "score" | "scoreReasons"> = {
      // "anakin-" prefix (vs. the bare hash other normalizers use) lets
      // catalog.ts's fallback-on-failure logic reliably identify rows from
      // this feed, since — unlike ETHGlobal — sourceHost varies per row here.
      id: `anakin-${createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      title,
      category,
      organizer: nullableText(item.organizer, 100),
      url,
      applicationUrl: url,
      sourceHost: parsed.hostname.replace(/^www\./, ""),
      sourceQuality: quality(parsed),
      entryType: "opportunity",
      verification: "page-verified",
      status,
      eligibility: null,
      evidence,
      summary: nullableText(item.description, 360) ?? `${title} — a ${category} listed on ${source}.`,
      deadline,
      deadlineAt,
      reward,
      location: nullableText(item.location, 100),
      remote: mode === "online" ? true : mode === "in-person" ? false : null,
      worldwide: null,
      freeToEnter: item.is_paid_entry === false ? true : item.is_paid_entry === true ? false : null,
      publishedAt: null,
      observedAt: nullableText(item.fetched_at, 40) ?? today.toISOString(),
      dataWarnings,
      imageUrl: nullableText(item.thumbnail_url, 300),
      imageAlt: `${title} logo`,
    };
    return [{ ...base, ...scoreOpportunity(base, today) }];
  });
}
