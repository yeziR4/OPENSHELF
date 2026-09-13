import { describe, expect, it } from "vitest";
import { normalizeSearchResults } from "../src/anakin.js";

const today = new Date("2026-09-12T12:00:00Z");

describe("live search normalization", () => {
  it("removes directory blobs and expired notices", () => {
    const raw = [
      { title: "Tender.NG | All Tenders", url: "https://tender.ng/", snippet: `Latest Tenders ${"Deadline: 20 Sep 2026 ".repeat(8)}` },
      { title: "IT equipment tender", url: "https://buyer.gov.ng/notices/it-equipment", snippet: "Submission Deadline: 10 Sep 2026. Supply network equipment." },
      { title: "Network infrastructure RFP | Ministry of Digital Services", url: "https://buyer.gov.ng/notices/network", snippet: "Submission Deadline: Sep 20, 2026. Network infrastructure upgrade." },
    ];
    const results = normalizeSearchResults(raw, "network infrastructure", today);
    expect(results).toHaveLength(1);
    expect(results[0].deadline).toBe("Sep 20, 2026");
    expect(results[0].buyer).toBe("Ministry of Digital Services");
  });

  it("bounds untrusted search snippets", () => {
    const results = normalizeSearchResults([{ title: "Open software RFP", url: "https://buyer.test/tender/42", snippet: `Software platform ${"details ".repeat(100)}` }], "software", today);
    expect(results[0].snippet!.length).toBeLessThanOrEqual(261);
    expect(results[0].freshness).toBe("deadline-unverified");
  });
});
