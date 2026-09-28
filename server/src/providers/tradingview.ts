// TradingView's public scanner/search endpoints — used by tradingview.com's
// own screener widget and symbol search box. No API key. Requires a
// believable Referer/Origin or the edge returns 403.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  "Content-Type": "application/json",
  Referer: "https://www.tradingview.com/",
  Origin: "https://www.tradingview.com",
};

/** Map a Nasdaq-reported exchange label to TradingView's exchange prefix. */
export function toTVExchange(exchange: string | null): string {
  const e = (exchange ?? "").toUpperCase();
  if (e.includes("NASDAQ")) return "NASDAQ";
  if (e === "NYSE") return "NYSE";
  if (e.includes("AMERICAN") || e === "PSE" || e.includes("ARCA") || e.includes("AMEX")) return "AMEX";
  return "NASDAQ";
}

/** A .NS/.BO-suffixed symbol is NSE/BSE-listed under this app's symbol convention. */
function isIndianSuffixed(symbol: string): boolean {
  return /\.(NS|BO)$/i.test(symbol);
}

/**
 * TradingView scanner region + ticker for a quote, so fundamentals lookups
 * route Indian symbols to the "india" scan (NSE:RELIANCE) instead of the
 * US-only "america" scan the exchange-label mapping above targets.
 */
function tvRegionTicker(symbol: string, exchange: string | null): { region: string; ticker: string } {
  if (isIndianSuffixed(symbol)) {
    const bare = symbol.replace(/\.(NS|BO)$/i, "");
    const ex = /\.BO$/i.test(symbol) ? "BSE" : "NSE";
    return { region: "india", ticker: `${ex}:${bare}` };
  }
  return { region: "america", ticker: `${toTVExchange(exchange)}:${symbol}` };
}

export type Fundamentals = {
  open: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
};

const COLUMNS = [
  "open",
  "price_earnings_ttm",
  "earnings_per_share_basic_ttm",
  "dividends_yield_current",
  "beta_1_year",
  "total_shares_outstanding",
];

/**
 * Batch-fetch fundamentals for a list of {symbol, exchange} pairs in a
 * single request. Returns a map keyed by the plain symbol (not the
 * "EXCHANGE:SYMBOL" ticker) so callers can merge by symbol directly.
 */
/**
 * Batch-fetch fundamentals for a list of {symbol, exchange} pairs, one
 * request per TradingView scanner region involved (usually just "america",
 * plus "india" once any .NS/.BO symbol is in the batch). A failure fetching
 * one region's batch doesn't drop the others — this is enrichment only,
 * callers already treat a missing entry as "no fundamentals available".
 */
export async function scanFundamentals(
  entries: Array<{ symbol: string; exchange: string | null }>
): Promise<Map<string, Fundamentals>> {
  const out = new Map<string, Fundamentals>();
  if (entries.length === 0) return out;

  const byRegion = new Map<string, string[]>();
  const symbolForTicker = new Map<string, string>();
  for (const e of entries) {
    const { region, ticker } = tvRegionTicker(e.symbol, e.exchange);
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region)!.push(ticker);
    symbolForTicker.set(ticker, e.symbol);
  }

  await Promise.all(
    [...byRegion.entries()].map(async ([region, tickers]) => {
      const res = await fetch(`https://scanner.tradingview.com/${region}/scan`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ symbols: { tickers }, columns: COLUMNS }),
      });
      if (!res.ok) return;
      const json = await res.json();
      const rows: Array<{ s: string; d: (number | null)[] }> = json?.data ?? [];
      for (const row of rows) {
        const symbol = symbolForTicker.get(row.s) ?? row.s.split(":")[1];
        const [open, pe, eps, divYield, beta, shares] = row.d;
        out.set(symbol, {
          open: open ?? null,
          pe: pe ?? null,
          eps: eps ?? null,
          dividendYield: divYield !== null && divYield !== undefined ? divYield / 100 : null,
          beta: beta ?? null,
          sharesOutstanding: shares ?? null,
        });
      }
    })
  );
  return out;
}

export type MarketRow = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  marketCap: number | null;
  sector: string;
  exchange: string;
  country?: string;
  /** Currency marketCap is denominated in (europeMarketScan only). */
  currency?: string;
};

/** Live top-N-by-market-cap snapshot across every US exchange, one request. */
export async function marketScan(limit = 1500): Promise<MarketRow[]> {
  const res = await fetch("https://scanner.tradingview.com/america/scan", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "exchange"],
      filter: [
        { left: "type", operation: "equal", right: "stock" },
        { left: "typespecs", operation: "has", right: ["common"] },
      ],
      sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
      range: [0, limit],
    }),
  });
  if (!res.ok) throw new Error(`tradingview scan ${res.status}`);
  const json = await res.json();
  const rows: Array<{ s: string; d: any[] }> = json?.data ?? [];
  return rows
    .map((r) => {
      const [name, close, change, marketCap, sector, volume, exchange] = r.d;
      return {
        symbol: r.s.split(":")[1],
        name: name ?? r.s.split(":")[1],
        price: close ?? null,
        changePercent: change ?? null,
        marketCap: marketCap ?? null,
        sector: sector || "Other",
        volume: volume ?? null,
        exchange: exchange ?? "",
      };
    })
    // OTC/pink-sheet listings are foreign primary listings mirrored onto US OTC
    // markets — noisy, illiquid duplicates of companies better represented
    // elsewhere; drop them so the heatmap/screener only shows primary US listings.
    .filter((r) => r.symbol && r.exchange !== "OTC");
}

// Major European markets, one TradingView scanner region per country — there
// is no combined "whole Europe" region like "america". Each market is scanned
// for its primary listing venue (e.g. Xetra for Germany, not the seven other
// regional German exchanges) *and* filtered to companies domiciled there,
// because e.g. the "germany" region also carries Apple/NVIDIA cross-listings
// that would otherwise drown out actual German names.
const EUROPE_MARKETS: Array<{ region: string; exchange: string; country: string }> = [
  { region: "uk", exchange: "LSE", country: "United Kingdom" },
  { region: "germany", exchange: "XETR", country: "Germany" },
  { region: "france", exchange: "EURONEXT", country: "France" },
  { region: "netherlands", exchange: "EURONEXT", country: "Netherlands" },
  { region: "switzerland", exchange: "SIX", country: "Switzerland" },
  { region: "italy", exchange: "MIL", country: "Italy" },
  { region: "spain", exchange: "BME", country: "Spain" },
  { region: "sweden", exchange: "OMXSTO", country: "Sweden" },
  { region: "belgium", exchange: "EURONEXT", country: "Belgium" },
];

async function scanOneEuropeMarket(
  m: { region: string; exchange: string; country: string },
  perMarketLimit: number
): Promise<MarketRow[]> {
  const res = await fetch(`https://scanner.tradingview.com/${m.region}/scan`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      // fundamental_currency_code (not "currency"!) is what market_cap_basic
      // is denominated in — for UK listings "currency" is GBX (pence, the
      // quote currency) while the market cap is reported in GBP.
      columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "fundamental_currency_code"],
      filter: [
        { left: "type", operation: "equal", right: "stock" },
        { left: "typespecs", operation: "has", right: ["common"] },
        { left: "country", operation: "equal", right: m.country },
        { left: "exchange", operation: "equal", right: m.exchange },
      ],
      sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
      range: [0, perMarketLimit],
    }),
  });
  if (!res.ok) throw new Error(`tradingview scan ${m.region} ${res.status}`);
  const json = await res.json();
  const rows: Array<{ s: string; d: any[] }> = json?.data ?? [];
  return rows
    .map((r) => {
      const [name, close, change, marketCap, sector, volume, currency] = r.d;
      return {
        symbol: r.s.split(":")[1],
        name: name ?? r.s.split(":")[1],
        price: close ?? null,
        changePercent: change ?? null,
        marketCap: marketCap ?? null,
        sector: sector || "Other",
        volume: volume ?? null,
        exchange: m.exchange,
        country: m.country,
        currency: currency || undefined,
      };
    })
    .filter((r) => r.symbol);
}

/**
 * Live top-N-by-market-cap snapshot across the largest European exchanges,
 * one request per market merged client-side (see EUROPE_MARKETS). A failure
 * in one market doesn't take down the rest (Promise.allSettled).
 */
export async function europeMarketScan(limit = 1500): Promise<MarketRow[]> {
  const perMarket = 300;
  const results = await Promise.allSettled(EUROPE_MARKETS.map((m) => scanOneEuropeMarket(m, perMarket)));
  const rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  return rows.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)).slice(0, limit);
}

/**
 * Live top-N-by-market-cap snapshot of the Indian equity market, same shape
 * as marketScan()/europeMarketScan(). Filtered to NSE as the primary listing
 * venue so BSE cross-listings of the same company don't show up twice (the
 * same reasoning as the OTC filter in marketScan() above). Market cap here
 * is already INR — no FX normalization needed, unlike the merged EU scan.
 */
export async function indiaMarketScan(limit = 1500): Promise<MarketRow[]> {
  const res = await fetch("https://scanner.tradingview.com/india/scan", {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      columns: ["description", "close", "change", "market_cap_basic", "sector", "volume", "exchange"],
      filter: [
        { left: "type", operation: "equal", right: "stock" },
        { left: "typespecs", operation: "has", right: ["common"] },
        { left: "exchange", operation: "equal", right: "NSE" },
      ],
      sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
      range: [0, limit],
    }),
  });
  if (!res.ok) throw new Error(`tradingview scan india ${res.status}`);
  const json = await res.json();
  const rows: Array<{ s: string; d: any[] }> = json?.data ?? [];
  return rows
    .map((r) => {
      const [name, close, change, marketCap, sector, volume, exchange] = r.d;
      return {
        symbol: r.s.split(":")[1],
        name: name ?? r.s.split(":")[1],
        price: close ?? null,
        changePercent: change ?? null,
        marketCap: marketCap ?? null,
        sector: sector || "Other",
        volume: volume ?? null,
        exchange: exchange ?? "",
        currency: "INR",
      };
    })
    .filter((r) => r.symbol);
}

export type EarningsInfo = {
  symbol: string;
  nextEarningsDate: number | null; // unix seconds
  lastEarningsDate: number | null;
  epsForecast: number | null;
};

const EARNINGS_COLUMNS = ["earnings_release_next_date", "earnings_release_date", "earnings_per_share_forecast_next_fq"];

/**
 * Next/last earnings date + forward EPS estimate for a batch of symbols. We
 * don't know each US symbol's exchange up front, so every US symbol is
 * queried under NASDAQ/NYSE/AMEX at once in the "america" scan — TradingView
 * just drops whichever prefixes don't match, so exactly one row comes back
 * per symbol. .NS/.BO-suffixed symbols are queried the same way against the
 * "india" scan under NSE/BSE instead, in a separate request.
 */
export async function earningsCalendar(symbols: string[]): Promise<EarningsInfo[]> {
  const bySymbol = new Map<string, EarningsInfo>();

  async function queryRegion(region: string, tickerToSymbol: Map<string, string>) {
    const tickers = [...tickerToSymbol.keys()];
    if (tickers.length === 0) return;
    const res = await fetch(`https://scanner.tradingview.com/${region}/scan`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ symbols: { tickers }, columns: EARNINGS_COLUMNS }),
    });
    if (!res.ok) return;
    const json = await res.json();
    const rows: Array<{ s: string; d: (number | null)[] }> = json?.data ?? [];
    for (const row of rows) {
      const symbol = tickerToSymbol.get(row.s);
      if (!symbol || bySymbol.has(symbol)) continue;
      const [nextEarningsDate, lastEarningsDate, epsForecast] = row.d;
      bySymbol.set(symbol, { symbol, nextEarningsDate, lastEarningsDate, epsForecast });
    }
  }

  const usTickers = new Map<string, string>();
  const inTickers = new Map<string, string>();
  for (const s of symbols) {
    if (isIndianSuffixed(s)) {
      const bare = s.replace(/\.(NS|BO)$/i, "");
      for (const ex of ["NSE", "BSE"]) inTickers.set(`${ex}:${bare}`, s);
    } else {
      for (const ex of ["NASDAQ", "NYSE", "AMEX"]) usTickers.set(`${ex}:${s}`, s);
    }
  }

  await Promise.all([queryRegion("america", usTickers), queryRegion("india", inTickers)]);

  return symbols.map((s) => bySymbol.get(s) ?? { symbol: s, nextEarningsDate: null, lastEarningsDate: null, epsForecast: null });
}

export type IndexQuote = {
  price: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
};

/**
 * Direct quote for one exact "EXCHANGE:TICKER" TradingView symbol (e.g.
 * "BSE:SENSEX"), via the same scanner tickers-mode already used above for
 * fundamentals/earnings lookups. Unlike search(), this isn't filtered to
 * `type in ["stock","fund","dr"]`, so it also resolves indices that
 * TradingView's own symbol search excludes — this is how SENSEX gets a
 * quote independent of Yahoo, which is otherwise its only source since
 * jugaad-rpc's NSE-only scope doesn't cover BSE.
 */
export async function indexQuote(region: string, ticker: string): Promise<IndexQuote> {
  const res = await fetch(`https://scanner.tradingview.com/${region}/scan`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ symbols: { tickers: [ticker] }, columns: ["close", "change", "open", "high", "low", "volume"] }),
  });
  if (!res.ok) throw new Error(`tradingview scan ${ticker} ${res.status}`);
  const json = await res.json();
  const row = (json?.data ?? [])[0];
  if (!row) throw new Error(`tradingview: no data for ${ticker}`);
  const [close, change, open, high, low, volume] = row.d;
  return {
    price: close ?? null,
    changePercent: change ?? null,
    open: open ?? null,
    high: high ?? null,
    low: low ?? null,
    volume: volume ?? null,
  };
}

export type SearchResult = { symbol: string; name: string; exchange: string; type: string };

// Non-US exchanges we can serve via Yahoo Finance (our international fallback —
// Nasdaq/TradingView quote & history endpoints only cover US-listed names).
// Matched case-insensitively against TradingView's `exchange` field, which is
// sometimes a short code ("XETR") and sometimes a full name ("Euronext Paris").
const EXCHANGE_SUFFIX: Array<{ match: RegExp; suffix: string }> = [
  { match: /^(mil|bit)$/i, suffix: ".MI" }, // Borsa Italiana / Euronext Milan
  { match: /euronext paris|^par$/i, suffix: ".PA" },
  { match: /euronext amsterdam|^ams$/i, suffix: ".AS" },
  { match: /euronext brussels|^bru$/i, suffix: ".BR" },
  { match: /euronext lisbon|^lis$/i, suffix: ".LS" },
  { match: /^(xetr|fra|ger|gettex)$/i, suffix: ".DE" }, // Germany (Xetra/Frankfurt)
  { match: /^(lse|lsin)$/i, suffix: ".L" }, // London
  { match: /^(bme|mce)$/i, suffix: ".MC" }, // Spain (Madrid)
  { match: /^(six|swx|ebs)$/i, suffix: ".SW" }, // Switzerland
  { match: /^omxsto$/i, suffix: ".ST" }, // Stockholm
  { match: /^omxcop$/i, suffix: ".CO" }, // Copenhagen
  { match: /^omxhex$/i, suffix: ".HE" }, // Helsinki
  { match: /^oslo$/i, suffix: ".OL" }, // Oslo
  { match: /^(tsx|tsxv)$/i, suffix: ".TO" }, // Toronto
  { match: /^asx$/i, suffix: ".AX" }, // Australia
  { match: /^hkex$/i, suffix: ".HK" }, // Hong Kong
  { match: /^tse$/i, suffix: ".T" }, // Tokyo
  { match: /^nse$/i, suffix: ".NS" }, // India (NSE)
  { match: /^bse$/i, suffix: ".BO" }, // India (BSE)
];

function yahooSuffixFor(exchange: string): string {
  for (const { match, suffix } of EXCHANGE_SUFFIX) {
    if (match.test(exchange)) return suffix;
  }
  return "";
}

export async function search(query: string): Promise<SearchResult[]> {
  const url = `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(
    query
  )}&hl=1&lang=en&search_type=undefined&domain=production&sort_by_country=IN`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`tradingview search ${res.status}`);
  const json = await res.json();
  const rows: any[] = json?.symbols ?? [];
  const strip = (s: string) => s.replace(/<\/?em>/g, "");
  return rows
    .filter((r) => ["stock", "fund", "dr"].includes(r.type))
    .slice(0, 15)
    .map((r) => {
      const exchange = r.exchange ?? "";
      const symbol = strip(r.symbol);
      return {
        // Non-US listings get a Yahoo-compatible suffix (e.g. "ISP" -> "ISP.MI")
        // so quote/chart lookups downstream can actually resolve them — Nasdaq's
        // API only covers US tickers, and a bare symbol collides with US names.
        symbol: symbol.includes(".") ? symbol : symbol + yahooSuffixFor(exchange),
        name: strip(r.description ?? r.symbol),
        exchange,
        type: r.type ?? "",
      };
    });
}
