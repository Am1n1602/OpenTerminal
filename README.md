<div align="center">

# OpenTerminal

**A Terminal‑style workspace for the rest of us — built entirely on free, public market data.**

Dark. Dense. Keyboard‑driven. Zero paid API keys, zero subscriptions. Tuned for the **Indian stock market** (NSE/BSE) by default, with US and European markets a tab away.

[![Stack](https://img.shields.io/badge/stack-Next.js%20%2B%20Express%20%2B%20TypeScript-orange)](#tech-stack)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![No API Key Required](https://img.shields.io/badge/data-no%20API%20key%20required-brightgreen)](#data-sources)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](#contributing)

<a href="https://trendshift.io/repositories/215916?utm_source=trendshift-badge&utm_medium=badge&utm_campaign=badge-trendshift-215916" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/215916/daily?language=TypeScript" alt="ErTasselli%2FOpenTerminal | Trendshift" width="250" height="55"/></a>

<br/>

<img src="docs/screenshots/dashboard.png" alt="OpenTerminal dashboard — live chart, quote panel, watchlist, news and macro indexes" width="100%" />

<sub>⭐ If this is useful to you, consider starring the repo — it genuinely helps other people find it.</sub>

</div>

<br/>

## Why OpenTerminal?

Real trading terminals cost **$2,000+ a month**. Most retail dashboards either lock the good stuff behind a paywall or run on a single flaky data source that breaks the moment you actually need it.

OpenTerminal takes a different approach: it stitches together several **free, publicly documented (or reverse‑engineered but widely used) market data endpoints** — the same ones that power major finance sites' own front ends — into one fast, keyboard‑first, widget‑based dashboard that runs entirely on your machine. Every data endpoint has an automatic fallback chain, so a single provider hiccup never takes the whole app down.

No signup. No credit card. No rate‑limited demo tier. Clone it, `npm install`, and you have a live terminal in under a minute.

<br/>

## ✨ Features

- 🖥️ **Widget-based workspace** — drag, resize, add, and remove panels (`react-grid-layout`); your layout is saved locally and restored on reload
- ⌘K **global command palette** — instantly search stocks, ETFs, and crypto and jump straight to them
- 📈 **Professional charting** (via [`lightweight-charts`](https://github.com/tradingview/lightweight-charts)) — candlesticks, bars, line, area, volume, 8 timeframes (1D → MAX), and SMA / EMA / VWAP / Bollinger Bands / RSI / MACD indicators, each with a live hover legend showing OHLC, volume, and every active indicator's value under your cursor
- 💹 **Quote panel** — last / bid / ask / OHLC, volume, market cap, P/E, EPS, dividend yield, 52‑week range, beta, shares outstanding
- 📰 **News feed** — aggregated and de‑duplicated from multiple RSS sources, per‑symbol or global
- 🔎 **Full‑market screener** — filter by sector, market cap, % change, and volume across NSE (default), the entire US equity market, or Europe's largest exchanges, sortable on every column
- 🗺️ **Live sector heatmap** — treemap sized by market cap, colored by daily % change, refreshing every few seconds, for NSE/US/Europe
- ⛓️ **Options chain** — calls and puts side‑by‑side with strike, bid/ask, volume, open interest, and ITM highlighting
- 🪙 **Crypto board** — top assets with 7‑day sparklines, BTC/ETH dominance, and full OHLCV charting for any listed coin
- 🏦 **Macro dashboard** — NIFTY 50 / NIFTY BANK / SENSEX / India VIX by default, plus US Treasury yield curve & VIX and Euro area yields as secondary tabs
- 💼 **Portfolio tracker** — log buy/sell transactions, track average cost, realized & unrealized P&L (persisted in SQLite)
- 📅 **Calendar** — economic events (Fed, ECB, CPI, NFP and more) with consensus forecast, previous reading and, for the major US/EU releases, the actual outcome; plus a per‑watchlist earnings calendar with click‑through history showing forecast vs. actual EPS for the last several quarters and the stock's next‑day price move
- 🤖 **AI assistant** (optional) — ask questions about the symbol you're looking at, powered by Claude, fully context‑aware of the terminal's current data
- ⚡ **Near real‑time updates** — quotes and indexes refresh every second with a subtle flash on change, so you always know what just moved
- ⌨️ **Keyboard shortcuts** everywhere — `⌘K` to search, `⌥1`–`⌥9` to add any widget

<br/>

## 📸 A closer look

### Charting

Candlesticks, bars, line, or area — 8 timeframes, six technical indicators, and a live legend under your cursor showing OHLC, volume, and every active indicator's value for the candle you're pointing at.

<img src="docs/screenshots/chart.png" alt="Candlestick chart with SMA/RSI/MACD indicators and hover legend" width="100%" />

<br/>

### Live sector heatmap

The whole US equity market as a treemap — sized by market cap, colored by daily % change, refreshing every few seconds so nothing you're watching ever goes stale.

<img src="docs/screenshots/heatmap.png" alt="Live sector heatmap of the US equity market" width="100%" />

<br/>

### Crypto

Top assets with 7‑day sparklines and BTC/ETH dominance — click through to full OHLCV candlestick charting for any listed coin, same charting engine as stocks.

<img src="docs/screenshots/crypto.png" alt="Crypto board with sparklines and dominance" width="100%" />

<br/>

### News

Headlines aggregated and de‑duplicated across multiple sources, filterable per‑symbol or global, so you're never digging through five tabs to catch up.

<img src="docs/screenshots/news.png" alt="Per-symbol and global news feed, aggregated and de-duplicated" width="100%" />

<br/>

## 🗂️ Data sources

No paid API, no keys, and no single point of failure — every endpoint has a fallback chain, and results are cached with a stale‑while‑revalidate strategy so a temporary outage never blanks out the UI.

| Data | Primary source | Fallback |
|---|---|---|
| Quotes — US (stocks/ETFs) | Nasdaq public quote API | Yahoo Finance → Stooq |
| Quotes — NSE/BSE (`.NS`/`.BO` symbols) | [`jugaad-rpc`](https://github.com/Am1n1602/jugaad-rs) (NSE, real‑time)¹ | Yahoo Finance → TradingView scanner (fundamentals only) |
| Fundamentals (P/E, EPS, beta, div yield) | TradingView scanner API (`america` scan for US, `india` scan for NSE/BSE) | — |
| Historical candles | Nasdaq chart API (US) / `jugaad-rpc`¹ (NSE) | Yahoo Finance → Stooq (US) / Yahoo Finance (NSE) |
| Symbol search | TradingView symbol search (sorted India‑first) | Yahoo Finance |
| Full‑market screener / heatmap | TradingView scanner API — NSE by default, whole‑US or major‑Europe scans a tab away | — |
| Options chain — US | Nasdaq option‑chain API | Yahoo Finance |
| Options chain — NSE index options (NIFTY/BANKNIFTY/FINNIFTY) | `jugaad-rpc`¹ | — |
| News | Yahoo Finance RSS + Google News RSS, region‑biased to India for `.NS`/`.BO` symbols | — |
| Crypto quotes & board | CoinGecko | Binance public API |
| Crypto candles | Binance public API (klines) | — |
| Macro — India indexes (NIFTY 50 / NIFTY BANK / India VIX) | `jugaad-rpc`¹ (NSE, real‑time) | Yahoo Finance index quotes |
| Macro — India (SENSEX) | Yahoo Finance index quote (BSE — outside jugaad‑rpc's NSE‑only scope) | — |
| Macro — US (Treasury yields, VIX) / EU (yields, ECB rate, HICP) | FRED (Federal Reserve) / ECB | — |
| Economic calendar (schedule, forecast, previous — incl. RBI/India events) | Forex Factory public feed | — |
| Economic calendar (actual — Fed / ECB / CPI / NFP only) | FRED (Federal Reserve) | — |
| Earnings calendar (next/last date, EPS estimate) | TradingView scanner API (`india` scan for NSE/BSE symbols) | — |
| Earnings history (forecast vs. actual, surprise %) | Nasdaq earnings‑surprise API (US symbols only — no NSE equivalent found yet) | — |
| Short‑volume — US | FINRA Reg SHO daily file | — |
| Short‑volume — NSE (bulk/short/block deals) | `jugaad-rpc`¹ | — |
| Insider transactions — US | SEC EDGAR (Form 4) | — |
| Insider transactions — NSE (best‑effort: general corporate announcements, not SEBI insider‑trading filings specifically) | `jugaad-rpc`¹ | — |

¹ `jugaad-rpc` is this project's own companion NSE data service, run as the `jugaad-rpc` container in `docker-compose.yml` (`JUGAAD_RPC_URL` for a standalone `npm run dev`). **As of this commit its published image only implements live quotes** — the history/options/large‑deals/index‑snapshot/corporate‑announcements RPCs this app now calls exist in [jugaad-rs](https://github.com/Am1n1602/jugaad-rs)'s source but need a new image build+publish before they're live; until then those calls fail fast and fall back to Yahoo/TradingView exactly as if the container weren't running. See [Roadmap](#-roadmap).

> ⚠️ These are public endpoints, not officially licensed data feeds — treat prices as delayed/indicative, not execution‑grade. See [`server/src/providers/`](server/src/providers) — each provider is a small, isolated module, so swapping or adding a data source is a 30‑minute job.

<br/>

## 🚀 Quick start

```bash
git clone https://github.com/ErTasselli/openterminal.git
cd openterminal
npm install
npm run dev
```

- Web UI → **http://localhost:3000**
- API health → **http://localhost:4000/api/status**

That's it — no `.env` file required to get a fully working terminal.

### Optional: AI assistant

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Without a key, everything else still works — the AI widget just shows a friendly "unavailable" message instead of failing.

### Security defaults

- The API binds to `127.0.0.1` and only accepts browser requests from `http://localhost:3000` by default — nothing else on your network can reach it out of the box.
- The portfolio and AI endpoints require a shared secret. If you don't set `API_KEY` yourself, the API generates one on first run and saves it to `data/.api-key`; the bundled web app reads that file automatically, so local dev stays zero-config.
- To expose this beyond your own machine, set `API_HOST=0.0.0.0`, `API_KEY=<a-strong-secret>` (on both the api and web processes), and `WEB_ORIGIN=<your actual origin>` explicitly. Don't do this without also keeping dependencies patched — see [Known limitations](#known-limitations) below.
- The `/api/ai` rate limit (10 req/min) keys on `req.ip`. Calls made through the bundled web proxy all arrive from that proxy's own address, so by default every caller sharing it shares one bucket. If you're serving more than one real user through it, set `TRUST_PROXY=1` on the api process **only if** you also run your own reverse proxy in front of the web service that sets `X-Forwarded-For` from the real client and doesn't let visitors set it themselves — otherwise a caller can forge that header to dodge the limit.

<br/>

## 🐳 Docker

```bash
docker compose up --build
```

Portfolio data persists in the `terminal-data` volume (SQLite, WAL mode). Ports are published on `127.0.0.1` only by default; see [Security defaults](#security-defaults) to expose it deliberately.

<br/>

## 🧱 Tech stack

| Layer | Stack |
|---|---|
| Frontend | Next.js 15 · React 19 · TypeScript · Tailwind CSS 4 · Zustand · TanStack Query |
| Charts | `lightweight-charts` (candles/indicators) · D3 (heatmap treemap) · Recharts (yield curve) |
| Backend | Node.js · Express · TypeScript |
| Database | SQLite (`better-sqlite3`, WAL mode) |
| AI | Anthropic Claude (optional) |

<br/>

## 📁 Project structure

```
├── server/                  # Express + TypeScript API
│   └── src/
│       ├── providers/       # nasdaq, tradingview, yahoo, stooq, fred, econcalendar, coingecko, binance, news
│       ├── routes/          # market, portfolio, ai
│       ├── cache.ts         # TTL cache with stale-while-revalidate fallback
│       └── db.ts            # SQLite (better-sqlite3, WAL)
└── web/                      # Next.js 15 + React 19 + Tailwind 4
    ├── components/           # TopBar, Sidebar, Workspace, CommandPalette
    ├── components/widgets/   # Chart, Quote, Watchlist, News, Screener, Heatmap, Crypto, Options, Macro, Portfolio, Calendar, AI
    ├── lib/                  # API client, technical indicators
    └── store/                # Zustand store (workspace layout, persisted)
```

Run tests with `npm test` (Vitest, no network calls). CI runs on every push — see [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

<br/>

## 🗺️ Roadmap

**India data layer**
- [x] NSE quotes, history, index options (NIFTY/BANKNIFTY/FINNIFTY), full option‑expiry listing, index snapshot (NIFTY 50/NIFTY BANK/India VIX), bulk/short/block deals and corporate announcements, all wired up to call [`jugaad-rpc`](https://github.com/Am1n1602/jugaad-rs) — this app's code and the RPCs it needs both exist now (`GetOptionExpiries` added in Phase 3, reusing jugaad-core's already‑live‑verified `option-chain-contract-info` parsing rather than guessing at new NSE behavior)
- [ ] **Blocked**: publish a new `jugaad-rpc` image build so those RPCs are actually live — the running container still only serves `GetStockQuote`/`WatchStockQuote` until then (see the data‑source table's footnote)
- [ ] SEBI insider‑trading‑disclosure‑specific endpoint (the Insider widget's NSE data is general corporate announcements today, not that specifically — needs a confirmed NSE endpoint first, per jugaad‑rs's own verify‑live‑before‑coding discipline)
- [ ] RBI G‑Sec yield curve for the Macro widget — researched (RBI's DBIE portal, data.rbi.org.in/DBIE, looks like the best free lead, similar in spirit to FRED for the US) but not verified: this environment's network policy blocks egress to data.rbi.org.in outright, so whether it has a clean CSV/JSON endpoint (vs. only an interactive portal) needs checking from a normal connection before building against it
- [ ] NSE‑equivalent of forecast‑vs‑actual earnings history
- [ ] Additional Indian financial news RSS sources (Moneycontrol/ET/LiveMint) — same blocker as above, candidate URLs turned up by search but unverifiable from here; verify before adding
- [ ] Single‑stock NSE F&O options (index options only for now, by design)

**General**
- [ ] Chart drawing tools & multi‑asset comparison overlay
- [ ] Black‑Scholes Greeks on the options chain
- [ ] Price alerts with desktop notifications
- [ ] PostgreSQL as an alternative to SQLite

Have an idea? [Open an issue](../../issues) — contributions are very welcome.

<br/>

## 🤝 Contributing

Pull requests are welcome, especially:
- New or more resilient data providers (`server/src/providers/`)
- New widgets (`web/components/widgets/`)
- Bug fixes and UI polish

Please open an issue first for anything non‑trivial so we can align on approach before you invest the time.

<br/>

## Known limitations

- `npm audit` still flags two dependency advisories this project doesn't force-fix: `fast-xml-parser`'s XMLBuilder injection (moderate) doesn't apply here — only `XMLParser` is used, never `XMLBuilder` — and `postcss`'s high-severity issue is bundled inside Next.js itself, only resolved by a Next 16 major upgrade. Both are tracked, neither is silently ignored.
- If you deploy behind a reverse proxy or load balancer, set `API_HOST`/`WEB_ORIGIN` to match, and terminate TLS in front of it — this project doesn't handle HTTPS itself.

<br/>

## ⚖️ Disclaimer

For personal and educational use only. Market data comes from public endpoints and may be delayed, incomplete, or occasionally wrong — **do not use this for real investment decisions**.

This project is not affiliated with, endorsed by, or sponsored by any of the data providers it connects to. It does not host or redistribute data to third parties — it's source code you run yourself, fetching data directly from the provider. Respect the terms of service of the underlying data providers; most free sources are licensed for personal/research use only and prohibit commercial redistribution.

## License

[MIT](LICENSE)

<br/>

<div align="center">

**star the repo** ⭐ — it's the best way to support the project.

</div>
