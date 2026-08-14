# RateCraft ◆

**AI pricing copilot for indie creators.** Describe what you do — design, writing, development, video, marketing, consulting, photography, audio, social — and RateCraft returns a market-grounded pricing report: hourly range, typical project price, three package tiers you can send to a client, the rationale behind the numbers, and a negotiation playbook.

Zero dependencies. Runs locally with `python app.py`. Works out of the box with a built-in market-signal estimator, and upgrades to LLM-powered reports when an API key is configured.

## Quick start

```bash
python app.py
# → serving http://127.0.0.1:8000
```

Open http://127.0.0.1:8000, describe your service, answer the clarifying questions, get your report.

## AI-powered mode (optional)

The built-in estimator already produces the full report. To get richer, tailored reports from an LLM:

```bash
# Windows PowerShell
$env:OPENAI_API_KEY = "sk-..."
python app.py
```

```bash
# macOS / Linux
OPENAI_API_KEY=sk-... python app.py
```

Works with any OpenAI-compatible endpoint:

| Env var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` (or `RATECRAFT_API_KEY`) | — | Enables AI mode |
| `RATECRAFT_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API base |
| `RATECRAFT_MODEL` | `gpt-4o-mini` | Model name |
| `PORT` | `8000` | Server port |

If the AI request fails for any reason, the server automatically falls back to the built-in estimator and says so in the report — the app never breaks.

## How it works

1. **Describe** — free-text service description plus quick signals (experience, typical client, client market, currency).
2. **Clarify** — typical project shape and main deliverable.
3. **Report** — `POST /api/estimate` returns the full report as JSON:
   - `hourly` / `project` — low / mid / high ranges
   - `tiers` — Essential / Standard / Premium packages
   - `rationale`, `tips`, `sharpening`, `confidence`, `blurb`

The built-in estimator scores the description against market reference data (category bands, experience level, client-type and region multipliers, deliverable-hour anchors) and rounds to natural market numbers. It is deterministic and fully offline.

## Project layout

```
app.py            # stdlib HTTP server, estimator, LLM client
static/index.html # single-page UI (describe → clarify → report)
static/app.css    # styling
static/app.js     # frontend logic
```

## Privacy

With no API key, everything runs locally — nothing leaves your machine. With a key configured, your description is sent to the configured provider (standard OpenAI-compatible chat-completions call).

## Making money with this (product paths)

RateCraft is the v1 of a sellable product. Natural monetization paths, in order of effort:

1. **Freemium SaaS** — free basic report; paid tier adds exportable client-ready proposals, saved history, and niche-specific databases. Needs accounts + a small backend.
2. **Paid API / embed** — sell `/api/estimate` as a white-label widget for freelance platforms, agencies, or creator tools.
3. **Lead magnet + coaching funnel** — the report is the lead magnet; upsell a rate-negotiation course or 1:1 pricing audit.
4. **Subscription packs** — pay per report beyond a monthly free allowance (credits model).

## Roadmap ideas (deferred from v1)

- Accounts, saved reports, and report history
- Proposal/quote generator that turns the report into a client-ready PDF
- Niche-specific databases (e.g., YouTube thumbnails, Shopify builds) tuned per category
- Multi-language output
- Rate-index inputs: let users calibrate with their own past project rates

## Disclaimer

Estimates are directional guidance for pricing decisions, not financial advice. Real rates vary with portfolio strength, demand, niche depth, and cost of living — use the range as a starting anchor, then negotiate up.
