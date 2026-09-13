export type Citation = {
  sourceUrl: string;
  sourceTitle?: string;
  page?: string | null;
  section?: string | null;
  quote?: string | null;
};

export type Requirement = {
  id: string;
  text: string;
  category: "eligibility" | "technical" | "financial" | "legal" | "submission" | "other";
  obligation: "mandatory" | "scored" | "informational" | "uncertain";
  responseType: "narrative" | "document" | "form" | "table" | "declaration" | "none";
  evidenceNeeded: string[];
  citation: Citation;
};

export type TenderSource = {
  url: string;
  title: string;
  markdown: string;
  links: string[];
  extracted: Record<string, unknown>;
};

export type TenderSpecification = {
  title: string;
  buyer: string;
  reference: string | null;
  deadline: string | null;
  submissionMethod: string | null;
  currency: string | null;
  estimatedValue: string | null;
  summary: string;
  requirements: Requirement[];
  requiredDocuments: Array<{ name: string; mandatory: boolean; citation: Citation }>;
  forms: Array<{ name: string; purpose: string; citation: Citation }>;
  ambiguities: Array<{ issue: string; recommendedQuestion: string; citation: Citation }>;
  sources: Array<{ url: string; title: string }>;
  warnings: string[];
};

export type TenderCandidate = {
  title: string;
  buyer?: string;
  deadline?: string;
  url: string;
  snippet?: string;
  sourceKind: "notice" | "document" | "directory";
  freshness: "open" | "deadline-unverified";
  sourceHost: string;
};

export type OpportunityCategory = "tender" | "freelance" | "hackathon" | "grant" | "bounty" | "fellowship" | "competition";

export type Opportunity = {
  id: string;
  title: string;
  category: OpportunityCategory;
  organizer: string | null;
  url: string;
  sourceHost: string;
  sourceQuality: "official" | "established" | "unverified";
  entryType: "opportunity" | "collection";
  verification: "page-verified" | "search-only";
  status: "open" | "closed" | "upcoming" | "rolling" | "unknown";
  eligibility: string | null;
  applicationUrl: string | null;
  evidence: string | null;
  summary: string;
  deadline: string | null;
  deadlineAt: string | null;
  reward: string | null;
  location: string | null;
  remote: boolean | null;
  worldwide: boolean | null;
  freeToEnter: boolean | null;
  publishedAt: string | null;
  observedAt: string;
  score: number;
  scoreReasons: string[];
  dataWarnings: string[];
  imageUrl?: string | null;
  imageAlt?: string | null;
};

export type OpportunityCatalog = {
  opportunities: Opportunity[];
  lastSyncedAt: string | null;
  sourcesQueried: number;
  failures: string[];
};
