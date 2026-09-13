import { describe, expect, it } from "vitest";
import { normalizeAnakinFeed } from "../src/opportunities.js";

const today = new Date("2026-09-13T15:00:00Z");

describe("normalizeAnakinFeed", () => {
  it("maps a pipeline row into OpenShelf's Opportunity shape, page-verified with an honest data warning", () => {
    const [result] = normalizeAnakinFeed(
      [
        {
          source: "devpost",
          category: "hackathon",
          title: "HackWesTX VII",
          url: "https://hackwestx-vii.devpost.com/",
          organizer: "independant",
          status: "open",
          mode: "in-person",
          location: "TTU Innovation Hub at Research Hub",
          prize_amount_raw: "1,000",
          prize_currency: "USD",
          prize_amount_value: 1000,
          date_text_raw: "Sep 12 - 13, 2026",
          time_left_text: "19 hours left",
          deadline_iso: "2026-09-13T15:19:27Z",
          is_paid_entry: null,
          thumbnail_url: "https://example.test/logo.jpg",
          fetched_at: "2026-09-13T14:39:27Z",
        },
      ],
      today,
    );

    expect(result.category).toBe("hackathon");
    expect(result.organizer).toBe("independant");
    expect(result.reward).toBe("USD 1,000");
    expect(result.location).toBe("TTU Innovation Hub at Research Hub");
    expect(result.remote).toBe(false);
    expect(result.verification).toBe("page-verified");
    expect(result.sourceHost).toBe("hackwestx-vii.devpost.com");
    expect(result.applicationUrl).toBe(result.url);
    expect(result.dataWarnings[0]).toMatch(/devpost's own structured listing data/);
  });

  it("maps quiz/competition/ai-video-contest categories onto OpenShelf's existing 'competition' category", () => {
    const rows = [
      { category: "quiz", title: "Quiz A", url: "https://example.test/a", organizer: "Org", status: "open", mode: "online", location: "Online", prize_amount_value: 500, prize_currency: "INR", fetched_at: today.toISOString() },
      { category: "ai-video-contest", title: "Festival B", url: "https://example.test/b", organizer: "Org", status: "open", mode: "online", location: "Online", prize_amount_value: 1000000, prize_currency: "USD", fetched_at: today.toISOString() },
    ];
    const results = normalizeAnakinFeed(rows, today);
    expect(results.map(r => r.category)).toEqual(["competition", "competition"]);
  });

  it("does not claim a cash reward for a genuinely non-cash ($0) prize, and says so", () => {
    const [result] = normalizeAnakinFeed(
      [{ category: "hackathon", title: "Swag Only Hack", url: "https://example.test/swag", organizer: "Org", status: "open", mode: "online", location: "Online", prize_amount_value: 0, prize_currency: "USD", fetched_at: today.toISOString() }],
      today,
    );
    expect(result.reward).toBeNull();
    expect(result.dataWarnings).toContain("Prize is non-cash (swag/certificate/recognition), not withheld data");
  });

  it("drops a row with a placeholder title instead of publishing garbage", () => {
    const results = normalizeAnakinFeed(
      [{ category: "hackathon", title: "N/A", url: "https://example.test/bad", organizer: "NA", status: "upcoming", mode: "online", location: "Online", prize_amount_value: 2, prize_currency: "USD", fetched_at: today.toISOString() }],
      today,
    );
    expect(results).toHaveLength(0);
  });
});
