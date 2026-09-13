import "dotenv/config";
import { z } from "zod";
import { AnakinClient } from "./anakin.js";
import { refreshCatalog } from "./catalog.js";

const env = z.object({ ANAKIN_API_KEY: z.string().min(1), ANAKIN_COUNTRY: z.string().length(2).default("ng") }).parse(process.env);
const catalog = await refreshCatalog(new AnakinClient(env.ANAKIN_API_KEY, env.ANAKIN_COUNTRY));
console.log(`OpenShelf synced ${catalog.opportunities.length} live opportunities from ${catalog.sourcesQueried} category searches.`);
if (catalog.failures.length) console.warn(catalog.failures.join("\n"));
