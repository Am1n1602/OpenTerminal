import { Router } from "express";
import { cached, cacheGet, cacheStore, staleGet } from "../cache.js";
import { withFallback } from "../providers/registry.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";
import * as nasdaq from "../providers/nasdaq.js";
import * as fred from "../providers/fred.js";
import * as ecb from "../providers/ecb.js";
import * as tradingview from "../providers/tradingview.js";
import * as coingecko from "../providers/coingecko.js";
import * as binance from "../providers/binance.js";
import * as news from "../providers/news.js";
import * as econcalendar from "../providers/econcalendar.js";
import * as finra from "../providers/finra.js";
import * as secedgar from "../providers/secedgar.js";
import * as jugaad from "../providers/jugaad.js";

export const marketRouter = Router();

const QUOTE_TTL = 1_000;
const HISTORY_TTL = 20_000;
const NEWS_TTL = 60_000;

function fail(req: any, res: any, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[market]", req.path, detail);
  res.status(502).json({ error: "All data providers are temporarily unavailable. Try again shortly." });
}

// ---- VIX: served from FRED (daily close), since it's an index rather than a
// tradable stock/ETF — Nasdaq's stock API doesn't carry it, and routing it
// through Yahoo would make it depend on Yahoo's flaky rate limits for no reason.

function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

// A .NS/.BO-suffixed symbol is NSE/BSE-listed under this app's symbol convention.
function isIndianSymbol(symbol: string): boolean {
  return /\.(NS|BO)$/i.test(symbol);
}

async function vixQuote(): Promise<yahoo.Quote> {
  const points = await fred.series("VIXCLS", 5);
  if (points.length === 0) throw new Error("fred: no VIX data");
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const price = last.value;
  const previousClose = prev?.value ?? null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return {
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    price,
    change,
    changePercent,
    open: null,
    high: null,
    low: null,
    previousClose,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "CBOE",
    marketState: null,
    time: null,
    source: "fred",
  };
}

const VIX_RANGE_N: Record<string, number> = {
  "1D": 5,
  "5D": 5,
  "1M": 22,
  "6M": 130,
  YTD: 200,
  "1Y": 252,
  "5Y": 1260,
  MAX: 20_000,
};

async function vixHistory(rangeKey: string): Promise<yahoo.Candle[]> {
  const n = VIX_RANGE_N[rangeKey] ?? 130;
  const points = await fred.series("VIXCLS", n);
  return points.map((p) => {
    const time = Math.floor(new Date(p.date + "T00:00:00Z").getTime() / 1000);
    return { time, open: p.value, high: p.value, low: p.value, close: p.value, volume: 0 };
  });
}

// ---- quotes (per-symbol cache, so overlapping widgets share one fetch) ----

/**
 * Resolve quotes for a symbol list, reusing a per-symbol cache across every
 * caller (single quote widget, watchlist, screener, heatmap all share hits).
 * Nasdaq's public quote API is primary (no key, generous limits); Yahoo and
 * Stooq are fallbacks. A symbol that fails everywhere still falls back to
 * its last-known value instead of failing the whole batch.
 *
 * Fan-out bound: the /quotes route caps `symbols` at 150, so a single call
 * here does at most ~150 crypto lookups (only for recognized crypto symbols,
 * mutually exclusive with the stages below) + up to 300 Nasdaq calls (2 per
 * miss) + 1 batched Yahoo call + up to FALLBACK_PER_SYMBOL_CAP per-symbol
 * Yahoo chart calls + up to FALLBACK_PER_SYMBOL_CAP Stooq calls + 1 batched
 * TradingView call. Repetition beyond that is bounded by marketRouter's
 * per-IP rate limit (see index.ts).
 */
const FALLBACK_PER_SYMBOL_CAP = 20;
async function getQuotes(symbols: string[]): Promise<yahoo.Quote[]> {
  const fresh = new Map<string, yahoo.Quote>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet<yahoo.Quote>(`quote:${sym}`);
    if (hit) fresh.set(sym, hit);
    else missing.push(sym);
  }
  if (missing.length === 0) return symbols.map((s) => fresh.get(s)!).filter(Boolean);

  const fetched = new Map<string, yahoo.Quote>();
  let remaining = missing;

  const cryptoSymbols = remaining.filter((s) => binance.CRYPTO_SYMBOLS.has(s));
  if (cryptoSymbols.length > 0) {
    const results = await Promise.allSettled(cryptoSymbols.map((s) => binance.quote(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(cryptoSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const vixSymbols = remaining.filter((s) => isVix(s));
  if (vixSymbols.length > 0) {
    const results = await Promise.allSettled(vixSymbols.map(() => vixQuote()));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(vixSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // jugaad-rpc (this project's own NSE service) is the primary source for
  // Indian symbols when it's running — real-time NSE quotes instead of
  // Yahoo's delayed ones. A symbol that fails here (service not running,
  // or NSE having a bad moment) just stays in `remaining` and falls
  // through the ordinary nasdaq -> yahoo -> stooq chain below, which
  // already resolves .NS/.BO symbols fine via Yahoo alone.
  const indiaSymbols = remaining.filter((s) => isIndianSymbol(s));
  if (indiaSymbols.length > 0) {
    const results = await Promise.allSettled(indiaSymbols.map((s) => jugaad.quote(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(indiaSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  // NIFTY 50 / NIFTY BANK / India VIX aren't NSE equities (no bare-symbol
  // quote RPC covers them) but jugaad-rpc's live index snapshot does — the
  // same feed the Macro widget uses. This is what makes these tickers
  // resolvable at all when Yahoo can't be reached. SENSEX isn't in this
  // snapshot (jugaad-rpc's scope is NSE-only, and SENSEX is BSE's own
  // index) so it falls through to the TradingView-based fallback below.
  const indiaIndexSymbols = remaining.filter((s) => INDIA_INDEX_PROXIES[s]);
  if (indiaIndexSymbols.length > 0) {
    try {
      const rows = await jugaad.indexSnapshot();
      for (const sym of indiaIndexSymbols) {
        const name = INDIA_INDEX_PROXIES[sym];
        const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
        if (!row) continue;
        fetched.set(sym, {
          symbol: sym,
          name: row.name,
          price: row.last,
          change: row.change,
          changePercent: row.changePercent,
          open: null,
          high: null,
          low: null,
          previousClose: null,
          bid: null,
          ask: null,
          volume: null,
          avgVolume: null,
          marketCap: null,
          pe: null,
          eps: null,
          dividendYield: null,
          week52High: null,
          week52Low: null,
          beta: null,
          sharesOutstanding: null,
          currency: "INR",
          exchange: "NSE",
          marketState: null,
          time: null,
          source: "jugaad-rpc",
        });
      }
      remaining = remaining.filter((s) => !fetched.has(s));
    } catch {
      // jugaad-rpc not running / snapshot RPC unavailable — fall through to
      // the TradingView/Yahoo/Stooq chain below
    }
  }

  // SENSEX specifically: TradingView's scanner (direct-ticker mode, not its
  // filtered search box) carries BSE:SENSEX independent of Yahoo, which is
  // otherwise the only other source for it.
  if (remaining.includes("^BSESN")) {
    try {
      const q = await tradingview.indexQuote("india", "BSE:SENSEX");
      fetched.set("^BSESN", {
        symbol: "^BSESN",
        name: "SENSEX",
        price: q.price,
        change: null,
        changePercent: q.changePercent,
        open: q.open,
        high: q.high,
        low: q.low,
        previousClose: null,
        bid: null,
        ask: null,
        volume: q.volume,
        avgVolume: null,
        marketCap: null,
        pe: null,
        eps: null,
        dividendYield: null,
        week52High: null,
        week52Low: null,
        beta: null,
        sharesOutstanding: null,
        currency: "INR",
        exchange: "BSE",
        marketState: null,
        time: null,
        source: "tradingview",
      });
      remaining = remaining.filter((s) => s !== "^BSESN");
    } catch {
      // fall through to the ordinary nasdaq -> yahoo -> stooq chain below
    }
  }

  const nasdaqResults = await Promise.allSettled(remaining.map((s) => nasdaq.quote(s)));
  nasdaqResults.forEach((r, i) => {
    if (r.status === "fulfilled") fetched.set(remaining[i], r.value);
  });
  remaining = remaining.filter((s) => !fetched.has(s));

  if (remaining.length > 0) {
    try {
      const rows = await yahoo.quotes(remaining);
      for (const q of rows) fetched.set(q.symbol, q);
      remaining = remaining.filter((s) => !fetched.has(s));
    } catch {
      // fall through to chart-based per-symbol fetch below
    }
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => yahoo.quoteFromChart(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => stooq.quote(s)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
  }

  // Fill gaps Nasdaq's quote endpoints don't cover (open, P/E, EPS, dividend
  // yield, beta, shares outstanding) from TradingView's public scanner API,
  // in one batched request for every quote that resolved an exchange.
  const needsFundamentals = [...fetched.values()].filter((q) => q.exchange && q.pe === null);
  if (needsFundamentals.length > 0) {
    try {
      const fundamentals = await tradingview.scanFundamentals(
        needsFundamentals.map((q) => ({ symbol: q.symbol, exchange: q.exchange }))
      );
      for (const q of needsFundamentals) {
        const f = fundamentals.get(q.symbol);
        if (!f) continue;
        q.open = q.open ?? f.open;
        q.pe = q.pe ?? f.pe;
        q.eps = q.eps ?? f.eps;
        q.dividendYield = q.dividendYield ?? f.dividendYield;
        q.beta = q.beta ?? f.beta;
        q.sharesOutstanding = q.sharesOutstanding ?? f.sharesOutstanding;
      }
    } catch {
      // best-effort enrichment only — never fails the quote request
    }
  }

  for (const [sym, q] of fetched) cacheStore(`quote:${sym}`, q, QUOTE_TTL);

  const out: yahoo.Quote[] = [];
  for (const sym of symbols) {
    const q = fresh.get(sym) ?? fetched.get(sym) ?? staleGet<yahoo.Quote>(`quote:${sym}`);
    if (q) out.push(q);
  }
  return out;
}

marketRouter.get("/quotes", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 150);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  try {
    const data = await getQuotes(symbols);
    if (data.length === 0) throw new Error("no quotes from any provider");
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- history / candles ----

// withFallback only advances to the next provider on a *thrown* error — a
// provider that resolves successfully with zero rows (e.g. jugaad-rpc's
// index-history RPC given a name it doesn't recognize, like BSE's "SENSEX"
// against NSE-only niftyindices.com) looks like a success and stops the
// chain right there, never reaching Yahoo/Stooq. Wrapping each attempt to
// throw on an empty result is what actually makes the fallback chain work.
function nonEmpty<T extends unknown[]>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const rows = await fn();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("empty result");
    return rows;
  };
}

marketRouter.get("/history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const rangeKey = String(req.query.range ?? "6M");
  try {
    const data = await cached(`history:${symbol}:${rangeKey}`, HISTORY_TTL, () =>
      binance.CRYPTO_SYMBOLS.has(symbol)
        ? binance.history(symbol, rangeKey)
        : isVix(symbol)
        ? vixHistory(rangeKey)
        : isIndianSymbol(symbol)
        ? withFallback([
            ["jugaad", nonEmpty(() => jugaad.history(symbol, rangeKey))],
            ["yahoo", nonEmpty(() => yahoo.history(symbol, yahooRange(rangeKey).range, yahooRange(rangeKey).interval))],
          ])
        : INDIA_INDEX_PROXIES[symbol]
        ? withFallback([
            ["jugaad", nonEmpty(() => jugaad.indexHistory(INDIA_INDEX_PROXIES[symbol], rangeKey))],
            ["yahoo", nonEmpty(() => yahoo.history(symbol, yahooRange(rangeKey).range, yahooRange(rangeKey).interval))],
            // Last resort for SENSEX (jugaad has no BSE data, so it only ever
            // reaches this point) — best-effort, Stooq's Indian index coverage
            // isn't confirmed, but it costs nothing to try.
            ["stooq", nonEmpty(() => stooq.history(symbol))],
          ])
        : withFallback([
            ["nasdaq", nonEmpty(() => nasdaq.history(symbol, rangeKey))],
            ["yahoo", nonEmpty(() => yahoo.history(symbol, yahooRange(rangeKey).range, yahooRange(rangeKey).interval))],
            ["stooq", nonEmpty(() => stooq.history(symbol))],
          ])
    );
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty history from all providers");
    res.json(data);
  } catch (err) {
    // SENSEX is a known, permanent gap rather than a transient outage:
    // jugaad-rpc's scope is NSE-only (SENSEX is BSE's own index), and no
    // other integrated source carries its historical bars — worth telling
    // the user that directly instead of the generic "try again shortly",
    // which implies a retry would help when it won't.
    if (symbol === "^BSESN") {
      return res.status(404).json({
        error: "SENSEX chart history isn't available yet — no integrated data source covers BSE index history (quote data still works via TradingView).",
      });
    }
    fail(req, res, err);
  }
});

function yahooRange(rangeKey: string): { range: string; interval: string } {
  const map: Record<string, { range: string; interval: string }> = {
    "1D": { range: "1d", interval: "5m" },
    "5D": { range: "5d", interval: "15m" },
    "1M": { range: "1mo", interval: "1h" },
    "6M": { range: "6mo", interval: "1d" },
    YTD: { range: "ytd", interval: "1d" },
    "1Y": { range: "1y", interval: "1d" },
    "5Y": { range: "5y", interval: "1wk" },
    MAX: { range: "max", interval: "1mo" },
  };
  return map[rangeKey] ?? map["6M"];
}

// ---- search ----

// TradingView's search explicitly excludes "index"-type results (see its
// `type` filter in tradingview.ts), so a plain text search for one of these
// index names would otherwise only ever turn up unrelated ETFs/funds with
// that name in them (e.g. searching "NIFTY 50" surfaces "First Trust India
// Nifty 50 Equal Weight ETF", never the index itself) — checked before the
// real search providers so these specific well-known indices always
// resolve, regardless of what TradingView/Yahoo's own search returns.
const INDEX_ALIASES: Array<{ match: RegExp; symbol: string; name: string; exchange: string }> = [
  { match: /^nifty\s*50$/i, symbol: "^NSEI", name: "NIFTY 50", exchange: "NSE" },
  { match: /^(nifty\s*bank|bank\s*nifty)$/i, symbol: "^NSEBANK", name: "NIFTY BANK", exchange: "NSE" },
  { match: /^india\s*vix$/i, symbol: "^INDIAVIX", name: "India VIX", exchange: "NSE" },
  { match: /^sensex$/i, symbol: "^BSESN", name: "SENSEX", exchange: "BSE" },
];

marketRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  try {
    const data = await cached(`search:${q.toLowerCase()}`, 300_000, async () => {
      const alias = INDEX_ALIASES.find((a) => a.match.test(q));
      const aliasEntry = alias ? { symbol: alias.symbol, name: alias.name, exchange: alias.exchange, type: "index" } : null;
      let results: Awaited<ReturnType<typeof tradingview.search>>;
      try {
        results = await withFallback([
          ["tradingview", () => tradingview.search(q)],
          ["yahoo", () => yahoo.search(q)],
        ]);
      } catch (err) {
        // Both search providers failed outright (as opposed to merely
        // returning irrelevant results) — a known index alias should still
        // resolve rather than 502ing the whole request, since it needs no
        // provider round-trip at all.
        if (aliasEntry) return [aliasEntry];
        throw err;
      }
      if (aliasEntry && !results.some((r) => r.symbol === aliasEntry.symbol)) {
        return [aliasEntry, ...results];
      }
      return results;
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- news ----

marketRouter.get("/news", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  try {
    const data = await cached(`news:${symbol ?? "top"}`, NEWS_TTL, async () => {
      if (symbol) {
        const region = isIndianSymbol(symbol) ? "IN" : "US";
        const bare = symbol.replace(/\.(NS|BO)$/i, "");
        const lists = await Promise.allSettled([
          news.symbolNews(symbol, region),
          news.topNews(bare + " stock", region),
        ]);
        const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
        if (ok.length === 0) throw new Error("all news sources failed");
        return news.dedupe(ok).slice(0, 40);
      }
      const lists = await Promise.allSettled([
        news.topNews("sensex nifty rbi", "IN"),
        news.topNews("stock market", "US"),
      ]);
      const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
      if (ok.length === 0) throw new Error("all news sources failed");
      return news.dedupe(ok).slice(0, 40);
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- economic calendar (Fed / ECB / CPI / NFP with forecast + actual) ----

marketRouter.get("/econ-calendar", async (req, res) => {
  try {
    const data = await cached("econ-calendar", 900_000, () => econcalendar.weeklyEvents());
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- options ----

// NSE index options this widget supports for now (Phase 2 scope decision —
// index options only, not the ~180 single-stock F&O names).
const INDIA_INDEX_OPTIONS = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY"]);

marketRouter.get("/options/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const expiry = req.query.expiry ? String(req.query.expiry) : undefined;
  if (INDIA_INDEX_OPTIONS.has(symbol)) {
    try {
      const data = await cached(`options:${symbol}:${expiry ?? "front"}`, 60_000, () =>
        jugaad.optionChain(symbol, "index", expiry)
      );
      return res.json(data);
    } catch (err) {
      return fail(req, res, err);
    }
  }
  try {
    const data = await cached(`options:${symbol}:${expiry ?? "front"}`, 60_000, () =>
      withFallback([
        ["nasdaq", () => nasdaq.optionChain(symbol, expiry)],
        [
          "yahoo",
          async () => {
            const y = await yahoo.options(symbol);
            return {
              symbol: y.symbol,
              underlyingPrice: y.underlyingPrice,
              expirationDates: y.expirationDates.map((d: number) => new Date(d * 1000).toISOString().slice(0, 10)),
              selectedDate: y.selectedDate ? new Date(y.selectedDate * 1000).toISOString().slice(0, 10) : null,
              calls: y.calls,
              puts: y.puts,
            };
          },
        ],
      ])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- crypto ----

// ?currency=inr shows INR-denominated prices (CoinGecko supports it natively).
// The Binance fallback only has USDT pairs, so it always reports USD
// regardless of the requested currency — a reasonable degradation rather
// than failing the whole board when CoinGecko is down.
function cryptoCurrency(req: any): "usd" | "inr" {
  return req.query.currency === "inr" ? "inr" : "usd";
}

marketRouter.get("/crypto", async (req, res) => {
  const currency = cryptoCurrency(req);
  try {
    const data = await cached(`crypto:markets:${currency}`, 5_000, () =>
      withFallback([
        ["coingecko", () => coingecko.markets(50, currency)],
        ["binance", () => binance.markets()],
      ])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/global", async (req, res) => {
  const currency = cryptoCurrency(req);
  try {
    const data = await cached(`crypto:global:${currency}`, 120_000, () =>
      withFallback([["coingecko", () => coingecko.globalStats(currency)]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/crypto/orderbook/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!binance.CRYPTO_SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: "unsupported crypto symbol" });
  }
  try {
    const data = await cached(`orderbook:${symbol}`, 5_000, () =>
      withFallback([["binance", () => binance.orderBook(symbol)]])
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- macro: treasury yield curve (FRED) + key indexes via ETF proxies (Nasdaq) ----

const YIELD_SERIES: Array<{ id: string; tenor: string }> = [
  { id: "DGS3MO", tenor: "3M" },
  { id: "DGS5", tenor: "5Y" },
  { id: "DGS10", tenor: "10Y" },
  { id: "DGS30", tenor: "30Y" },
];

// India's own major indexes/VIX are quoted directly (no ETF-proxy trick
// needed) — Yahoo already serves ^NSEI/^NSEBANK/^BSESN/^INDIAVIX like any
// other index ticker, through the same nasdaq->yahoo->stooq cascade
// getQuotes() already runs for everything else.
const INDIA_INDEX_PROXIES: Record<string, string> = {
  "^NSEI": "NIFTY 50",
  "^NSEBANK": "NIFTY BANK",
  "^BSESN": "SENSEX",
  "^INDIAVIX": "India VIX",
};

const INDEX_PROXIES: Record<string, string> = {
  SPY: "S&P 500 (SPY)",
  DIA: "Dow Jones (DIA)",
  QQQ: "Nasdaq 100 (QQQ)",
  IWM: "Russell 2000 (IWM)",
  GLD: "Gold (GLD)",
  USO: "WTI Crude (USO)",
  TLT: "20Y+ Treasury (TLT)",
  UUP: "Dollar Index (UUP)",
};

// ---- EU macro: ECB AAA euro-area yield curve + policy rate + HICP inflation,
// plus key European indexes via US-listed ETF proxies (same trick as the US
// index proxies above — Nasdaq/Yahoo already carry these tickers, so no new
// quote provider is needed).

const EU_YIELD_SERIES: Array<{ flowRef: string; key: string; tenor: string }> = [
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M", tenor: "3M" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y", tenor: "5Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y", tenor: "10Y" },
  { flowRef: "YC", key: "B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y", tenor: "30Y" },
];

// Deposit facility rate — the ECB's operative policy rate since the 2024
// operational framework review (not the main refinancing rate).
const EU_POLICY_RATE = { flowRef: "FM", key: "D.U2.EUR.4F.KR.DFR.LEV" };
const EU_INFLATION = { flowRef: "ICP", key: "M.U2.N.000000.4.ANR" }; // HICP, y/y

const EU_INDEX_PROXIES: Record<string, string> = {
  FEZ: "Euro Stoxx 50 (FEZ)",
  IEUR: "MSCI Europe (IEUR)",
  EWG: "Germany (EWG)",
  EWU: "UK (EWU)",
  EWQ: "France (EWQ)",
  EWI: "Italy (EWI)",
};

marketRouter.get("/macro", async (req, res) => {
  try {
    if (req.query.region === "eu") {
      const [yieldResults, policyRate, inflation, quotes] = await Promise.all([
        Promise.allSettled(
          EU_YIELD_SERIES.map((s) => cached(`ecb:${s.key}`, 300_000, () => ecb.latest(s.flowRef, s.key)))
        ),
        cached(`ecb:${EU_POLICY_RATE.key}`, 300_000, () => ecb.latest(EU_POLICY_RATE.flowRef, EU_POLICY_RATE.key)).catch(
          () => null
        ),
        cached(`ecb:${EU_INFLATION.key}`, 300_000, () => ecb.latest(EU_INFLATION.flowRef, EU_INFLATION.key)).catch(
          () => null
        ),
        getQuotes(Object.keys(EU_INDEX_PROXIES)),
      ]);
      const yields = EU_YIELD_SERIES.map((s, i) => {
        const r = yieldResults[i];
        return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
      }).filter((y) => y.value !== null);

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: EU_INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
      }));

      if (yields.length === 0 && indexes.length === 0) throw new Error("no EU macro data from any provider");
      res.json({
        yields,
        vix: null,
        indexes,
        policyRate: policyRate?.value ?? null,
        inflation: inflation?.value ?? null,
      });
      return;
    }

    if (req.query.region === "in") {
      // No free daily RBI G-Sec yield-curve source has been confirmed yet
      // (see README roadmap) — yields ships empty rather than guessed at.
      //
      // NSE's own index snapshot (via jugaad-rpc) covers NIFTY 50/NIFTY
      // BANK/India VIX in one call when that service is running — real-time
      // rather than Yahoo's delayed feed. SENSEX is a BSE index NSE doesn't
      // carry, so it comes from Yahoo either way — run both lookups
      // concurrently rather than paying the jugaad-rpc deadline before even
      // starting the (independent) SENSEX request.
      const [snapshotOrNull, sensex] = await Promise.all([
        jugaad.indexSnapshot().catch(() => null),
        getQuotes(["^BSESN"]).catch(() => []),
      ]);

      const niftyFamily: Array<{ symbol: string; label: string; price: number | null; changePercent: number | null }> = [];
      if (snapshotOrNull) {
        // Exact `name`/`symbol` spelling NSE uses isn't verified live from
        // this environment — matched tolerantly so a spelling mismatch just
        // means this index is skipped (falls back to Yahoo below), not a
        // thrown error. The row's own `symbol` (e.g. "NIFTY 50", NSE's raw
        // index name) is deliberately NOT used as this app's symbol — only
        // Yahoo/Nasdaq/Stooq know how to resolve a symbol when a widget
        // clicks through to Chart/Quote, and none of them recognize NSE's
        // raw name. The canonical Yahoo-style ticker below is what every
        // other lookup in this app (and the INDIA_INDEX_PROXIES fallback
        // just below) already uses for these same three indexes.
        const pick = (matcher: RegExp) => snapshotOrNull.find((r) => matcher.test(r.name) || matcher.test(r.symbol));
        for (const [row, symbol, label] of [
          [pick(/^nifty\s*50$/i), "^NSEI", "NIFTY 50"],
          [pick(/nifty\s*bank/i), "^NSEBANK", "NIFTY BANK"],
          [pick(/india\s*vix/i), "^INDIAVIX", "India VIX"],
        ] as const) {
          if (row) niftyFamily.push({ symbol, label, price: row.last, changePercent: row.changePercent });
        }
      }

      // Fall back to Yahoo for everything (NIFTY 50/BANK/VIX included) only
      // when jugaad-rpc itself came up empty — checked before SENSEX is
      // added below, so one Yahoo success doesn't mask a jugaad-rpc miss.
      let indexes = niftyFamily;
      if (niftyFamily.length === 0) {
        const quotes = await getQuotes(Object.keys(INDIA_INDEX_PROXIES));
        indexes = quotes.map((q) => ({
          symbol: q.symbol,
          label: INDIA_INDEX_PROXIES[q.symbol] ?? q.symbol,
          price: q.price,
          changePercent: q.changePercent,
        }));
      } else if (sensex[0]) {
        indexes = [
          ...niftyFamily,
          { symbol: "^BSESN", label: "SENSEX", price: sensex[0].price, changePercent: sensex[0].changePercent },
        ];
      }

      if (indexes.length === 0) throw new Error("no India macro data from any provider");
      res.json({ yields: [], vix: null, indexes, policyRate: null, inflation: null });
      return;
    }

    const [yieldResults, vix, quotes] = await Promise.all([
      Promise.allSettled(YIELD_SERIES.map((s) => cached(`fred:${s.id}`, 300_000, () => fred.latest(s.id)))),
      cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
      getQuotes(Object.keys(INDEX_PROXIES)),
    ]);
    const yields = YIELD_SERIES.map((s, i) => {
      const r = yieldResults[i];
      return { tenor: s.tenor, value: r.status === "fulfilled" ? r.value?.value ?? null : null };
    }).filter((y) => y.value !== null);

    const indexes = quotes.map((q) => ({
      symbol: q.symbol,
      label: INDEX_PROXIES[q.symbol] ?? q.symbol,
      price: q.price,
      changePercent: q.changePercent,
    }));

    if (yields.length === 0 && indexes.length === 0) throw new Error("no macro data from any provider");
    res.json({ yields, vix: vix?.value ?? null, indexes, policyRate: null, inflation: null });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- heatmap + screener over the full market (TradingView scanner — live) ----
// ?market=eu switches from the whole-US scan to the merged major-European-
// exchanges scan (see tradingview.europeMarketScan); ?market=in switches to
// the NSE scan (see tradingview.indiaMarketScan). "in" is the default —
// India is this terminal's primary market.

function marketParam(req: any): "us" | "eu" | "in" {
  if (req.query.market === "eu") return "eu";
  if (req.query.market === "us") return "us";
  return "in";
}

// TradingView reports market cap in each stock's own listing currency (SEK,
// GBP, CHF, ...), not EUR — left unconverted, a 1.2T SEK Swedish company would
// outrank a 550B EUR Dutch one in the merged EU scan. Reference rates come
// from the same ECB source as the EU macro widget, so this needs no new
// provider (rate = local-currency units per 1 EUR).
const EU_FX_SERIES: Record<string, { flowRef: string; key: string }> = {
  GBP: { flowRef: "EXR", key: "D.GBP.EUR.SP00.A" },
  SEK: { flowRef: "EXR", key: "D.SEK.EUR.SP00.A" },
  CHF: { flowRef: "EXR", key: "D.CHF.EUR.SP00.A" },
};

async function eurFxRates(): Promise<Record<string, number>> {
  const rates: Record<string, number> = { EUR: 1 };
  const entries = await Promise.all(
    Object.entries(EU_FX_SERIES).map(async ([ccy, s]) => {
      const point = await cached(`ecb:fx:${ccy}`, 3_600_000, () => ecb.latest(s.flowRef, s.key)).catch(() => null);
      return [ccy, point?.value ?? null] as const;
    })
  );
  for (const [ccy, rate] of entries) if (rate) rates[ccy] = rate;
  return rates;
}

async function marketRows(market: "us" | "eu" | "in"): Promise<tradingview.MarketRow[]> {
  if (market === "eu") {
    return cached("marketscan:eu", 5_000, async () => {
      const [rows, fx] = await Promise.all([tradingview.europeMarketScan(1500), eurFxRates()]);
      return rows.map((r) => {
        const rate = r.currency ? fx[r.currency] : undefined;
        return rate && r.marketCap ? { ...r, marketCap: r.marketCap / rate } : r;
      });
    });
  }
  if (market === "in") {
    return cached("marketscan:in", 3_000, () => tradingview.indiaMarketScan(1500));
  }
  return cached("marketscan:full", 3_000, () => tradingview.marketScan(1500));
}

marketRouter.get("/heatmap", async (req, res) => {
  try {
    const rows = await marketRows(marketParam(req));
    const top = rows.filter((r) => r.marketCap).slice(0, 150);
    res.json(top);
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/screener", async (req, res) => {
  try {
    let rows = await marketRows(marketParam(req));
    const num = (v: unknown) => (v === undefined ? undefined : Number(v));
    const f = {
      sector: req.query.sector ? String(req.query.sector) : undefined,
      marketCapMin: num(req.query.marketCapMin),
      changeMin: num(req.query.changeMin),
      changeMax: num(req.query.changeMax),
      volumeMin: num(req.query.volumeMin),
    };
    rows = rows.filter((r) => {
      if (f.sector && r.sector !== f.sector) return false;
      if (f.marketCapMin !== undefined && (r.marketCap ?? 0) < f.marketCapMin) return false;
      if (f.changeMin !== undefined && (r.changePercent ?? -Infinity) < f.changeMin) return false;
      if (f.changeMax !== undefined && (r.changePercent ?? Infinity) > f.changeMax) return false;
      if (f.volumeMin !== undefined && (r.volume ?? 0) < f.volumeMin) return false;
      return true;
    });
    const sortKey = String(req.query.sort ?? "marketCap") as keyof tradingview.MarketRow;
    const dir = req.query.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = (a[sortKey] as number | null) ?? -Infinity;
      const bv = (b[sortKey] as number | null) ?? -Infinity;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
    res.json(rows.slice(0, 500));
  } catch (err) {
    fail(req, res, err);
  }
});

marketRouter.get("/sectors", async (req, res) => {
  try {
    const rows = await marketRows(marketParam(req));
    res.json([...new Set(rows.map((r) => r.sector))].sort());
  } catch (err) {
    res.json([]);
  }
});

// ---- market recap: templated end-of-day-style narrative + supporting stats ----

const RECAP_TTL = 15_000;

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "flat";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function buildRecapSummary(d: {
  indexes: Array<{ symbol: string; label: string; changePercent: number | null }>;
  bestSector?: { sector: string; avgChangePercent: number };
  worstSector?: { sector: string; avgChangePercent: number };
  gainers: tradingview.MarketRow[];
  losers: tradingview.MarketRow[];
  vix: number | null;
}): string {
  const spy = d.indexes.find((i) => i.symbol === "SPY");
  const qqq = d.indexes.find((i) => i.symbol === "QQQ");
  const dia = d.indexes.find((i) => i.symbol === "DIA");
  const spyChange = spy?.changePercent ?? 0;
  const dir = spyChange > 0.15 ? "trading higher" : spyChange < -0.15 ? "trading lower" : "little changed";

  const parts: string[] = [];
  parts.push(
    `US stocks are ${dir}, with the S&P 500 ${pct(spy?.changePercent)}, the Nasdaq 100 ${pct(qqq?.changePercent)} and the Dow ${pct(dia?.changePercent)}.`
  );
  if (d.bestSector && d.worstSector && d.bestSector.sector !== d.worstSector.sector) {
    parts.push(
      `${d.bestSector.sector} is leading sector performance (${pct(d.bestSector.avgChangePercent)}), while ${d.worstSector.sector} lags (${pct(d.worstSector.avgChangePercent)}).`
    );
  }
  if (d.gainers[0] && d.losers[0]) {
    parts.push(
      `${d.gainers[0].name} paces advancers, up ${pct(d.gainers[0].changePercent)}, while ${d.losers[0].name} is the biggest decliner, down ${pct(
        d.losers[0].changePercent
      )}.`
    );
  }
  if (d.vix !== null) {
    parts.push(`The VIX volatility index is at ${d.vix.toFixed(2)}.`);
  }
  return parts.join(" ");
}

marketRouter.get("/recap", async (req, res) => {
  try {
    const data = await cached("recap:full", RECAP_TTL, async () => {
      const [quotes, vix, rows, headlines] = await Promise.all([
        getQuotes(Object.keys(INDEX_PROXIES)),
        cached("fred:VIXCLS", 300_000, () => fred.latest("VIXCLS")).catch(() => null),
        marketRows("us"),
        cached("news:recap", NEWS_TTL, async () => {
          const lists = await Promise.allSettled([
            news.topNews("stock market"),
            news.topNews("federal reserve economy"),
          ]);
          const ok = lists.filter((r) => r.status === "fulfilled").map((r) => (r as any).value);
          if (ok.length === 0) throw new Error("all news sources failed");
          return news.dedupe(ok);
        }),
      ]);

      const indexes = quotes.map((q) => ({
        symbol: q.symbol,
        label: INDEX_PROXIES[q.symbol] ?? q.symbol,
        price: q.price,
        changePercent: q.changePercent,
      }));

      const ranked = rows.filter((r) => (r.marketCap ?? 0) > 2_000_000_000 && r.changePercent !== null);
      const gainers = [...ranked].sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0)).slice(0, 5);
      const losers = [...ranked].sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0)).slice(0, 5);

      const sectorMap = new Map<string, { sum: number; count: number }>();
      for (const r of rows) {
        if (r.changePercent === null || !r.sector) continue;
        const cur = sectorMap.get(r.sector) ?? { sum: 0, count: 0 };
        cur.sum += r.changePercent;
        cur.count += 1;
        sectorMap.set(r.sector, cur);
      }
      const sectors = [...sectorMap.entries()]
        .map(([sector, { sum, count }]) => ({ sector, avgChangePercent: sum / count }))
        .sort((a, b) => b.avgChangePercent - a.avgChangePercent);

      const bestSector = sectors[0];
      const worstSector = sectors[sectors.length - 1];

      const summary = buildRecapSummary({ indexes, bestSector, worstSector, gainers, losers, vix: vix?.value ?? null });

      return {
        summary,
        updatedAt: new Date().toISOString(),
        indexes,
        vix: vix?.value ?? null,
        gainers,
        losers,
        sectors: sectors.slice(0, 3).concat(sectors.length > 3 ? sectors.slice(-3) : []),
        news: headlines.slice(0, 6),
      };
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings calendar for a list of symbols ----

marketRouter.get("/calendar", async (req, res) => {
  const symbols = String(req.query.symbols ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 30);
  if (symbols.length === 0) return res.status(400).json({ error: "symbols required" });
  try {
    const data = await cached(`calendar:${symbols.join(",")}`, 3_600_000, () => tradingview.earningsCalendar(symbols));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- earnings history: forecast vs actual per quarter, plus next-day price move ----

marketRouter.get("/earnings-history/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await cached(`earnings-history:${symbol}`, 3_600_000, async () => {
      const [surprises, candles] = await Promise.all([
        nasdaq.earningsSurprise(symbol),
        withFallback([
          ["nasdaq", () => nasdaq.history(symbol, "1Y")],
          ["yahoo", () => yahoo.history(symbol, yahooRange("1Y").range, yahooRange("1Y").interval)],
          ["stooq", () => stooq.history(symbol)],
        ]),
      ]);
      const sorted = [...candles].sort((a, b) => a.time - b.time);
      // Nearest trading-day close on/after a given date, and the close of the
      // trading day right after that — the "day after earnings" move.
      const closeOnOrAfter = (unixSeconds: number) => {
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i].time >= unixSeconds - 3 * 86_400) return i;
        }
        return -1;
      };
      return surprises.map((s) => {
        const idx = closeOnOrAfter(s.dateReported);
        const dayAfterChangePercent =
          idx >= 0 && idx + 1 < sorted.length
            ? ((sorted[idx + 1].close - sorted[idx].close) / sorted[idx].close) * 100
            : null;
        return { ...s, dayAfterChangePercent };
      });
    });
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- short sale volume (FINRA Reg SHO daily file) ----

marketRouter.get("/short-volume/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const day = await cached("finra-shortvol-day", 6 * 3_600_000, () => finra.latestDay());
    const row = day.get(symbol);
    if (!row) return res.json(null);
    res.json({ ...row, shortVolumePercent: (row.shortVolume / row.totalVolume) * 100 });
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- insider transactions (SEC EDGAR Form 4) ----

marketRouter.get("/insider/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await cached(`insider:${symbol}`, 3_600_000, () => secedgar.insiderTransactions(symbol));
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- NSE bulk/short/block deals — the nearest India equivalent of FINRA's
// daily short-sale-volume file, via jugaad-rpc's large-deals feed ----

marketRouter.get("/large-deals/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const deals = await cached("jugaad-large-deals", 15 * 60_000, () => jugaad.largeDeals());
    const bare = symbol.replace(/\.(NS|BO)$/i, "");
    res.json(deals.filter((d) => d.symbol === bare));
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- NSE corporate announcements — best-effort Insider-widget equivalent
// for Indian symbols via jugaad-rpc (general exchange disclosures, not
// specifically SEBI insider-trading filings — see README roadmap) ----

marketRouter.get("/corporate-announcements/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const data = await cached(`jugaad-announcements:${symbol}`, 3_600_000, () =>
      jugaad.corporateAnnouncements(symbol)
    );
    res.json(data);
  } catch (err) {
    fail(req, res, err);
  }
});

// ---- NSE market status — holiday-aware open/closed, unlike a client-computed
// IST clock (which can't know NSE's holiday calendar) ----

marketRouter.get("/market-status", async (req, res) => {
  try {
    const segments = await cached("jugaad-market-status", 30_000, () => jugaad.marketStatus());
    // Exact `market` spelling NSE uses isn't verified live from this
    // environment — matched tolerantly (see the /macro region=in handler
    // above for the same reasoning).
    const capitalMarket = segments.find((s) => /capital market/i.test(s.market));
    if (!capitalMarket) throw new Error("no capital market segment in jugaad-rpc market status");
    res.json({
      open: /open/i.test(capitalMarket.status),
      status: capitalMarket.status,
      tradeDate: capitalMarket.tradeDate,
    });
  } catch (err) {
    fail(req, res, err);
  }
});
