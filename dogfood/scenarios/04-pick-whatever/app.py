#!/usr/bin/env python3
"""RateCraft — AI pricing copilot for indie creators.

Zero-dependency backend (Python standard library only).

Two modes:
  1. AI-powered:  set OPENAI_API_KEY (or RATECRAFT_API_KEY) and optionally
                  RATECRAFT_BASE_URL / RATECRAFT_MODEL to use any
                  OpenAI-compatible chat-completions endpoint.
  2. Built-in:    no key configured -> a deterministic market-signal estimator
                  produces the same report schema, so the app always works.

Run:  python app.py   (serves http://127.0.0.1:8000)
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
PORT = int(os.environ.get("PORT", "8000"))

API_KEY = os.environ.get("OPENAI_API_KEY") or os.environ.get("RATECRAFT_API_KEY")
API_BASE = os.environ.get("RATECRAFT_BASE_URL", "https://api.openai.com/v1").rstrip("/")
API_MODEL = os.environ.get("RATECRAFT_MODEL", "gpt-4o-mini")

# ---------------------------------------------------------------------------
# Market reference data (hourly USD bands by creator category)
# ---------------------------------------------------------------------------

CATEGORIES = {
    "design": {
        "label": "Design",
        "keywords": ["logo", "brand", "identity", "ui/ux", "ui design", "user interface",
                     "figma", "illustrat", "poster", "book cover", "packaging", "print",
                     "web design"],
        "bands": [(25, 45), (45, 80), (80, 150)],
        "blurb": "Design work is priced by strategic value, not hours: anchor on the business outcome of the asset, and offer bundled packages so scope is fixed.",
    },
    "writing": {
        "label": "Writing & Content",
        "keywords": ["write", "writing", "article", "blog", "copy", "copywriting",
                     "ghostwrit", "email", "newsletter", "whitepaper", "seo content",
                     "script", "case study", "ad copy", "landing page copy"],
        "bands": [(30, 60), (60, 100), (100, 200)],
        "blurb": "Content prices scale with expertise and research depth: charge per project with a revision allowance, and price niche expertise at a premium.",
    },
    "development": {
        "label": "Development",
        "keywords": ["developer", "develop", "code", "coding", "app", "website build",
                     "web app", "mvp", "api", "integration", "automation", "script",
                     "frontend", "backend", "full-stack", "wordpress", "shopify"],
        "bands": [(30, 60), (60, 110), (110, 200)],
        "blurb": "Development is valued by reliability and speed: quote fixed-price for well-scoped builds, and keep maintenance/retainer as a separate line item.",
    },
    "video": {
        "label": "Video & Motion",
        "keywords": ["video", "edit", "editing", "motion", "animation", "youtube",
                     "reel", "tiktok", "short", "after effects", "premiere", "color grade"],
        "bands": [(25, 50), (50, 90), (90, 180)],
        "blurb": "Video work is turnaround-sensitive: charge rush fees for fast delivery, and price by final runtime plus revision rounds, never by raw footage.",
    },
    "marketing": {
        "label": "Marketing & Growth",
        "keywords": ["marketing", "growth", "seo", "ads", "advertising", "funnel",
                     "social media strategy", "campaign", "brand strategy", "email marketing",
                     "content strategy", "crm"],
        "bands": [(25, 50), (50, 90), (90, 170)],
        "blurb": "Marketing is priced on results and channel expertise: anchor to the revenue you can move, and offer monthly retainers for recurring execution.",
    },
    "consulting": {
        "label": "Consulting & Coaching",
        "keywords": ["consult", "coach", "advice", "strategy session", "advisory",
                     "mentor", "audit", "workshop", "training", "speaking"],
        "bands": [(40, 80), (80, 150), (150, 300)],
        "blurb": "Consulting prices by the value of the decision you inform: sell outcomes (audit + roadmap), not hours, and raise rates with proof of impact.",
    },
    "photography": {
        "label": "Photography",
        "keywords": ["photo", "photograph", "shoot", "portrait", "product photo",
                     "wedding", "event photo", "headshot", "lifestyle"],
        "bands": [(25, 60), (60, 120), (120, 250)],
        "blurb": "Photography prices combine shooting time, editing, and usage rights: always quote licensing separately and charge travel/gear as line items.",
    },
    "audio": {
        "label": "Music & Audio",
        "keywords": ["music", "mixing", "mastering", "beat", "podcast", "voiceover",
                     "sound design", "production", "song", "audio"],
        "bands": [(20, 45), (45, 80), (80, 150)],
        "blurb": "Audio work is priced per deliverable and usage: separate creation from licensing, and charge extra for broadcast or commercial use rights.",
    },
    "social": {
        "label": "Social Media",
        "keywords": ["social media", "instagram", "linkedin", "twitter", "content calendar",
                     "community", "moderation", "posts", "thumbnails", "short-form"],
        "bands": [(20, 40), (40, 70), (70, 130)],
        "blurb": "Social work is volume pricing: bundle a monthly content package with a clear cap, and charge for strategy and reporting on top of production.",
    },
}
DEFAULT_CATEGORY = "general"
DEFAULT_BANDS = (20, 40), (40, 70), (70, 140)
GENERAL_BLURB = ("Anchor your price to the outcome you deliver and the client's budget class: "
                 "quote a range, never a single number, and raise it as your proof grows.")

SENIORITY_KEYWORDS = {
    "junior": 0, "entry": 0, "beginner": 0, "new to": 0, "starting out": 0,
    "mid": 1, "intermediate": 1,
    "senior": 2, "expert": 2, "experienced": 2, "10+ years": 2, "seasoned": 2,
    "specialist": 2, "professional": 1, "freelance": 1, "full-time": 1,
}

CLIENT_TYPES = {
    "enterprise": ("enterprise", "fortune", "corporate", "big company"),
    "agency": ("agency", "studio", "firm"),
    "startup": ("startup", "saas", "tech company", "founder", "vc-backed"),
    "small business": ("small business", "local", "boutique", "sme", "shop", "restaurant", "salon"),
    "individual": ("individual", "personal", "solo", "creator", "influencer"),
}
CLIENT_MULTIPLIERS = {"enterprise": 1.3, "agency": 1.1, "startup": 1.0,
                      "small business": 0.9, "individual": 0.8}

HIGH_COST_MARKETS = ("us", "usa", "united states", "canada", "australia", "uk", "united kingdom",
                     "switzerland", "norway", "denmark", "sweden", "singapore", "new zealand",
                     "uae", "netherlands", "germany", "ireland")
MID_COST_MARKETS = ("france", "italy", "spain", "portugal", "belgium", "austria", "japan",
                    "south korea", "israel", "poland", "czech")
LOW_COST_MARKETS = ("india", "philippines", "vietnam", "indonesia", "thailand", "pakistan",
                    "brazil", "mexico", "colombia", "argentina", "turkey", "egypt", "nigeria",
                    "kenya", "ukraine", "romania", "serbia")

DELIVERABLE_HOURS = [
    (("logo",), 14), (("brand identity", "branding", "brand guide", "brand identities"), 45),
    (("website", "web design", "site"), 55), (("landing page",), 20),
    (("app", "mvp", "software", "platform"), 120), (("shopify", "e-commerce", "ecommerce"), 40),
    (("article", "blog post"), 6), (("case study", "whitepaper"), 12),
    (("email", "newsletter"), 6), (("ad copy", "ad creative"), 12),
    (("video edit", "editing", "video"), 15), (("thumbnail",), 4),
    (("social media", "content calendar", "posts"), 12),
    (("pitch deck", "presentation"), 15), (("book cover",), 10),
    (("illustrat",), 14), (("photo shoot", "photography"), 10),
    (("mixing", "mastering", "music production", "tracks", "beats"), 20), (("voiceover",), 4),
    (("consult", "coaching", "session"), 3), (("audit",), 12), (("workshop", "training"), 8),
]

CURRENCIES = {
    "USD": 1.0, "EUR": 0.92, "GBP": 0.79, "CAD": 1.37, "AUD": 1.52,
    "INR": 84.0, "BRL": 5.4, "JPY": 150.0, "NZD": 1.65,
}
CURRENCY_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "CAD": "C$", "AUD": "A$",
                    "INR": "₹", "BRL": "R$", "JPY": "¥", "NZD": "NZ$"}

YEARS_RE = re.compile(r"(\d+)\s*(?:\+|\-)?\s*(?:years?|yrs?)", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Heuristic estimator
# ---------------------------------------------------------------------------

def detect_category(text):
    text = text.lower()
    best, best_score = DEFAULT_CATEGORY, 0
    for cat, data in CATEGORIES.items():
        score = sum(1 for kw in data["keywords"] if kw in text)
        if score > best_score:
            best, best_score = cat, score
    return best


def detect_experience(text, explicit):
    """Return 0 (junior), 1 (mid), or 2 (senior)."""
    if explicit in ("junior", "mid", "senior"):
        return {"junior": 0, "mid": 1, "senior": 2}[explicit]
    m = YEARS_RE.search(text)
    if m:
        years = int(m.group(1))
        if years <= 2:
            return 0
        if years <= 6:
            return 1
        return 2
    text_l = text.lower()
    for kw, level in SENIORITY_KEYWORDS.items():
        if kw in text_l:
            return level
    return 1  # sensible default for active creators


def detect_client_type(text):
    text_l = text.lower()
    for ctype, keywords in CLIENT_TYPES.items():
        if any(kw in text_l for kw in keywords):
            return ctype
    return None


def detect_region(text):
    """Return a multiplier for the client market implied by the text."""
    text_l = text.lower()
    if any(m in text_l for m in HIGH_COST_MARKETS):
        return 1.0
    if any(m in text_l for m in MID_COST_MARKETS):
        return 0.8
    if any(m in text_l for m in LOW_COST_MARKETS):
        return 0.55
    return 1.0


def detect_deliverable(text, explicit=""):
    text_l = text.lower()
    explicit = str(explicit).strip().lower()
    if explicit and explicit not in ("", "let ratecraft detect it"):
        # Find a matching deliverable entry so we get a realistic hour anchor.
        for keywords, hours in DELIVERABLE_HOURS:
            if any(kw in explicit for kw in keywords):
                return explicit, hours
        return explicit, 15
    for keywords, hours in DELIVERABLE_HOURS:
        if any(kw in text_l for kw in keywords):
            return keywords[0], hours
    return None, 15


def nice_round(value):
    """Round to a 'market-natural' number (5 / 25 / 100 steps)."""
    if value <= 0:
        return 0
    if value < 100:
        return max(5, int(round(value / 5.0)) * 5)
    if value < 1000:
        return int(round(value / 25.0)) * 25
    return int(round(value / 100.0)) * 100


def heuristic_report(payload):
    text = " ".join([
        str(payload.get("service", "")),
        str(payload.get("details", "")),
        str(payload.get("experience_detail", "")),
        str(payload.get("client_detail", "")),
        str(payload.get("location", "")),
        str(payload.get("extra", "")),
    ])
    currency = str(payload.get("currency", "USD")).upper()
    fx = CURRENCIES.get(currency, 1.0)

    category = detect_category(text)
    info = CATEGORIES.get(category) or {
        "label": "General creative",
        "bands": DEFAULT_BANDS,
        "blurb": GENERAL_BLURB,
    }
    bands = info["bands"]

    level = detect_experience(text, str(payload.get("experience", "")).lower())
    client_type = str(payload.get("client_type", "")).strip() or detect_client_type(text)
    region_fx = detect_region(text)
    client_fx = CLIENT_MULTIPLIERS.get(client_type, 1.0)
    total_fx = region_fx * client_fx

    low, high = bands[level]
    mid = (low + high) / 2
    low = nice_round(low * total_fx * fx)
    mid = nice_round(mid * total_fx * fx)
    high = nice_round(high * total_fx * fx)

    deliverable, hours = detect_deliverable(text, str(payload.get("deliverable", "")))
    proj_mid = nice_round(mid * hours * 0.85)
    proj_low = nice_round(proj_mid * 0.7)
    proj_high = nice_round(proj_mid * 1.55)

    signal_text = text.lower()
    signals = [f"{info['label']} work typically bills between {CURRENCY_SYMBOLS.get(currency, '')}{low}–{CURRENCY_SYMBOLS.get(currency, '')}{high}/hr "
               f"at your experience level"]
    if client_type:
        signals.append(f"priced for {client_type} clients"
                       + (f" ({'premium' if client_fx > 1 else 'discounted'} vs. general market)" if client_fx != 1.0 else ""))
    if deliverable:
        signals.append(f"typical {deliverable} projects run ~{hours}h, so the project anchor is ~{hours}h × mid rate")
    if region_fx != 1.0:
        signals.append("adjusted for your client market's rate level")

    confidence = 0.55
    if payload.get("experience"):
        confidence += 0.15
    if client_type:
        confidence += 0.1
    if deliverable:
        confidence += 0.1
    if payload.get("location"):
        confidence += 0.1
    confidence = min(0.95, round(confidence, 2))

    tier_mid = proj_mid
    return {
        "mode": "builtin",
        "summary": (f"Based on your profile, a fair range for your {info['label'].lower()} work is "
                    f"{CURRENCY_SYMBOLS.get(currency, '')}{low}–{CURRENCY_SYMBOLS.get(currency, '')}{high} per hour, "
                    f"with typical projects landing around {CURRENCY_SYMBOLS.get(currency, '')}{proj_mid}."),
        "currency": currency,
        "hourly": {"low": low, "mid": mid, "high": high},
        "project": {"low": proj_low, "mid": proj_mid, "high": proj_high},
        "tiers": [
            {"name": "Essential", "price": proj_low,
             "description": f"Core {deliverable or 'deliverable'} only — fixed scope, one revision round, standard turnaround."},
            {"name": "Standard", "price": proj_mid,
             "description": f"Recommended: {deliverable or 'deliverable'} plus 2–3 revision rounds, priority turnaround, and a source-file handoff."},
            {"name": "Premium", "price": proj_high,
             "description": "Adds strategy input, an extra concept/iteration, extended support window, and usage/licensing headroom."},
        ],
        "rationale": signals,
        "tips": [
            "Quote a range, never a single number — it anchors negotiation upward and signals flexibility.",
            f"Position around outcomes: 'raises conversion / saves your team {hours}h' beats 'deliverable for {CURRENCY_SYMBOLS.get(currency, '')}{proj_mid}'.",
            "Put a deadline on every quote (7–14 days) — urgency converts and prevents price-shopping.",
        ],
        "sharpening": [
            "What is the typical client's budget class (early-stage, funded, enterprise)?",
            "How long does one average project actually take you, end to end?",
            "Do you include revisions, rush delivery, or usage rights in the base price?",
        ],
        "confidence": confidence,
        "blurb": info["blurb"],
    }


# ---------------------------------------------------------------------------
# LLM path
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are RateCraft, a pricing copilot for indie creators (freelance designers, writers, developers, video editors, marketers, etc.).

The user describes their service. Produce a realistic, market-grounded pricing recommendation in STRICT JSON with exactly this shape:
{
  "summary": "one or two sentences summarizing the fair rate and project price",
  "hourly": {"low": <number>, "mid": <number>, "high": <number>},
  "project": {"low": <number>, "mid": <number>, "high": <number>},
  "tiers": [{"name": "...", "price": <number>, "description": "..."}],
  "rationale": ["3-5 short bullets explaining the signals you priced on"],
  "tips": ["3 short actionable pricing/negotiation tips"],
  "sharpening": ["2-3 questions whose answers would sharpen this estimate"],
  "confidence": <0..1>,
  "blurb": "one sentence of category-specific pricing philosophy"
}
Rules:
- All prices in the user's currency. Be specific and realistic, not generic.
- Range width matters: low = acceptable floor, mid = recommended anchor, high = premium ceiling.
- 3 tiers: Essential / Standard / Premium.
- confidence reflects how much concrete information the user gave.
- Output ONLY the JSON object, no markdown fences, no commentary."""


def llm_report(payload):
    currency = str(payload.get("currency", "USD")).upper()
    user_prompt = json.dumps({
        "service": payload.get("service", ""),
        "experience": payload.get("experience", ""),
        "client_type": payload.get("client_type", ""),
        "typical_deliverable": payload.get("deliverable", ""),
        "client_market": payload.get("location", ""),
        "extra_context": payload.get("details", ""),
        "currency": currency,
    }, ensure_ascii=False)

    body = json.dumps({
        "model": API_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.4,
        "max_tokens": 1200,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    content = data["choices"][0]["message"]["content"]

    # Defensively extract the first JSON object.
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("model response contained no JSON")
    report = json.loads(content[start:end + 1])

    report["mode"] = "llm"
    report["currency"] = currency
    return report


def build_report(payload):
    if API_KEY:
        try:
            report = llm_report(payload)
            report.setdefault("tiers", [])
            report.setdefault("rationale", [])
            report.setdefault("tips", [])
            report.setdefault("sharpening", [])
            return report
        except Exception as exc:  # noqa: BLE001 — fall back to built-in on any failure
            report = heuristic_report(payload)
            report["mode"] = "builtin"
            report["fallback_reason"] = f"AI request failed ({type(exc).__name__}); used built-in estimator"
            return report
    report = heuristic_report(payload)
    return report


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "RateCraft/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("[ratecraft] %s\n" % (fmt % args))

    # -- helpers ------------------------------------------------------------

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel_path):
        try:
            target = (STATIC / rel_path).resolve()
            target.relative_to(STATIC)  # path traversal guard
        except (ValueError, OSError):
            self.send_error(404)
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        ctype = CONTENT_TYPES.get(target.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- routes -------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._send_json({
                "ok": True,
                "mode": "llm" if API_KEY else "builtin",
                "model": API_MODEL if API_KEY else None,
            })
        elif path in ("/", "/index.html"):
            self._serve_static("index.html")
        elif path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/estimate":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json({"error": "invalid JSON body"}, 400)
            return

        service = str(payload.get("service", "")).strip()
        if len(service) < 10:
            self._send_json(
                {"error": "Tell us a bit more about your service (at least a sentence) so the estimate isn't a guess."},
                400,
            )
            return

        try:
            report = build_report(payload)
            self._send_json({"ok": True, "report": report})
        except Exception as exc:  # noqa: BLE001 — never 500 on estimator internals
            self._send_json({"ok": False, "error": f"Estimate failed: {exc}"}, 500)


def main():
    if API_KEY:
        print(f"[ratecraft] mode=AI-powered  model={API_MODEL}  base={API_BASE}")
    else:
        print("[ratecraft] mode=built-in estimator  (set OPENAI_API_KEY for AI-powered reports)")
    print(f"[ratecraft] serving http://127.0.0.1:{PORT}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ratecraft] shutting down")


if __name__ == "__main__":
    main()
