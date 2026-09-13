import { createHash } from "node:crypto";
import type { Citation, Requirement, TenderSource, TenderSpecification } from "./types.js";

const citation = (source: TenderSource, raw: Record<string, unknown>): Citation => ({
  sourceUrl: source.url,
  sourceTitle: source.title,
  page: raw.page ? String(raw.page) : null,
  section: raw.section ? String(raw.section) : null,
  quote: raw.quote ? String(raw.quote).slice(0, 240) : null,
});

const normalize = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const idFor = (text: string) => `REQ-${createHash("sha1").update(normalize(text)).digest("hex").slice(0, 8).toUpperCase()}`;

export function compileTender(sources: TenderSource[]): TenderSpecification {
  if (!sources.length) throw new Error("At least one tender source is required");
  const primary = sources[0].extracted as Record<string, unknown>;
  const requirements = new Map<string, Requirement>();
  const documents = new Map<string, TenderSpecification["requiredDocuments"][number]>();
  const forms = new Map<string, TenderSpecification["forms"][number]>();
  const ambiguities: TenderSpecification["ambiguities"] = [];

  for (const source of sources) {
    const extracted = source.extracted as Record<string, unknown>;
    for (const raw of Array.isArray(extracted.requirements) ? extracted.requirements as Record<string, unknown>[] : []) {
      const text = String(raw.text ?? "").trim();
      if (!text) continue;
      const key = normalize(text);
      if (!requirements.has(key)) requirements.set(key, {
        id: String(raw.id ?? idFor(text)), text,
        category: (raw.category as Requirement["category"]) ?? "other",
        obligation: (raw.obligation as Requirement["obligation"]) ?? "uncertain",
        responseType: (raw.responseType as Requirement["responseType"]) ?? "none",
        evidenceNeeded: Array.isArray(raw.evidenceNeeded) ? raw.evidenceNeeded.map(String) : [],
        citation: citation(source, raw),
      });
    }
    for (const raw of Array.isArray(extracted.requiredDocuments) ? extracted.requiredDocuments as Record<string, unknown>[] : []) {
      const name = String(raw.name ?? "").trim(); if (!name) continue;
      documents.set(normalize(name), { name, mandatory: raw.mandatory !== false, citation: citation(source, raw) });
    }
    for (const raw of Array.isArray(extracted.forms) ? extracted.forms as Record<string, unknown>[] : []) {
      const name = String(raw.name ?? "").trim(); if (!name) continue;
      forms.set(normalize(name), { name, purpose: String(raw.purpose ?? "Required tender form"), citation: citation(source, raw) });
    }
    for (const raw of Array.isArray(extracted.ambiguities) ? extracted.ambiguities as Record<string, unknown>[] : []) {
      if (raw.issue) ambiguities.push({ issue: String(raw.issue), recommendedQuestion: String(raw.recommendedQuestion ?? "Request clarification from the buyer."), citation: citation(source, raw) });
    }
  }

  const required = [...requirements.values()];
  return {
    title: String(primary.title ?? sources[0].title), buyer: String(primary.buyer ?? "Buyer not identified"),
    reference: primary.reference ? String(primary.reference) : null,
    deadline: primary.deadline ? String(primary.deadline) : null,
    submissionMethod: primary.submissionMethod ? String(primary.submissionMethod) : null,
    currency: primary.currency ? String(primary.currency) : null,
    estimatedValue: primary.estimatedValue ? String(primary.estimatedValue) : null,
    summary: String(primary.summary ?? "Tender summary unavailable."), requirements: required,
    requiredDocuments: [...documents.values()], forms: [...forms.values()], ambiguities,
    sources: sources.map(source => ({ url: source.url, title: source.title })),
    warnings: [
      ...(!primary.deadline ? ["No deadline was verified in the extracted sources."] : []),
      ...(!required.length ? ["No requirements were extracted; review the original package manually."] : []),
      ...required.filter(item => item.obligation === "uncertain").map(item => `${item.id} has uncertain obligation strength.`),
    ],
  };
}
