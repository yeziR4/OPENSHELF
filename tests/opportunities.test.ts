import { describe, expect, it } from "vitest";
import { enrichOpportunity, normalizeOpportunityResults, rankAndDedupe } from "../src/opportunities.js";

const today = new Date("2026-09-12T12:00:00Z");

describe("opportunity catalogue", () => {
  it("removes expired and broken results while preserving direct opportunities", () => {
    const results = normalizeOpportunityResults([
      { title: "PagedResult`1[TenderDto]", url: "https://example.test/tenders", content: "Deadline Sep 20, 2026" },
      { title: "Expired AI contest", url: "https://example.test/old", content: "Deadline Sep 2, 2026. Prize $1,000." },
      { title: "Global AI Build Challenge", url: "https://challenge.gov/ai-build", content: "Apply by Sep 30, 2026. $10,000 prize. Open worldwide and free to enter." },
    ], "hackathon", today);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ entryType: "opportunity", deadline: "Sep 30, 2026", reward: "$10,000", sourceQuality: "official" });
    const verified = enrichOpportunity(results[0], { status: "open", title: "Global AI Build Challenge", organizer: "Challenge.gov", deadline: "Sep 30, 2026", reward: "$10,000", eligibility: "Open worldwide", worldwide: true, freeToEnter: true, summary: "A global competition for teams building useful public-interest artificial intelligence systems.", evidence: "Applications close Sep 30, 2026.", applicationUrl: "https://challenge.gov/ai-build", remote: true, location: "Online" }, today);
    expect(verified?.score).toBeGreaterThan(80);
    expect(verified?.verification).toBe("page-verified");
  });

  it("labels collections without borrowing a child listing's deadline or value", () => {
    const [result] = normalizeOpportunityResults([{ title: "Hackathons open for registration", url: "https://example.test/hackathons", content: "Browse 50 open hackathons. Prize $80,000. Deadline Sep 20, 2026." }], "hackathon", today);
    expect(result.entryType).toBe("collection");
    expect(result.deadline).toBeNull();
    expect(result.reward).toBeNull();
    expect(result.dataWarnings).toContain("Collection page — review individual listings");
  });

  it("ranks stronger direct sources first and deduplicates URLs", () => {
    const low = normalizeOpportunityResults([{ title: "AI challenge", url: "https://unknown.test/ai", content: "Join this challenge." }], "hackathon", today);
    const high = normalizeOpportunityResults([{ title: "AI challenge", url: "https://challenge.gov/ai", content: "Deadline Sep 30, 2026. Prize $10,000. Open worldwide." }], "hackathon", today);
    const ranked = rankAndDedupe([low, high, high]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].sourceHost).toBe("challenge.gov");
  });
});
