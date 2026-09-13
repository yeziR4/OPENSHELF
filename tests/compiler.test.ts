import { describe, expect, it } from "vitest";
import { compileTender } from "../src/compiler.js";
import { generateBidPack } from "../src/generator.js";
import type { TenderSource } from "../src/types.js";

describe("tender compiler", () => {
  it("deduplicates requirements and keeps citations", () => {
    const source: TenderSource = { url: "https://buyer.test/tender", title: "Tender", markdown: "", links: [], extracted: { title: "Records System", buyer: "City", deadline: "20 Sep 2026", summary: "Build a records system", requirements: [{ id: "R1", text: "Submit three project references", category: "technical", obligation: "mandatory", responseType: "narrative", evidenceNeeded: ["References"], page: "14" }, { id: "R2", text: "Submit three project references", category: "technical", obligation: "mandatory", responseType: "narrative", evidenceNeeded: [] }], requiredDocuments: [{ name: "Registration certificate", mandatory: true, page: "6" }], forms: [], ambiguities: [] } };
    const spec = compileTender([source]);
    expect(spec.requirements).toHaveLength(1);
    expect(spec.requirements[0].citation.sourceUrl).toBe(source.url);
    expect(generateBidPack(spec)).toContain("Compliance matrix");
    expect(generateBidPack(spec)).toContain("p. 14");
  });
});
