export const tenderOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    buyer: { type: "string" },
    reference: { type: ["string", "null"] },
    deadline: { type: ["string", "null"], description: "Exact deadline text; never infer" },
    submissionMethod: { type: ["string", "null"] },
    currency: { type: ["string", "null"] },
    estimatedValue: { type: ["string", "null"] },
    summary: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, text: { type: "string" },
          category: { enum: ["eligibility", "technical", "financial", "legal", "submission", "other"] },
          obligation: { enum: ["mandatory", "scored", "informational", "uncertain"] },
          responseType: { enum: ["narrative", "document", "form", "table", "declaration", "none"] },
          evidenceNeeded: { type: "array", items: { type: "string" } },
          page: { type: ["string", "null"] }, section: { type: ["string", "null"] }, quote: { type: ["string", "null"] }
        },
        required: ["id", "text", "category", "obligation", "responseType", "evidenceNeeded"]
      }
    },
    requiredDocuments: { type: "array", items: { type: "object", properties: { name: { type: "string" }, mandatory: { type: "boolean" }, page: { type: ["string", "null"] }, section: { type: ["string", "null"] }, quote: { type: ["string", "null"] } }, required: ["name", "mandatory"] } },
    forms: { type: "array", items: { type: "object", properties: { name: { type: "string" }, purpose: { type: "string" }, page: { type: ["string", "null"] }, section: { type: ["string", "null"] }, quote: { type: ["string", "null"] } }, required: ["name", "purpose"] } },
    ambiguities: { type: "array", items: { type: "object", properties: { issue: { type: "string" }, recommendedQuestion: { type: "string" }, page: { type: ["string", "null"] }, section: { type: ["string", "null"] }, quote: { type: ["string", "null"] } }, required: ["issue", "recommendedQuestion"] } }
  },
  required: ["title", "buyer", "summary", "requirements", "requiredDocuments", "forms", "ambiguities"]
} as const;

export const opportunityOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: ["string", "null"], description: "Exact opportunity title on this page" },
    organizer: { type: ["string", "null"], description: "Organization offering the opportunity" },
    opportunityType: { type: ["string", "null"] },
    status: { enum: ["open", "closed", "upcoming", "rolling", "unknown"] },
    deadline: { type: ["string", "null"], description: "Exact deadline including year and timezone when present. Never infer." },
    reward: { type: ["string", "null"], description: "Exact prize, grant, contract value, salary or budget text. Never infer." },
    eligibility: { type: ["string", "null"], description: "Concise eligibility statement taken from the page" },
    location: { type: ["string", "null"] },
    remote: { type: ["boolean", "null"] },
    worldwide: { type: ["boolean", "null"] },
    freeToEnter: { type: ["boolean", "null"] },
    applicationUrl: { type: ["string", "null"] },
    summary: { type: ["string", "null"], description: "A factual two-sentence summary" },
    evidence: { type: ["string", "null"], description: "Short excerpt containing deadline or open-status evidence" }
  },
  required: ["title", "organizer", "opportunityType", "status", "deadline", "reward", "eligibility", "location", "remote", "worldwide", "freeToEnter", "applicationUrl", "summary", "evidence"]
} as const;
