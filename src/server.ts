import "dotenv/config";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { AnakinClient, attachmentLinks } from "./anakin.js";
import { compileTender } from "./compiler.js";
import { generateBidPack } from "./generator.js";
import { readCatalog, refreshCatalog } from "./catalog.js";

const env = z.object({ ANAKIN_API_KEY: z.string().min(1), PORT: z.coerce.number().int().positive().default(8090), ANAKIN_COUNTRY: z.string().length(2).default("ng"), AUTO_SYNC: z.enum(["true", "false"]).default("true").transform(value => value === "true"), SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(15).default(360) }).parse(process.env);
const anakin = new AnakinClient(env.ANAKIN_API_KEY, env.ANAKIN_COUNTRY);
const publicDir = join(process.cwd(), "public");
let syncing: Promise<ReturnType<typeof readCatalog>> | null = null;
const sync = () => { if (!syncing) syncing = refreshCatalog(anakin).finally(() => { syncing = null; }); return syncing; };

async function body(request: import("node:http").IncomingMessage) {
  let raw = ""; for await (const chunk of request) raw += chunk;
  if (raw.length > 1_000_000) throw new Error("Request is too large");
  return JSON.parse(raw || "{}");
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok", service: "bidkit" });
    if (request.method === "GET" && request.url?.startsWith("/api/opportunities")) {
      const url = new URL(request.url, "http://localhost"); const category = url.searchParams.get("category"); const sort = url.searchParams.get("sort") ?? "top";
      const catalog = readCatalog();
      const qualified = catalog.opportunities.filter(item => item.verification === "page-verified" && (item.entryType === "collection" || Boolean(item.deadline) || item.status === "rolling" || (item.category === "hackathon" && Boolean(item.applicationUrl))));
      let opportunities = category && category !== "all" ? qualified.filter(item => item.category === category) : qualified;
      if (sort === "deadline") opportunities.sort((a, b) => (a.deadlineAt ?? "9999").localeCompare(b.deadlineAt ?? "9999"));
      if (sort === "new") opportunities.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      return json(response, 200, { ...catalog, opportunities });
    }
    if (request.method === "POST" && request.url === "/api/opportunities/refresh") return json(response, 200, await sync());
    if (request.method === "POST" && request.url === "/api/discover") {
      const input = z.object({ query: z.string().min(2).max(200), location: z.string().min(2).max(100) }).parse(await body(request));
      return json(response, 200, { tenders: await anakin.search(input.query, input.location) });
    }
    if (request.method === "POST" && request.url === "/api/compile") {
      const input = z.object({ url: z.string().url() }).parse(await body(request));
      const primary = await anakin.scrape(input.url);
      const attachments = attachmentLinks(primary);
      const settled = await Promise.allSettled(attachments.map(url => anakin.scrape(url)));
      const sources = [primary, ...settled.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof anakin.scrape>>> => item.status === "fulfilled").map(item => item.value)];
      const specification = compileTender(sources);
      const markdown = generateBidPack(specification);
      return json(response, 200, { specification, markdown, attachmentCount: sources.length - 1, failedAttachments: settled.filter(item => item.status === "rejected").length });
    }
    const route = request.url === "/" ? "/index.html" : request.url ?? "/index.html";
    const safe = route.split("?")[0].replace(/\.\./g, "");
    const target = join(publicDir, safe);
    if (!existsSync(target)) { response.writeHead(404); response.end("Not found"); return; }
    const data = readFileSync(target);
    const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };
    response.writeHead(200, { "content-type": `${types[extname(safe)] ?? "application/octet-stream"}; charset=utf-8` }); response.end(data);
  } catch (error) {
    console.error(error);
    json(response, error instanceof z.ZodError ? 400 : 500, { error: error instanceof Error ? error.message : "Unexpected error" });
  }
}).listen(env.PORT, "0.0.0.0", () => console.log(`BidKit listening on http://localhost:${env.PORT}`));

if (env.AUTO_SYNC) {
  const catalog = readCatalog();
  const stale = !catalog.lastSyncedAt || Date.now() - Date.parse(catalog.lastSyncedAt) > env.SYNC_INTERVAL_MINUTES * 60_000;
  if (stale) void sync().then(value => console.log(`OpenShelf refreshed ${value.opportunities.length} opportunities.`)).catch(error => console.error("OpenShelf refresh failed", error));
  setInterval(() => void sync().catch(error => console.error("Scheduled refresh failed", error)), env.SYNC_INTERVAL_MINUTES * 60_000);
}
