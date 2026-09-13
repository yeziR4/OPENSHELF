import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AnakinClient } from "./anakin.js";
import { refreshCatalog } from "./catalog.js";

// The one piece of "backend" work OpenShelf needs: reading ETHGlobal's live
// event pages and the Anakin pipeline feed through Anakin, then writing the
// result to public/data/opportunities.json — the file the static frontend
// fetches (see public/app.js). Run this on a schedule
// (.github/workflows/refresh-and-deploy.yml), not from a live server.
const env = z.object({ ANAKIN_API_KEY: z.string().min(1), ANAKIN_COUNTRY: z.string().length(2).default("ng") }).parse(process.env);
const catalog = await refreshCatalog(new AnakinClient(env.ANAKIN_API_KEY, env.ANAKIN_COUNTRY));
console.log(`OpenShelf synced ${catalog.opportunities.length} live opportunities from ${catalog.sourcesQueried} category searches.`);
if (catalog.failures.length) console.warn(catalog.failures.join("\n"));

mkdirSync("public/data", { recursive: true });
writeFileSync("public/data/opportunities.json", JSON.stringify(catalog, null, 2));
console.log("Wrote public/data/opportunities.json for the static frontend.");
