import { opportunityOutputSchema, tenderOutputSchema } from "./schema.js";
import type { TenderCandidate, TenderSource } from "./types.js";

const terminal = new Set(["completed", "failed"]);

export class AnakinClient {
  constructor(private apiKey: string, private country = "ng", private baseUrl = "https://api.anakin.io/v1") {}

  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok && response.status !== 202) throw new Error(`Anakin ${response.status}: ${String(body.error ?? body.message ?? "request failed")}`);
    return body;
  }

  async search(query: string, location: string): Promise<TenderCandidate[]> {
    const prompt = `Find currently open public or corporate tenders specifically for ${query} in ${location}. Prioritize direct official tender notices or downloadable tender documents. Return the exact notice URL, exact title, buyer, and deadline. Exclude homepages, tender directories, news articles, expired opportunities, and results that merely describe a procurement website.`;
    const result = await this.request("/search", { method: "POST", body: JSON.stringify({ prompt }) });
    const raw = (result.results ?? result.data ?? result.sources ?? []) as Array<Record<string, unknown>>;
    return normalizeSearchResults(raw, query);
  }

  async searchWeb(prompt: string, limit = 10): Promise<Array<Record<string, unknown>>> {
    const result = await this.request("/search", { method: "POST", body: JSON.stringify({ prompt, limit }) });
    return (result.results ?? result.data ?? result.sources ?? []) as Array<Record<string, unknown>>;
  }

  async wireRun(actionId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/wire-run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action_id: actionId, params }), signal: AbortSignal.timeout(120_000) });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Wire ${response.status}: ${String(result.error ?? result.message ?? "request failed")}`);
    if (String(result.status) !== "completed") throw new Error(`Wire action ${actionId} did not complete`);
    return (result.data ?? {}) as Record<string, unknown>;
  }

  async scrapePublicPage(url: string): Promise<{ markdown: string; html: string }> {
    const response = await fetch(`${this.baseUrl}/url-scraper/scrape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`Anakin public scrape ${response.status}: ${String(result.error ?? result.message ?? "request failed")}`);
    if (String(result.status) !== "completed") throw new Error(`Anakin did not finish reading ${url}`);
    return { markdown: String(result.markdown ?? ""), html: String(result.cleanedHtml ?? result.html ?? "") };
  }

  async scrape(url: string): Promise<TenderSource> {
    const submitted = await this.request("/url-scraper/scrape", {
      method: "POST",
      body: JSON.stringify({ url, country: this.country, formats: ["markdown", "links"], generateJson: true, outputSchema: tenderOutputSchema }),
    });
    const result = terminal.has(String(submitted.status)) ? submitted : await this.poll(String(submitted.id ?? submitted.jobId));
    if (result.status === "failed") throw new Error(`Anakin could not read ${url}: ${String(result.error ?? "unknown error")}`);
    const generated = (result.generatedJson as Record<string, unknown> | undefined)?.data ?? result.generatedJson ?? {};
    return {
      url,
      title: String(result.title ?? (generated as Record<string, unknown>).title ?? new URL(url).hostname),
      markdown: String(result.markdown ?? ""),
      links: Array.isArray(result.links) ? result.links.map(String) : [],
      extracted: generated as Record<string, unknown>,
    };
  }

  async verifyOpportunity(url: string): Promise<Record<string, unknown>> {
    const submitted = await this.request("/url-scraper/scrape", {
      method: "POST",
      body: JSON.stringify({ url, country: this.country, formats: ["markdown", "links"], generateJson: true, outputSchema: opportunityOutputSchema }),
    });
    const result = terminal.has(String(submitted.status)) ? submitted : await this.poll(String(submitted.id ?? submitted.jobId));
    if (result.status === "failed") throw new Error(`Anakin could not verify ${url}`);
    const generated = (result.generatedJson as Record<string, unknown> | undefined)?.data ?? result.generatedJson ?? {};
    return { ...(generated as Record<string, unknown>), __markdown: String(result.markdown ?? ""), __title: String(result.title ?? "") };
  }

  private async poll(id: string) {
    if (!id || id === "undefined") throw new Error("Anakin returned no job ID");
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const result = await this.request(`/url-scraper/${encodeURIComponent(id)}`);
      if (terminal.has(String(result.status))) return result;
    }
    throw new Error("Anakin extraction timed out");
  }
}

const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const datePatterns = [
  new RegExp(`(?:deadline|closing(?: date)?|submission deadline)\\s*[:–-]?\\s*(${month}\\s+\\d{1,2},?\\s+20\\d{2})`, "i"),
  new RegExp(`(?:deadline|closing(?: date)?|submission deadline)\\s*[:–-]?\\s*(\\d{1,2}\\s+${month}\\s+20\\d{2})`, "i"),
  /(?:deadline|closing(?: date)?|submission deadline)\s*[:–-]?\s*(\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})/i,
];

function compact(value: unknown, limit = 260) {
  const valueText = String(value ?? "").replace(/[\r\n*]+/g, " ").replace(/\s+/g, " ").trim();
  if (valueText.length <= limit) return valueText;
  return `${valueText.slice(0, limit + 1).replace(/\s+\S*$/, "")}…`;
}

function inferredDeadline(item: Record<string, unknown>) {
  if (item.deadline) return compact(item.deadline, 80);
  const haystack = `${item.title ?? ""} ${item.snippet ?? ""}`;
  for (const pattern of datePatterns) {
    const match = haystack.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function parsedDate(value?: string) {
  if (!value) return undefined;
  const normalized = value.match(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/)
    ? value.replace(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/, "$3-$2-$1") : value;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function classifySource(url: URL, title: string, snippet: string): TenderCandidate["sourceKind"] {
  if (/\.(?:pdf|docx?|xlsx?|csv|pptx?)(?:$|[?#])/i.test(url.href)) return "document";
  const directoryTitle = /(?:all|latest|government) tenders|procurement database|tenders in /i.test(title);
  const shallowPath = url.pathname === "/" || url.pathname.split("/").filter(Boolean).length < 2;
  const manyListings = (snippet.match(/\bdeadline\b/gi) ?? []).length > 2 || snippet.length > 1_500;
  return directoryTitle || (shallowPath && manyListings) ? "directory" : "notice";
}

function buyerFrom(title: string) {
  const parts = title.split(/\s+[|–—]\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return undefined;
  const candidate = parts.at(-1)!;
  return /tenders?|rfp|bid|procurement/i.test(candidate) ? undefined : candidate;
}

export function normalizeSearchResults(raw: Array<Record<string, unknown>>, query: string, today = new Date()): TenderCandidate[] {
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const queryTokens = query.toLowerCase().split(/\W+/).filter(token => token.length > 3 && !["tender", "tenders", "services", "open"].includes(token));
  const seen = new Set<string>();
  return raw.flatMap(item => {
    const href = String(item.url ?? item.link ?? "");
    let url: URL; try { url = new URL(href); } catch { return []; }
    if (!/^https?:$/.test(url.protocol)) return [];
    const title = compact(item.title ?? item.name ?? "Untitled tender", 130);
    const fullSnippet = String(item.snippet ?? "");
    const kind = classifySource(url, title, fullSnippet);
    if (kind === "directory") return [];
    const deadline = inferredDeadline(item);
    const deadlineDate = parsedDate(deadline);
    if (deadlineDate && deadlineDate < startOfToday) return [];
    const searchable = `${title} ${fullSnippet}`.toLowerCase();
    if (queryTokens.length && !queryTokens.some(token => searchable.includes(token))) return [];
    const canonical = `${url.origin}${url.pathname}`.replace(/\/$/, "");
    if (seen.has(canonical)) return [];
    seen.add(canonical);
    return [{ title, buyer: item.buyer ? compact(item.buyer, 100) : buyerFrom(title), deadline, url: href,
      snippet: compact(fullSnippet), sourceKind: kind, freshness: deadline ? "open" as const : "deadline-unverified" as const,
      sourceHost: url.hostname.replace(/^www\./, "") }];
  }).slice(0, 8);
}

export function attachmentLinks(source: TenderSource) {
  const document = /\.(?:pdf|docx?|xlsx?|csv|pptx?)(?:$|[?#])/i;
  return [...new Set(source.links.filter(link => document.test(link) && /^https?:\/\//.test(link)))].slice(0, 8);
}
