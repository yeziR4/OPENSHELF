const $ = (selector) => document.querySelector(selector);
const feed = $("#feed"),
  progress = $("#progress"),
  filters = $("#filters");
let category = "all";
let catalog = null;
const categoryNames = {
  tender: "Tender",
  freelance: "Freelance",
  hackathon: "Hackathon",
  grant: "Grant",
  bounty: "Bounty",
  fellowship: "Fellowship",
  competition: "Competition",
};
// How often .github/workflows/refresh-and-deploy.yml re-runs the pipeline —
// keep this in sync with that file's cron schedule. Purely informational;
// nothing here actually schedules anything client-side.
const REFRESH_INTERVAL_HOURS = 6;

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
}
function formatDate(value) {
  if (!value) return "Deadline not verified";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
function relativeTime(value) {
  if (!value) return "Not synced";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.round(minutes / 60)}h ago`
        : `${Math.round(minutes / 1440)}d ago`;
}
function nextRefreshText(lastSyncedAt) {
  if (!lastSyncedAt) return "Next check pending";
  const dueAt = Date.parse(lastSyncedAt) + REFRESH_INTERVAL_HOURS * 3_600_000;
  const minutes = Math.round((dueAt - Date.now()) / 60000);
  if (minutes <= 0) return "Next check due any moment";
  return minutes < 60 ? `Next check in ${minutes}m` : `Next check in ${Math.round(minutes / 60)}h`;
}

// A deadline the source page gave us that's already in the past — the
// static Anakin feed (data/anakin-feed.json) is only rescraped when the
// pipeline is re-run, not on every 6h sync, so "status": "open" can go
// stale while the real-world deadline quietly passes. entryType
// "collection" (a feed page, not a single deadline) and status "rolling"
// have no fixed close date, so they're never treated as expired.
function isExpired(item) {
  if (item.entryType === "collection" || item.status === "rolling") return false;
  return Boolean(item.deadlineAt) && Date.parse(item.deadlineAt) < Date.now();
}

// Mirrors the filter/sort logic server.ts used to apply server-side —
// there's no server now, so this runs the same rules against the static
// public/data/opportunities.json.
function qualifiedOpportunities(items) {
  return items.filter(
    (item) =>
      item.verification === "page-verified" &&
      !isExpired(item) &&
      (item.entryType === "collection" ||
        Boolean(item.deadline) ||
        item.status === "rolling" ||
        (item.category === "hackathon" && Boolean(item.applicationUrl))),
  );
}
function sortOpportunities(items, sort) {
  const sorted = [...items];
  if (sort === "deadline") sorted.sort((a, b) => (a.deadlineAt ?? "9999").localeCompare(b.deadlineAt ?? "9999"));
  else if (sort === "new") sorted.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  // "top" needs no client-side sort: the build script already writes
  // opportunities pre-ranked by score (rankAndDedupe), highest first.
  return sorted;
}

function card(item, index) {
  const warnings =
    item.dataWarnings
      ?.map((w) => `<span class="warning">${escapeHtml(w)}</span>`)
      .join("") || "";
  const reasons =
    item.scoreReasons?.map((r) => `<span>${escapeHtml(r)}</span>`).join("") ||
    "";
  const collection = item.entryType === "collection";
  const deadline = collection
    ? "Multiple listings"
    : item.status === "rolling"
      ? "Rolling"
      : item.deadline || formatDate(item.deadlineAt);
  const media = item.imageUrl ? `<img class="opportunity-image" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.imageAlt || item.title)}" loading="lazy">` : "";
  return `<article class="opportunity-card">${media}<div class="opportunity-top"><span class="category ${item.category}">${escapeHtml(categoryNames[item.category] || item.category)}${collection ? " feed" : ""}</span><span class="rank">#${String(index + 1).padStart(2, "0")}</span></div><div class="score"><strong>${item.score}</strong><small>VERIFIED SCORE</small></div><h3>${escapeHtml(item.title)}</h3><p class="source">${escapeHtml(item.organizer || "Organizer not stated")} · <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.sourceHost)}</a>${item.verification === "page-verified" ? " · official page checked" : ""}</p><p class="summary">${escapeHtml(item.summary || "Open the source to review this opportunity.")}</p><div class="facts"><div><small>APPLICATION DEADLINE</small><strong>${escapeHtml(deadline)}</strong></div><div><small>PRIZE POOL</small><strong>${escapeHtml(collection ? "Varies" : item.reward || "Not stated")}</strong></div></div>${item.eligibility ? `<p class="eligibility"><b>Who can apply:</b> ${escapeHtml(item.eligibility)}</p>` : ""}<div class="reasons">${reasons}</div><div class="warnings">${warnings}</div><div class="actions"><a href="${escapeHtml(item.applicationUrl || item.url)}" target="_blank" rel="noopener">Apply ↗</a></div></article>`;
}

function renderFilters(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const cats = [...counts.keys()].sort();
  filters.innerHTML = [
    `<button class="filter${category === "all" ? " active" : ""}" data-category="all">All opportunities (${items.length})</button>`,
    ...cats.map(
      (cat) =>
        `<button class="filter${category === cat ? " active" : ""}" data-category="${cat}">${escapeHtml(categoryNames[cat] || cat)} (${counts.get(cat)})</button>`,
    ),
  ].join("");
  filters.querySelectorAll(".filter").forEach((button) =>
    button.addEventListener("click", () => {
      category = button.dataset.category;
      render();
    }),
  );
}

function render() {
  if (!catalog) return;
  const qualified = qualifiedOpportunities(catalog.opportunities);
  const scoped = category === "all" ? qualified : qualified.filter((item) => item.category === category);
  const opportunities = sortOpportunities(scoped, $("#sort").value);

  renderFilters(qualified);
  const categoriesShown = new Set(opportunities.map((item) => item.category));
  $("#stats").innerHTML =
    `<div><strong>${opportunities.length}</strong><span>${category === "all" ? "LIVE OPPORTUNITIES" : "IN THIS SHELF"}</span></div><div><strong>${categoriesShown.size}</strong><span>CATEGORIES SHOWN</span></div><div><strong>${relativeTime(catalog.lastSyncedAt)}</strong><span>LAST CHECKED</span></div>`;
  feed.innerHTML = opportunities.length
    ? opportunities.map(card).join("")
    : `<article class="empty"><p class="eyebrow">CATALOGUE SYNCING</p><h3>No verified opportunities are on this shelf yet.</h3><p>Try another category — OpenShelf never fills an empty shelf with invented listings.</p></article>`;
  progress.textContent =
    `${opportunities.length} RESULT${opportunities.length === 1 ? "" : "S"}` +
    (catalog.failures?.length ? ` · ${catalog.failures.length} SOURCE WARNING(S)` : "") +
    ` · ${nextRefreshText(catalog.lastSyncedAt)}`;
}

async function load() {
  progress.textContent = "LOADING CATALOGUE…";
  try {
    const response = await fetch("data/opportunities.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`catalog fetch failed (${response.status})`);
    catalog = await response.json();
    render();
  } catch (error) {
    progress.textContent = `CATALOGUE ERROR · ${error.message}`;
  }
}

$("#sort").addEventListener("change", render);
load();
