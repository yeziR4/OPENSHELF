const $ = (selector) => document.querySelector(selector);
const feed = $("#feed"),
  progress = $("#progress"),
  compileProgress = $("#compile-progress"),
  compileResults = $("#compile-results");
let category = "all";
const categoryNames = {
  tender: "Tender",
  freelance: "Freelance",
  hackathon: "Hackathon",
  grant: "Grant",
  bounty: "Bounty",
  fellowship: "Fellowship",
  competition: "Competition",
};
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
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
function relativeSync(value) {
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
  return `<article class="opportunity-card">${media}<div class="opportunity-top"><span class="category ${item.category}">${escapeHtml(categoryNames[item.category] || item.category)}${collection ? " feed" : ""}</span><span class="rank">#${String(index + 1).padStart(2, "0")}</span></div><div class="score"><strong>${item.score}</strong><small>VERIFIED SCORE</small></div><h3>${escapeHtml(item.title)}</h3><p class="source">${escapeHtml(item.organizer || "Organizer not stated")} · <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.sourceHost)}</a>${item.verification === "page-verified" ? " · official page checked" : ""}</p><p class="summary">${escapeHtml(item.summary || "Open the source to review this opportunity.")}</p><div class="facts"><div><small>APPLICATION DEADLINE</small><strong>${escapeHtml(deadline)}</strong></div><div><small>PRIZE POOL</small><strong>${escapeHtml(collection ? "Varies" : item.reward || "Not stated")}</strong></div></div>${item.eligibility ? `<p class="eligibility"><b>Who can apply:</b> ${escapeHtml(item.eligibility)}</p>` : ""}<div class="reasons">${reasons}</div><div class="warnings">${warnings}</div><div class="actions"><a href="${escapeHtml(item.applicationUrl || item.url)}" target="_blank" rel="noopener">Apply on ETHGlobal ↗</a></div></article>`;
}
async function load() {
  progress.textContent = "LOADING LIVE CATALOGUE…";
  try {
    const data = await api(
      `/api/opportunities?category=${encodeURIComponent(category)}&sort=${encodeURIComponent($("#sort").value)}`,
    );
    const categories = new Set(data.opportunities.map((item) => item.category));
    $("#stats").innerHTML =
      `<div><strong>${data.opportunities.length}</strong><span>${category === "all" ? "LIVE OPPORTUNITIES" : "IN THIS SHELF"}</span></div><div><strong>${categories.size}</strong><span>CATEGORIES SHOWN</span></div><div><strong>${relativeSync(data.lastSyncedAt)}</strong><span>LAST CHECKED</span></div>`;
    feed.innerHTML = data.opportunities.length
      ? data.opportunities.map(card).join("")
      : `<article class="empty"><p class="eyebrow">CATALOGUE SYNCING</p><h3>No verified opportunities are on this shelf yet.</h3><p>Refresh the live data or try another category. OpenShelf never fills an empty shelf with invented listings.</p></article>`;
    feed.querySelectorAll(".build-pack").forEach((button) =>
      button.addEventListener("click", () => {
        document.querySelector(".bidkit-panel").open = true;
        compile(button.dataset.url);
      }),
    );
    progress.textContent = `${data.opportunities.length} LIVE RESULT${data.opportunities.length === 1 ? "" : "S"}${data.failures?.length ? ` · ${data.failures.length} SOURCE WARNING(S)` : ""}`;
  } catch (error) {
    progress.textContent = `CATALOGUE ERROR · ${error.message}`;
  }
}
document.querySelectorAll(".filter").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll(".filter")
      .forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    category = button.dataset.category;
    load();
  }),
);
$("#sort").addEventListener("change", load);
$("#refresh").addEventListener("click", async () => {
  const button = $("#refresh");
  button.disabled = true;
  button.textContent = "Checking sources…";
  try {
    await api("/api/opportunities/refresh", { method: "POST" });
    await load();
  } catch (error) {
    progress.textContent = `REFRESH ERROR · ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "Refresh live data";
  }
});
$("#url-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  compile($("#url").value);
});
async function compile(url) {
  compileProgress.textContent = "READING NOTICE + ATTACHMENTS…";
  compileResults.innerHTML = "";
  try {
    const data = await api("/api/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const s = data.specification;
    const blob = new Blob([data.markdown], { type: "text/markdown" }),
      download = URL.createObjectURL(blob);
    compileResults.innerHTML = `<article class="pack"><p class="eyebrow">BID PACK COMPILED</p><h2>${escapeHtml(s.title)}</h2><p class="source">${escapeHtml(s.buyer)} · Deadline ${escapeHtml(s.deadline || "not verified")}</p><div class="pack-grid"><div class="metric"><strong>${s.requirements.length}</strong><span>REQUIREMENTS</span></div><div class="metric"><strong>${s.requiredDocuments.length}</strong><span>DOCUMENTS</span></div><div class="metric"><strong>${s.forms.length}</strong><span>FORMS</span></div><div class="metric"><strong>${data.attachmentCount}</strong><span>ATTACHMENTS READ</span></div></div><a class="download" href="${download}" download="bidkit-response-pack.md">Download response workspace ↓</a></article>`;
    compileProgress.textContent = "SOURCE-LINKED WORKSPACE READY";
  } catch (error) {
    compileProgress.textContent = `COMPILER ERROR · ${error.message}`;
  }
}
load();
