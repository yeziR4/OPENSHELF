#!/usr/bin/env python3
"""
Opportunity discovery pipeline — built on the Anakin API.

Pulls REAL, currently-live hackathons, competitions, quizzes, AI video
contests, and bounties from seven sources (Devpost, Unstop, Devfolio,
MLH, DoraHacks, Kajimelo, Superteam Earn) and normalizes them into one
common schema suitable for seeding a "find an opportunity" website.
Unstop alone contributes three different `category` values
(hackathon/competition/quiz) off the same endpoint — see
`UNSTOP_OPPORTUNITY_TYPES`.

Every fetch — for all seven sources — goes through Anakin's url-scraper
API (`POST /v1/url-scraper/scrape`), not direct HTTPS requests:
- Devpost, Unstop: their listing pages are themselves a JSON API — Anakin
  fetches the URL and the response body comes back verbatim in `html`.
- Devfolio: its listing page embeds the full dataset server-rendered
  (`__NEXT_DATA__`); each individual event then gets 2 more Anakin calls
  (browser mode) to fill in organizer/location/prize/description.
- Kajimelo: plain server-rendered HTML with semantic classes — the
  cheapest source here, no browser mode or AI extraction needed at all.
- MLH, DoraHacks: client-rendered SPAs with a fixed per-listing template,
  parsed deterministically from Anakin's rendered `markdown`.
- Superteam Earn: client-rendered with no fixed template at all — the one
  source that has no choice but to trust Anakin's `generateJson` AI
  extraction.

Every row is required to have a real organizer, location, and prize
amount (`--require-complete`, on by default); cross-source duplicates
are merged into one row, not shown twice (`merge_cross_source_duplicates`);
and every row gets a best-effort absolute `deadline_iso` computed from
whatever each source actually gives us (`compute_deadline_iso`) so
"closing soon" is comparable across sources despite each one expressing
it differently (an ISO timestamp, a relative "X days left" string, or a
plain-text absolute date).

Requires ANAKIN_API_KEY (read from the environment only — never hardcoded
or logged here).

Usage:
    ANAKIN_API_KEY=your_key python3 pipeline.py --out ./out
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, asdict, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

REQUEST_DELAY_SECONDS = 0.6  # be a polite citizen of the Anakin API
ANAKIN_TIMEOUT_SECONDS = 120  # a browser-mode render can take a while
MAX_RETRIES = 3

ANAKIN_API_KEY = os.environ.get("ANAKIN_API_KEY")  # never hardcode this — env var only
ANAKIN_BASE_URL = "https://api.anakin.io/v1"


def anakin_scrape(
    url: str, *, use_browser: bool = False, generate_json: bool = False, country: str = "us"
) -> dict[str, Any]:
    """Fetch `url` through Anakin's url-scraper API (POST /v1/url-scraper/scrape)
    and return the full job result. Every source in this pipeline goes
    through this one function — there is no direct-HTTPS fallback.

    `generate_json=True` turns on Anakin's AI extraction (`generatedJson` in
    the result) — used for pages with no clean embedded data at all, so an
    LLM reads the rendered page and pulls out structured fields itself."""
    if not ANAKIN_API_KEY:
        raise RuntimeError(
            "ANAKIN_API_KEY is not set. This pipeline fetches every source "
            "through Anakin — export ANAKIN_API_KEY before running it."
        )
    body = json.dumps(
        {"url": url, "country": country, "useBrowser": use_browser, "generateJson": generate_json}
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{ANAKIN_BASE_URL}/url-scraper/scrape",
        data=body,
        method="POST",
        headers={"X-API-Key": ANAKIN_API_KEY, "Content-Type": "application/json"},
    )
    last_err: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=ANAKIN_TIMEOUT_SECONDS) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            if result.get("status") != "completed":
                raise RuntimeError(f"Anakin scrape not completed ({result.get('status')}): {url}")
            return result
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError) as e:
            last_err = e
            time.sleep(attempt * 1.5)
    raise RuntimeError(f"Anakin scrape failed after {MAX_RETRIES} attempts for {url}: {last_err}")


def anakin_scrape_json(url: str, **kwargs: Any) -> Any:
    """For a source URL that IS a JSON API — Anakin still fetches it (through
    its proxy/anti-block infra), and the raw response body comes back
    verbatim in `html`; parse that as JSON rather than re-extracting it."""
    result = anakin_scrape(url, **kwargs)
    return json.loads(result["html"])


# --------------------------------------------------------------------------
# Common schema
# --------------------------------------------------------------------------

@dataclass
class Opportunity:
    source: str                 # "devpost" | "unstop"
    source_id: str
    title: str
    url: str
    organizer: Optional[str]
    status: str                  # "open" | "upcoming" | "ended" | "unknown"
    mode: str                    # "online" | "in-person" | "hybrid" | "unknown"
    location: Optional[str]
    country: Optional[str]
    date_text_raw: Optional[str]
    time_left_text: Optional[str]
    prize_amount_raw: Optional[str]
    prize_currency: Optional[str]
    prize_amount_value: Optional[float]
    registration_deadline: Optional[str] = None
    themes: list[str] = field(default_factory=list)
    participants_count: Optional[int] = None
    is_paid_entry: Optional[bool] = None
    invite_only: Optional[bool] = None
    featured: bool = False
    thumbnail_url: Optional[str] = None
    fetched_at: str = ""
    possible_duplicate: bool = False  # kept for backward compat; true iff merged_from is non-empty
    description: Optional[str] = None
    merged_from: list[str] = field(default_factory=list)  # other sources folded into this row
    category: str = "hackathon"  # "hackathon" | "competition" | "quiz" | "bounty" | "ai-video-contest"
    deadline_iso: Optional[str] = None  # best-effort submission/registration deadline, computed — see compute_deadline_iso


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Devpost
# --------------------------------------------------------------------------

DEVPOST_API = "https://devpost.com/api/hackathons"

_CURRENCY_SPAN_RE = re.compile(r"<[^>]+>")


def _clean_devpost_prize(raw: str) -> tuple[Optional[str], Optional[float]]:
    """'$<span data-currency-value>4,000</span>' -> ('USD', 4000.0)."""
    if not raw:
        return None, None
    text = html.unescape(_CURRENCY_SPAN_RE.sub("", raw)).strip()
    m = re.match(r"([A-Za-z\$€£]*)\s*([\d,]+(?:\.\d+)?)", text)
    if not m:
        return text or None, None
    currency_symbol, number = m.group(1).strip(), m.group(2).replace(",", "")
    currency = {"$": "USD", "€": "EUR", "£": "GBP"}.get(currency_symbol, currency_symbol or None)
    try:
        value = float(number)
    except ValueError:
        value = None
    return currency, value


def fetch_devpost_raw(status: list[str], max_pages: int) -> list[dict[str, Any]]:
    """Page through Devpost's public hackathon-listing JSON API, via Anakin."""
    status_qs = "&".join(f"status[]={s}" for s in status)
    all_rows: list[dict[str, Any]] = []
    page = 1
    while page <= max_pages:
        url = f"{DEVPOST_API}?{status_qs}&order_by=recently-added&page={page}"
        data = anakin_scrape_json(url)
        rows = data.get("hackathons", [])
        if not rows:
            break
        all_rows.extend(rows)
        total = data.get("meta", {}).get("total_count", 0)
        per_page = data.get("meta", {}).get("per_page", len(rows) or 1)
        if page * per_page >= total:
            break
        page += 1
        time.sleep(REQUEST_DELAY_SECONDS)
    return all_rows


def normalize_devpost(row: dict[str, Any]) -> Opportunity:
    currency, value = _clean_devpost_prize(row.get("prize_amount", ""))
    loc = (row.get("displayed_location") or {}).get("location")
    mode = "online" if loc and "online" in loc.lower() else ("in-person" if loc else "unknown")
    return Opportunity(
        source="devpost",
        source_id=str(row.get("id")),
        title=row.get("title", "").strip(),
        url=row.get("url", ""),
        organizer=row.get("organization_name") or None,
        status=row.get("open_state", "unknown"),
        mode=mode,
        location=loc,
        country=None,
        date_text_raw=row.get("submission_period_dates"),
        time_left_text=row.get("time_left_to_submission"),
        prize_amount_raw=html.unescape(_CURRENCY_SPAN_RE.sub("", row.get("prize_amount", "") or "")).strip() or None,
        prize_currency=currency,
        prize_amount_value=value,
        themes=[t.get("name") for t in row.get("themes", []) if t.get("name")],
        participants_count=row.get("registrations_count"),
        is_paid_entry=None,
        invite_only=row.get("invite_only"),
        featured=bool(row.get("featured", False)),
        thumbnail_url=row.get("thumbnail_url"),
        fetched_at=_now_iso(),
    )


# --------------------------------------------------------------------------
# Unstop
# --------------------------------------------------------------------------

UNSTOP_API = "https://unstop.com/api/public/opportunity/search-result"
_UNSTOP_STATUS_MAP = {"LIVE": "open", "UPCOMING": "upcoming", "EXPIRED": "ended"}

# Unstop hosts far more than hackathons behind the same endpoint — just a
# different `opportunity=` value. Each maps to our broader `category` field.
# (checked but skipped: olympiads/fellowships had 0 open listings; scholarships
# had only 4 — too little volume to bother with.)
UNSTOP_OPPORTUNITY_TYPES = {
    "hackathons": "hackathon",
    "competitions": "competition",
    "quizzes": "quiz",
}


def fetch_unstop_raw(
    opportunity_type: str, oppstatus: str, max_pages: int, per_page: int = 100
) -> list[dict[str, Any]]:
    """Page through one of Unstop's public opportunity-listing JSON APIs,
    via Anakin. `opportunity_type` is Unstop's own `opportunity=` query
    value (e.g. "hackathons", "competitions", "quizzes")."""
    all_rows: list[dict[str, Any]] = []
    page = 1
    while page <= max_pages:
        url = (
            f"{UNSTOP_API}?opportunity={opportunity_type}&per_page={per_page}"
            f"&oppstatus={oppstatus}&page={page}"
        )
        data = anakin_scrape_json(url)
        payload = data.get("data", {})
        rows = payload.get("data", [])
        if not rows:
            break
        all_rows.extend(rows)
        last_page = payload.get("last_page", page)
        if page >= last_page:
            break
        page += 1
        time.sleep(REQUEST_DELAY_SECONDS)
    return all_rows


def normalize_unstop(row: dict[str, Any], category: str) -> Opportunity:
    prizes = row.get("prizes") or []
    cash_total = sum(p.get("cash") or 0 for p in prizes)
    currency = None
    if prizes:
        code = prizes[0].get("currency")
        currency = {"fa-rupee": "INR", "fa-dollar": "USD"}.get(code, code)
    addr = row.get("address_with_country_logo") or {}
    country = (addr.get("country") or {}).get("name")
    city = addr.get("city")
    location = ", ".join([p for p in [city, country] if p]) or None
    mode = {"online": "online", "offline": "in-person"}.get(row.get("region"), "unknown")
    themes = [wf.get("name") for wf in (row.get("workfunction") or []) if wf.get("name")]
    regn = row.get("regnRequirements") or {}
    end_date = row.get("end_date")
    reg_deadline = regn.get("end_regn_dt")
    date_text = f"Ends {end_date[:10]}" if end_date else None
    time_left = regn.get("remain_days")
    return Opportunity(
        source="unstop",
        source_id=str(row.get("id")),
        title=row.get("title", "").strip(),
        url=row.get("seo_url") or row.get("short_url") or "",
        organizer=(row.get("organisation") or {}).get("name"),
        status=_UNSTOP_STATUS_MAP.get(row.get("status"), "unknown"),
        mode=mode,
        location=location,
        country=country,
        date_text_raw=date_text,
        time_left_text=time_left,
        prize_amount_raw=(f"{cash_total:,}" if cash_total else None),
        prize_currency=currency,
        prize_amount_value=float(cash_total) if cash_total else None,
        registration_deadline=reg_deadline,
        themes=themes,
        participants_count=row.get("registerCount"),
        is_paid_entry=bool(row.get("isPaid")),
        invite_only=None,
        featured=False,
        thumbnail_url=row.get("logoUrl2") or row.get("thumb"),
        fetched_at=_now_iso(),
        category=category,
    )


# --------------------------------------------------------------------------
# Devfolio
# --------------------------------------------------------------------------

DEVFOLIO_HACKATHONS_PAGE = "https://devfolio.co/hackathons"
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S
)


def fetch_devfolio_raw() -> dict[str, list[dict[str, Any]]]:
    """Devfolio server-renders its full listing into a Next.js data blob —
    Anakin's plain (non-browser) fetch already gets the full page, so no
    headless render is needed to read it."""
    result = anakin_scrape(DEVFOLIO_HACKATHONS_PAGE)
    page_html = result["html"]
    m = _NEXT_DATA_RE.search(page_html)
    if not m:
        raise RuntimeError("Devfolio page shape changed: __NEXT_DATA__ not found")
    next_data = json.loads(m.group(1))
    data = next_data["props"]["pageProps"]["dehydratedState"]["queries"][0]["state"]["data"]
    return {
        "open": data.get("open_hackathons", []),
        "upcoming": data.get("upcoming_hackathons", []),
    }


def normalize_devfolio(row: dict[str, Any], bucket_status: str) -> Opportunity:
    settings = row.get("settings") or {}
    slug = row.get("slug")
    starts_at, ends_at = row.get("starts_at"), row.get("ends_at")
    date_text = None
    if starts_at and ends_at:
        date_text = f"{starts_at[:10]} → {ends_at[:10]}"
    themes = [
        (t.get("theme") or {}).get("name")
        for t in (row.get("themes") or [])
        if (t.get("theme") or {}).get("name")
    ]
    return Opportunity(
        source="devfolio",
        source_id=row.get("uuid") or slug,
        title=row.get("name", "").strip(),
        url=settings.get("site") or (f"https://{slug}.devfolio.co/" if slug else ""),
        organizer=None,  # not present in this listing payload
        status=bucket_status,
        mode="in-person" if row.get("is_online") is False else ("online" if row.get("is_online") else "unknown"),
        location=None,  # not present in this listing payload
        country=None,
        date_text_raw=date_text,
        time_left_text=None,
        prize_amount_raw=None,  # prize info isn't in this listing payload
        prize_currency=None,
        prize_amount_value=None,
        registration_deadline=settings.get("reg_ends_at"),
        themes=themes,
        participants_count=row.get("participants_count"),
        is_paid_entry=None,
        invite_only=None,
        featured=False,
        thumbnail_url=settings.get("featured_cover_img_v2") or settings.get("featured_cover_img"),
        fetched_at=_now_iso(),
    )


_ORGANIZED_BY_RES = [
    re.compile(rf"{verb} (?:the )?\*\*(.+?)\*\*", re.I)
    for verb in ("organized by", "organised by", "hosted by", "presented by", "brought to you by")
]
_ORGANIZER_LINK_RE = re.compile(r"^(.+?)\sOrganizer$")
_HAPPENING_RE = re.compile(r"Happening\n\n([^\n]+)")
_PRIZE_POOL_RE = re.compile(r"Prize Pool\s*\n+\$?([\d,]+(?:\.\d+)?)")


def enrich_devfolio_event(opp: Opportunity, slug: str) -> None:
    """Devfolio's listing payload has no organizer/prize/location/description.
    Two more Anakin calls per event fill all four in:
    - The event's own page: Anakin's AI extraction (`generateJson`) reliably
      pulls a clean description; the plain rendered `markdown` (returned in
      the same call) has organizer/location in a fixed template ("organized
      by the **X**", "Happening\\n\\nCity, Country") — deterministic text,
      not another AI re-generation, so it's parsed with plain regex instead
      of trusting the AI-JSON shape twice (that shape is not stable call to
      call — see Known gaps).
    - The event's `/prizes` subpage: its "Prize Pool" total is rendered as
      plain visible text ("Prize Pool\\n\\n$4,588"), also parsed from
      `markdown` rather than AI-JSON for the same reason.
    """
    base = f"https://{slug}.devfolio.co"
    result = anakin_scrape(base, use_browser=True, generate_json=True)
    md = result.get("markdown") or ""
    gj_data = (result.get("generatedJson") or {}).get("data") or {}
    opp.description = gj_data.get("description") or opp.description

    for pattern in _ORGANIZED_BY_RES:
        m = pattern.search(md)
        if m:
            opp.organizer = m.group(1).strip()
            break
    else:
        # fall back to the AI-extracted link list — same call, no extra cost —
        # since some events render "<Org Name> Organizer" as a link instead of
        # naming the organizer in the description prose
        for link in gj_data.get("links") or []:
            m = _ORGANIZER_LINK_RE.match((link.get("text") or "").strip())
            if m:
                opp.organizer = m.group(1).strip()
                break

    m = _HAPPENING_RE.search(md)
    if m:
        opp.location = m.group(1).strip()

    try:
        prizes_result = anakin_scrape(f"{base}/prizes", use_browser=True)
        m = _PRIZE_POOL_RE.search(prizes_result.get("markdown") or "")
        if m:
            opp.prize_amount_raw = m.group(1)
            opp.prize_currency = "USD"  # Devfolio prize pools are shown in $ regardless of org's home currency
            opp.prize_amount_value = float(m.group(1).replace(",", ""))
    except Exception:
        pass  # not every hackathon has published a prizes page yet


# --------------------------------------------------------------------------
# Kajimelo (AI film festival directory — plain server-rendered HTML with
# semantic classes; no browser mode or AI extraction needed at all, the
# cheapest and cleanest source in this pipeline)
# --------------------------------------------------------------------------

KAJIMELO_URL = "https://www.kajimelo.com/ai-film-festivals"
_KAJIMELO_CARD_RE = re.compile(r'<article class="fi-card">(.*?)</article>', re.S)
_KAJIMELO_STATUS_RE = re.compile(r'<span class="fi-status[^"]*">([^<]+)</span>')
_KAJIMELO_NAME_RE = re.compile(r'<h3 class="fi-name">([^<]+)</h3>')
_KAJIMELO_TIER_RE = re.compile(r'<span class="fi-tier">([^<]+)</span>')
_KAJIMELO_PLACE_RE = re.compile(r'<div class="fi-place">.*?<span>([^<]+)</span></div>')
_KAJIMELO_ROW_RE = re.compile(r'<dt>([^<]+)</dt><dd>(.*?)</dd>', re.S)
_KAJIMELO_FOCUS_RE = re.compile(r'<p class="fi-focus">(.*?)</p>', re.S)
_KAJIMELO_LINK_RE = re.compile(r'<a class="fi-link" href="([^"]+)"')
_KAJIMELO_TAG_RE = re.compile(r"<[^>]+>")
_KAJIMELO_MONEY_RE = re.compile(r"\$([\d,]+(?:\.\d+)?)\s*([kKmM])?")
def _kajimelo_map_status(raw: str) -> str:
    """Status text is free-form and sometimes compound (e.g. "Open · TBA",
    "Rolling Call") rather than one of a fixed set of labels, so this
    matches by substring/keyword rather than exact value."""
    s = raw.lower()
    if "closed" in s:
        return "ended"
    if "open" in s or "closing soon" in s or "closes today" in s or "rolling" in s:
        return "open"
    if "tba" in s:
        return "upcoming"
    return "unknown"


def fetch_kajimelo_raw() -> str:
    """Kajimelo's festival directory is plain, complete, server-rendered
    HTML (confirmed: page shows 'Showing 19 of 19 entries', no pagination
    to chase) — Anakin's cheapest plain-fetch mode is enough."""
    result = anakin_scrape(KAJIMELO_URL)
    return result.get("html") or ""


def _kajimelo_max_dollar_amount(text: str) -> Optional[float]:
    """A 'Prize' cell is prose, not a single number — pick the largest $
    figure mentioned as the headline pool (e.g. the $1,000,000 total fund,
    not one of its $50k sub-category prizes)."""
    best: Optional[float] = None
    for num, suffix in _KAJIMELO_MONEY_RE.findall(text):
        value = float(num.replace(",", ""))
        if suffix.lower() == "k":
            value *= 1_000
        elif suffix.lower() == "m":
            value *= 1_000_000
        if best is None or value > best:
            best = value
    return best


def parse_kajimelo_html(page_html: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for card in _KAJIMELO_CARD_RE.findall(page_html):
        name_m = _KAJIMELO_NAME_RE.search(card)
        link_m = _KAJIMELO_LINK_RE.search(card)
        if not name_m or not link_m:
            continue
        status_m = _KAJIMELO_STATUS_RE.search(card)
        status_raw = (status_m.group(1).strip().lower() if status_m else "")
        place_m = _KAJIMELO_PLACE_RE.search(card)
        tier_m = _KAJIMELO_TIER_RE.search(card)
        focus_m = _KAJIMELO_FOCUS_RE.search(card)

        cells = {k.strip(): v for k, v in _KAJIMELO_ROW_RE.findall(card)}
        deadline_raw = html.unescape(_KAJIMELO_TAG_RE.sub("", cells.get("Deadline", ""))).strip()
        prize_raw = html.unescape(_KAJIMELO_TAG_RE.sub("", cells.get("Prize", ""))).strip()
        entry_raw = html.unescape(_KAJIMELO_TAG_RE.sub("", cells.get("Entry", ""))).strip()

        rows.append(
            {
                "name": html.unescape(name_m.group(1)).strip(),
                "url": link_m.group(1),
                "status": _kajimelo_map_status(status_raw),
                "place": html.unescape(place_m.group(1)).strip() if place_m else None,
                "tier": html.unescape(tier_m.group(1)).strip() if tier_m else None,
                "deadline_raw": deadline_raw or None,
                "prize_raw": prize_raw or None,
                "prize_value": _kajimelo_max_dollar_amount(prize_raw),
                "entry_raw": entry_raw or None,
                "description": html.unescape(_KAJIMELO_TAG_RE.sub("", focus_m.group(1))).strip() if focus_m else None,
            }
        )
    return rows


def normalize_kajimelo(row: dict[str, Any]) -> Opportunity:
    place = row["place"] or ""
    mode = "online" if "online" in place.lower() else ("in-person" if place else "unknown")
    return Opportunity(
        source="kajimelo",
        source_id=row["url"],
        title=row["name"],
        url=row["url"],
        # Film festivals are typically their own brand/entity rather than being
        # run "by" a separately-named organizer — the festival name IS the
        # organizer for this source, unlike a hackathon hosted by a named club.
        organizer=row["name"],
        status=row["status"],
        mode=mode,
        location=None if mode == "online" else (place or None),
        country=None,
        date_text_raw=row["deadline_raw"],
        time_left_text=None,
        prize_amount_raw=row["prize_raw"],
        prize_currency=("USD" if row["prize_value"] is not None else None),
        prize_amount_value=row["prize_value"],
        themes=[t for t in [row["tier"]] if t],
        participants_count=None,
        is_paid_entry=(bool(row["entry_raw"] and "paid" in row["entry_raw"].lower()) if row["entry_raw"] else None),
        invite_only=None,
        featured=False,
        thumbnail_url=None,
        fetched_at=_now_iso(),
        description=row["description"],
        category="ai-video-contest",
    )


# --------------------------------------------------------------------------
# DoraHacks (client-rendered SPA, but its listing markdown is deterministic —
# no AI extraction needed, same as MLH; organizer/location/prize all present)
# --------------------------------------------------------------------------

DORAHACKS_URL = "https://dorahacks.io/hackathon"
_DORAHACKS_BLOCK_RE = re.compile(r"- \[(.*?)\]\((https://dorahacks\.io/hackathon/[^)]+)\)", re.S)
_DORAHACKS_LINE_SPLIT_RE = re.compile(r"\\\s*\n\s*\\\s*\n?")
_DORAHACKS_STATUS_RE = re.compile(r"^([A-Za-z][A-Za-z \-🏅]*?)(\d+\+?\s*(?:days?|hours?|minutes?)\s*left)?$")
_DORAHACKS_PRIZE_RE = re.compile(r"Prize Pool\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]+)")
_DORAHACKS_STATUS_MAP = {
    "ongoing": "open", "extended": "open",
    "upcoming": "upcoming", "pre-registration": "upcoming",
    "ended": "ended", "winner announced": "ended",
}


def fetch_dorahacks_raw() -> str:
    """DoraHacks' hackathon-list page is client-rendered with no embedded
    data, but — unlike Superteam Earn — its rendered markdown follows a
    fixed per-card template, so this is parsed deterministically rather
    than trusting AI-JSON extraction. One page load surfaces ~20-25 of its
    ~800+ listed hackathons (the rest are behind a client-side "load more"
    Anakin's plain render doesn't trigger) — see Known gaps."""
    result = anakin_scrape(DORAHACKS_URL, use_browser=True)
    return result.get("markdown") or ""


def parse_dorahacks_markdown(markdown: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for m in _DORAHACKS_BLOCK_RE.finditer(markdown):
        content, url = m.group(1), m.group(2)
        lines = [l.strip() for l in _DORAHACKS_LINE_SPLIT_RE.split(content) if l.strip()]
        if len(lines) < 4:
            continue
        organizer = lines[0]
        status_m = _DORAHACKS_STATUS_RE.match(lines[1])
        status_raw = (status_m.group(1).strip() if status_m else lines[1]).lower()
        time_left = status_m.group(2) if status_m and status_m.group(2) else None

        idx = 2
        participants = None
        if idx < len(lines) and lines[idx].isdigit():
            participants = int(lines[idx])
            idx += 1
        if idx >= len(lines):
            continue
        title = lines[idx]
        idx += 1
        if idx >= len(lines):
            continue
        location = lines[idx]
        idx += 1

        prize_value = prize_currency = None
        last = lines[-1] if lines else ""
        if last.startswith("🏆"):
            pm = _DORAHACKS_PRIZE_RE.search(last)
            if pm:
                prize_value = float(pm.group(1).replace(",", ""))
                prize_currency = pm.group(2)
            tags = lines[idx:-1]
        elif last.startswith("🔒"):
            tags = lines[idx:-1]
        else:
            tags = lines[idx:]

        rows.append(
            {
                "organizer": organizer,
                "status": _DORAHACKS_STATUS_MAP.get(status_raw, "unknown"),
                "time_left": time_left,
                "participants": participants,
                "title": title,
                "location": location,
                "tags": tags,
                "prize_value": prize_value,
                "prize_currency": prize_currency,
                "url": url,
            }
        )
    return rows


def normalize_dorahacks(row: dict[str, Any]) -> Opportunity:
    location = row["location"]
    mode = "online" if location.lower() == "virtual" else "in-person"
    return Opportunity(
        source="dorahacks",
        source_id=row["url"],
        title=row["title"],
        url=row["url"],
        organizer=row["organizer"],
        status=row["status"],
        mode=mode,
        location=None if mode == "online" else location,
        country=None,
        date_text_raw=None,
        time_left_text=row["time_left"],
        prize_amount_raw=(f"{row['prize_value']:,.0f}" if row["prize_value"] is not None else None),
        prize_currency=row["prize_currency"],
        prize_amount_value=row["prize_value"],
        themes=row["tags"],
        participants_count=row["participants"],
        is_paid_entry=None,
        invite_only=None,
        featured=False,
        thumbnail_url=None,
        fetched_at=_now_iso(),
    )


# --------------------------------------------------------------------------
# Superteam Earn (bounties/projects — via Anakin browser + AI extraction,
# the one source here with no embedded data and no listing endpoint at all)
# --------------------------------------------------------------------------

SUPERTEAM_TABS = ["bounties", "projects"]


def fetch_superteam_raw(tab: str, attempts: int = 3) -> list[dict[str, Any]]:
    """Superteam Earn's listings render entirely client-side with no
    server-embedded data and no discoverable JSON endpoint — Anakin's AI
    extraction (`generateJson`) is the only practical way to get structured
    rows out of it. That extraction is non-deterministic (it occasionally
    comes back with zero rows on an otherwise-normal page), so retry a
    couple of times before accepting an empty result."""
    for attempt in range(1, attempts + 1):
        result = anakin_scrape(
            f"https://superteam.fun/earn/all?tab={tab}", use_browser=True, generate_json=True
        )
        jobs = ((result.get("generatedJson") or {}).get("data") or {}).get("jobs") or []
        if jobs:
            return jobs
        if attempt < attempts:
            time.sleep(2)
    return []


_MONEY_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*([A-Za-z]+)?")


def normalize_superteam(row: dict[str, Any], tab: str) -> Opportunity:
    salary = (row.get("salary") or "").strip()
    m = _MONEY_RE.search(salary)
    amount = float(m.group(1).replace(",", "")) if m else None
    currency = m.group(2) if m and m.group(2) else None
    return Opportunity(
        source="superteam",
        source_id=row.get("url") or row.get("title", ""),
        title=row.get("title", "").strip(),
        url=row.get("url") or "",
        organizer=row.get("company") or None,
        status="open",  # this source only ever lists currently-live listings
        mode="online",  # Superteam Earn listings are all remote/online submissions
        location=row.get("location") or None,
        country=None,
        date_text_raw=None,
        time_left_text=row.get("postedDate"),  # e.g. "Due in 7d" — a deadline countdown
        prize_amount_raw=salary or None,
        prize_currency=currency,
        prize_amount_value=amount,
        themes=[row["jobType"]] if row.get("jobType") else [],
        participants_count=None,
        is_paid_entry=False,
        invite_only=None,
        featured=False,
        thumbnail_url=None,
        fetched_at=_now_iso(),
        description=row.get("description") or None,
        category="bounty",
    )


# --------------------------------------------------------------------------
# MLH (client-rendered SPA — needs Anakin's browser mode, like Superteam above)
# --------------------------------------------------------------------------

_MLH_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    )
}
_MLH_EVENT_RE = re.compile(
    r"\*\*(?P<name>[^*]+)\*\*\\\s*\\\s*"
    r"(?P<month>[A-Z]{3}) (?P<day1>\d{1,2})(?:\s*-\s*(?P<day2>\d{1,2}))?\\\s*\\\s*"
    r"(?P<location>[^\\\]]+?)\\\s*\\\s*"
    r"(?P<mode>In-Person|Digital|Hybrid)[A-Z ]*\]\((?P<url>[^)]+)\)"
)
_MLH_YEAR_HEADER_RE = re.compile(r"### (\d{4})")


def mlh_season_url(year: int) -> str:
    return f"https://mlh.io/seasons/{year}/events"


def fetch_mlh_raw(year: int) -> str:
    """Scrape MLH's events page via Anakin's headless-browser mode — it's a
    client-rendered SPA with no server-embedded data, unlike the plain
    (non-browser) Anakin fetches used for Devpost/Unstop/Devfolio above."""
    result = anakin_scrape(mlh_season_url(year), use_browser=True)
    return result.get("markdown") or ""


def parse_mlh_markdown(markdown: str, today: datetime) -> list[dict[str, Any]]:
    """MLH's 'Upcoming Events' section renders each event as a fixed
    name/date/location/mode block; this pulls just that section (past
    events use the identical block shape and would otherwise match too)."""
    if "## Upcoming Events" not in markdown:
        return []
    section = markdown.split("## Upcoming Events", 1)[1]
    if "## Past Events" in section:
        section = section.split("## Past Events", 1)[0]

    rows: list[dict[str, Any]] = []
    year = today.year
    # Walk the section left-to-right, tracking the most recent "### YYYY"
    # year header so each event gets the right calendar year.
    markers = sorted(
        [(m.start(), "year", int(m.group(1))) for m in _MLH_YEAR_HEADER_RE.finditer(section)]
        + [(m.start(), "event", m) for m in _MLH_EVENT_RE.finditer(section)]
    )
    for _, kind, payload in markers:
        if kind == "year":
            year = payload
            continue
        m = payload
        month = _MLH_MONTHS.get(m.group("month"))
        if not month:
            continue
        day1 = int(m.group("day1"))
        day2 = int(m.group("day2")) if m.group("day2") else day1
        try:
            start = datetime(year, month, day1)
            end = datetime(year, month, day2)
        except ValueError:
            continue
        if start <= today <= end:
            status = "open"
        elif start > today:
            status = "upcoming"
        else:
            status = "ended"
        rows.append(
            {
                "name": m.group("name").strip(),
                "start": start,
                "end": end,
                "location": m.group("location").strip(),
                "mode": m.group("mode"),
                "url": m.group("url"),
                "status": status,
            }
        )
    return rows


def normalize_mlh(row: dict[str, Any]) -> Opportunity:
    mode = {"In-Person": "in-person", "Digital": "online", "Hybrid": "hybrid"}.get(
        row["mode"], "unknown"
    )
    date_text = (
        f"{row['start'].strftime('%b %d')} - {row['end'].strftime('%b %d, %Y')}"
        if row["start"] != row["end"]
        else row["start"].strftime("%b %d, %Y")
    )
    return Opportunity(
        source="mlh",
        source_id=row["url"],
        title=row["name"],
        url=row["url"],
        organizer=None,
        status=row["status"],
        mode=mode,
        location=row["location"] if row["location"].lower() != "everywhere, worldwide" else None,
        country=None,
        date_text_raw=date_text,
        time_left_text=None,
        prize_amount_raw=None,  # not shown on the events index; per-event page only
        prize_currency=None,
        prize_amount_value=None,
        themes=[],
        participants_count=None,
        is_paid_entry=None,
        invite_only=None,
        featured=False,
        thumbnail_url=None,
        fetched_at=_now_iso(),
    )


# --------------------------------------------------------------------------
# Pipeline
# --------------------------------------------------------------------------

def run(max_devpost_pages: int, max_unstop_pages: int, mlh_year: Optional[int]) -> list[Opportunity]:
    if not ANAKIN_API_KEY:
        raise SystemExit(
            "ANAKIN_API_KEY is not set. Every source in this pipeline is fetched through "
            "Anakin's url-scraper API — export ANAKIN_API_KEY and re-run."
        )

    print("Fetching Devpost (open + upcoming) via Anakin ...", file=sys.stderr)
    devpost_raw = fetch_devpost_raw(status=["open", "upcoming"], max_pages=max_devpost_pages)
    print(f"  -> {len(devpost_raw)} rows", file=sys.stderr)

    unstop_by_category: dict[str, list[dict[str, Any]]] = {}
    for opp_type, category in UNSTOP_OPPORTUNITY_TYPES.items():
        print(f"Fetching Unstop {opp_type} (open) via Anakin ...", file=sys.stderr)
        rows = fetch_unstop_raw(opp_type, oppstatus="open", max_pages=max_unstop_pages)
        print(f"  -> {len(rows)} rows", file=sys.stderr)
        unstop_by_category[category] = rows
        time.sleep(REQUEST_DELAY_SECONDS)

    print("Fetching Devfolio (open + upcoming) via Anakin ...", file=sys.stderr)
    devfolio_raw = fetch_devfolio_raw()
    print(f"  -> {len(devfolio_raw['open'])} open, {len(devfolio_raw['upcoming'])} upcoming", file=sys.stderr)

    year = mlh_year or (datetime.now(timezone.utc).year + 1)
    print(f"Fetching MLH (season {year}) via Anakin, browser mode ...", file=sys.stderr)
    mlh_markdown = fetch_mlh_raw(year)
    mlh_rows = parse_mlh_markdown(mlh_markdown, datetime.now(timezone.utc).replace(tzinfo=None))
    print(f"  -> {len(mlh_rows)} rows", file=sys.stderr)

    print("Fetching DoraHacks via Anakin, browser mode ...", file=sys.stderr)
    dorahacks_markdown = fetch_dorahacks_raw()
    dorahacks_rows = [
        r for r in parse_dorahacks_markdown(dorahacks_markdown) if r["status"] in ("open", "upcoming")
    ]
    print(f"  -> {len(dorahacks_rows)} rows (ended/unknown-status ones filtered out)", file=sys.stderr)

    print("Fetching Kajimelo (AI film festivals) via Anakin, plain fetch ...", file=sys.stderr)
    kajimelo_rows = [
        r for r in parse_kajimelo_html(fetch_kajimelo_raw()) if r["status"] in ("open", "upcoming")
    ]
    print(f"  -> {len(kajimelo_rows)} rows (closed/unknown-status ones filtered out)", file=sys.stderr)

    superteam_rows: list[Opportunity] = []
    for tab in SUPERTEAM_TABS:
        print(f"Fetching Superteam Earn ({tab}) via Anakin, browser + AI extraction ...", file=sys.stderr)
        jobs = fetch_superteam_raw(tab)
        print(f"  -> {len(jobs)} rows", file=sys.stderr)
        superteam_rows += [normalize_superteam(j, tab) for j in jobs]
        time.sleep(REQUEST_DELAY_SECONDS)

    opportunities = [normalize_devpost(r) for r in devpost_raw]
    for category, rows in unstop_by_category.items():
        opportunities += [normalize_unstop(r, category) for r in rows]

    devfolio_pairs = [(r, "open") for r in devfolio_raw["open"]]
    devfolio_pairs += [(r, "upcoming") for r in devfolio_raw["upcoming"]]
    devfolio_opps = [normalize_devfolio(r, status) for r, status in devfolio_pairs]
    print(f"Enriching {len(devfolio_opps)} Devfolio events via Anakin (2 calls each: page + prizes) ...", file=sys.stderr)
    for (raw_row, _status), opp in zip(devfolio_pairs, devfolio_opps):
        slug = raw_row.get("slug")
        if not slug:
            continue
        try:
            enrich_devfolio_event(opp, slug)
        except Exception as e:
            print(f"  -> enrichment failed for {opp.title!r}, leaving as-is: {e}", file=sys.stderr)
        time.sleep(REQUEST_DELAY_SECONDS)
    opportunities += devfolio_opps

    opportunities += [normalize_mlh(r) for r in mlh_rows]
    opportunities += [normalize_dorahacks(r) for r in dorahacks_rows]
    opportunities += [normalize_kajimelo(r) for r in kajimelo_rows]
    opportunities += superteam_rows

    # de-dupe on (source, source_id)
    seen: set[tuple[str, str]] = set()
    deduped: list[Opportunity] = []
    for o in opportunities:
        key = (o.source, o.source_id)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(o)

    merged = merge_cross_source_duplicates(deduped)
    for o in merged:
        o.deadline_iso = compute_deadline_iso(o)
    return merged


# Preferred source when picking which record represents a cross-posted event —
# earlier sources tend to carry richer/more authoritative fields for hackathons.
_SOURCE_PRIORITY = {
    "devpost": 0, "unstop": 1, "dorahacks": 2, "mlh": 3, "devfolio": 4,
    "kajimelo": 5, "superteam": 6,
}

# Content fields eligible to be backfilled onto the kept record from a
# duplicate that's about to be dropped. Identity/provenance fields
# (source, source_id, url, fetched_at, possible_duplicate, merged_from) are
# deliberately excluded — those describe the record itself, not the event.
_BACKFILLABLE_FIELDS = [
    "organizer", "location", "country", "date_text_raw", "time_left_text",
    "registration_deadline", "prize_amount_raw", "prize_currency",
    "prize_amount_value", "participants_count", "is_paid_entry",
    "invite_only", "thumbnail_url", "description",
]


def merge_cross_source_duplicates(items: list[Opportunity]) -> list[Opportunity]:
    """Collapse same-event listings cross-posted on more than one source
    (e.g. a school hackathon on both Devpost and MLH) into ONE row, instead
    of showing the same contest twice. The record from the higher-priority
    source is kept; any field it's missing gets backfilled from the
    duplicate(s) being dropped, `themes` are unioned, and `merged_from`
    records which sources were folded in — so nothing is silently lost,
    it's just not shown as two separate listings for the same contest.
    """
    _norm = lambda t: re.sub(r"[^a-z0-9]+", "", t.lower())
    by_title: dict[str, list[Opportunity]] = {}
    for o in items:
        by_title.setdefault(_norm(o.title), []).append(o)

    result: list[Opportunity] = []
    for group in by_title.values():
        if len({o.source for o in group}) == 1:
            result.extend(group)
            continue

        group_sorted = sorted(group, key=lambda o: _SOURCE_PRIORITY.get(o.source, 99))
        keeper, dupes = group_sorted[0], group_sorted[1:]

        for field_name in _BACKFILLABLE_FIELDS:
            if getattr(keeper, field_name) in (None, ""):
                for d in dupes:
                    val = getattr(d, field_name)
                    if val not in (None, ""):
                        setattr(keeper, field_name, val)
                        break
        if keeper.mode == "unknown":
            for d in dupes:
                if d.mode != "unknown":
                    keeper.mode = d.mode
                    break

        all_themes = list(keeper.themes)
        for d in dupes:
            for t in d.themes:
                if t not in all_themes:
                    all_themes.append(t)
        keeper.themes = all_themes

        keeper.merged_from = [d.source for d in dupes]
        keeper.possible_duplicate = True
        result.append(keeper)

    return result


# --------------------------------------------------------------------------
# Deadline normalization — "how soon is this closing", made comparable
# --------------------------------------------------------------------------

_DUE_IN_RE = re.compile(r"due in\s*(\d+)\s*([dhm])", re.I)
_RELATIVE_LEFT_RE = re.compile(r"(\d+)\+?\s*(month|day|hour|minute)s?\s*left", re.I)
_MONTH_NUM = {
    m: i + 1
    for i, m in enumerate(
        [
            "january", "february", "march", "april", "may", "june", "july",
            "august", "september", "october", "november", "december",
        ]
    )
}
_ABSOLUTE_DATE_RE = re.compile(r"^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})")


def compute_deadline_iso(o: Opportunity) -> Optional[str]:
    """Best-effort absolute deadline, in priority order:

    1. `registration_deadline` — already a real ISO timestamp (Unstop,
       Devfolio). Used as-is.
    2. `time_left_text` — a RELATIVE duration ("29 days left", "Due in 7d")
       that was true at `fetched_at`, not at whatever moment this function
       runs — so it's anchored to `fetched_at` + the parsed duration, not
       to "now". That anchor is what makes storing an absolute ISO
       timestamp worthwhile: a viewer's browser can compute "days left as
       of right now" from it correctly days after the fetch, without
       needing a fresh scrape just to keep a countdown honest.
    3. `date_text_raw` for Kajimelo specifically — its "Deadline" cell is
       an absolute date ("7 September 2026"), sometimes with an extended-
       deadline note concatenated after it with no separator; only the
       leading date is parsed. Kajimelo's "Year-round"/rolling entries
       have no fixed deadline and correctly get `None` here.

    Returns None (not a guess) when nothing reliable is available, rather
    than fabricate a date.
    """
    if o.registration_deadline:
        try:
            dt = datetime.fromisoformat(o.registration_deadline.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            pass

    try:
        anchor = datetime.strptime(o.fetched_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        anchor = datetime.now(timezone.utc)

    if o.time_left_text:
        m = _DUE_IN_RE.search(o.time_left_text)
        if m:
            n, unit = int(m.group(1)), m.group(2).lower()
            delta_hours = n * {"d": 24, "h": 1, "m": 1 / 60}[unit]
            return (anchor + timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
        m = _RELATIVE_LEFT_RE.search(o.time_left_text)
        if m:
            n, unit = int(m.group(1)), m.group(2).lower()
            delta_hours = n * {"month": 24 * 30, "day": 24, "hour": 1, "minute": 1 / 60}[unit]
            return (anchor + timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    if o.source == "kajimelo" and o.date_text_raw:
        m = _ABSOLUTE_DATE_RE.match(o.date_text_raw.strip())
        if m:
            day, month_name, year = m.groups()
            month = _MONTH_NUM.get(month_name.lower())
            if month:
                try:
                    dt = datetime(int(year), month, int(day), 23, 59, tzinfo=timezone.utc)
                    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                except ValueError:
                    pass

    return None


def drop_incomplete(items: list[Opportunity]) -> list[Opportunity]:
    """Keep only rows with a real organizer, location, and prize amount —
    the three fields users kept seeing blank in the UI. An online event's
    location is backfilled to "Online" first (that's its actual location,
    not a gap); Devpost's legitimate `$0` non-cash prizes count as answered,
    not missing. Everything else that's still blank after every enrichment
    pass so far gets dropped rather than shown half-empty.

    This is real data loss, not a formatting fix: MLH's listing page never
    exposes organizer/prize at all (would need one more Anakin call per
    event to fix, ~78 more calls), so this removes essentially all MLH rows;
    Superteam Earn never exposes location so it depends entirely on the
    online-location backfill to survive this filter.
    """
    for o in items:
        if o.location is None and o.mode == "online":
            o.location = "Online"
    return [
        o for o in items
        if o.organizer and o.location and o.prize_amount_value is not None
    ]


def write_outputs(items: list[Opportunity], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = [asdict(o) for o in items]

    json_path = out_dir / "hackathons.json"
    json_path.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")

    csv_path = out_dir / "hackathons.csv"
    if rows:
        fieldnames = list(rows[0].keys())
        with csv_path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in rows:
                r = dict(r)
                r["themes"] = "; ".join(r.get("themes") or [])
                writer.writerow(r)

    print(f"Wrote {len(rows)} records to {json_path} and {csv_path}", file=sys.stderr)


def print_summary(items: list[Opportunity]) -> None:
    by_source: dict[str, int] = {}
    by_category: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_mode: dict[str, int] = {}
    with_cash_prize = 0
    merged_count = 0
    merged_sources = 0
    for o in items:
        by_source[o.source] = by_source.get(o.source, 0) + 1
        by_category[o.category] = by_category.get(o.category, 0) + 1
        by_status[o.status] = by_status.get(o.status, 0) + 1
        by_mode[o.mode] = by_mode.get(o.mode, 0) + 1
        if o.prize_amount_value:
            with_cash_prize += 1
        if o.merged_from:
            merged_count += 1
            merged_sources += len(o.merged_from)
    print("\n=== Summary ===")
    print(f"Total unique opportunities (post-merge): {len(items)}")
    print(f"By source (of the kept/canonical row): {by_source}")
    print(f"By category: {by_category}")
    print(f"By status: {by_status}")
    print(f"By mode:   {by_mode}")
    print(f"With a stated cash prize: {with_cash_prize}")
    print(
        f"Cross-source duplicates merged: {merged_count} listings absorbed "
        f"{merged_sources} duplicate posting(s) from other sources"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("./out"))
    parser.add_argument("--max-devpost-pages", type=int, default=30)
    parser.add_argument("--max-unstop-pages", type=int, default=5)
    parser.add_argument(
        "--mlh-year", type=int, default=None,
        help="MLH season year to scrape via Anakin (default: next calendar year, which MLH's "
             "site uses to list events starting now). Ignored if ANAKIN_API_KEY isn't set.",
    )
    parser.add_argument(
        "--require-complete", action=argparse.BooleanOptionalAction, default=True,
        help="Drop any row missing organizer, location, or prize amount (default: on). "
             "Pass --no-require-complete to keep every row, nulls and all.",
    )
    args = parser.parse_args()

    items = run(args.max_devpost_pages, args.max_unstop_pages, args.mlh_year)
    if args.require_complete:
        before = len(items)
        items = drop_incomplete(items)
        print(
            f"\n--require-complete: dropped {before - len(items)} of {before} rows "
            f"missing organizer/location/prize ({len(items)} remain)",
            file=sys.stderr,
        )
    write_outputs(items, args.out)
    print_summary(items)


if __name__ == "__main__":
    main()
