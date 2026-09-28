// gRPC client for jugaad-rpc (https://github.com/Am1n1602/jugaad-rs) — the
// project's own NSE data service. This is the primary source for Indian
// (.NS/.BO) symbols; Yahoo/TradingView stay as the fallback when this
// service isn't running (e.g. plain `npm run dev` without docker-compose)
// or a specific call isn't implemented server-side yet.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { Quote, Candle } from "./yahoo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, "proto", "jugaad.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const jugaadProto = grpc.loadPackageDefinition(packageDefinition) as any;

const RPC_URL = process.env.JUGAAD_RPC_URL ?? "127.0.0.1:50051";
const DEFAULT_DEADLINE_MS = 4_000;

let client: any = null;
function getClient(): any {
  if (!client) client = new jugaadProto.jugaad.Jugaad(RPC_URL, grpc.credentials.createInsecure());
  return client;
}

function call<TReq, TRes>(method: string, req: TReq, deadlineMs = DEFAULT_DEADLINE_MS): Promise<TRes> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + deadlineMs;
    getClient()[method](req, { deadline }, (err: grpc.ServiceError | null, res: TRes) => {
      if (err) reject(new Error(`jugaad-rpc ${method}: ${err.message}`));
      else resolve(res);
    });
  });
}

// proto-loader's `longs: String` decodes every uint64/int64 field as a
// string (avoids silent precision loss over the wire) — every count/volume
// field below needs converting back to a plain number for this app's types.
const num = (v: unknown): number => Number(v ?? 0);

// proto3 `optional` scalars surface as a synthetic-oneof presence flag under
// `oneofs: true` (absent means "not set", not "zero"). The value itself is
// always read from proto-loader's camelCased field key; the presence flag's
// own key name follows the proto's synthetic oneof name, which is declared
// against the original (snake_case) field name — checking both spellings
// here is a defensive hedge against exactly which one proto-loader surfaces,
// since this can't be exercised against a live jugaad-rpc from this
// environment before merge (see README Phase 2 notes).
function opt<T>(obj: Record<string, unknown>, camelField: string, snakeField: string): T | null {
  const present = obj[`_${camelField}`] !== undefined || obj[`_${snakeField}`] !== undefined;
  return present ? (obj[camelField] as T) : null;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// This app's canonical symbol for an NSE/BSE name carries the Yahoo-style
// suffix (e.g. "RELIANCE.NS") everywhere outside this file — jugaad-rpc
// itself takes the bare NSE symbol, so every function below strips it on
// the way in and restores the original (suffixed) form on the way out,
// the same convention stooq.ts already uses for its own ".us" suffix.
function bareSymbol(symbol: string): string {
  return symbol.replace(/\.(NS|BO)$/i, "");
}

// ---- live stock quote ----

export async function quote(symbol: string): Promise<Quote> {
  const q = await call<{ symbol: string }, Record<string, any>>("getStockQuote", { symbol: bareSymbol(symbol) });
  const bestLevel = q.orderBook?.levels?.[0];
  return {
    symbol,
    name: q.companyName || null,
    price: q.lastPrice,
    change: q.change,
    changePercent: q.percentChange,
    open: q.open,
    high: q.dayHigh,
    low: q.dayLow,
    previousClose: q.previousClose,
    bid: bestLevel ? bestLevel.buyPrice : null,
    ask: bestLevel ? bestLevel.sellPrice : null,
    volume: num(q.totalTradedVolume),
    avgVolume: null,
    marketCap: opt<number>(q, "totalMarketCap", "total_market_cap"),
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: q.yearHigh,
    week52Low: q.yearLow,
    beta: null,
    sharesOutstanding: null,
    currency: "INR",
    exchange: "NSE",
    marketState: null,
    time: null,
    source: "jugaad-rpc",
  };
}

// ---- stock history ----

const RANGE_DAYS: Record<string, number> = {
  "1D": 5, "5D": 10, "1M": 35, "6M": 190, YTD: 400, "1Y": 400, "5Y": 1900, MAX: 7300,
};

export async function history(symbol: string, rangeKey: string): Promise<Candle[]> {
  const days = RANGE_DAYS[rangeKey] ?? 190;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const res = await call<{ symbol: string; fromDate: string; toDate: string; series?: string }, { rows: any[] }>(
    "getStockHistory",
    { symbol: bareSymbol(symbol), fromDate: fmtDate(from), toDate: fmtDate(to) }
  );
  // "series=ALL" (this RPC's default) can return more than one row per date
  // (e.g. a same-day T0 settlement session alongside the ordinary EQ one —
  // see jugaad-rs's docs/nse-findings.md) — prefer the EQ row per date.
  const byDate = new Map<string, any>();
  for (const r of res.rows ?? []) {
    const existing = byDate.get(r.date);
    if (!existing || r.series === "EQ") byDate.set(r.date, r);
  }
  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      time: Math.floor(new Date(r.date + "T00:00:00Z").getTime() / 1000),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: num(r.volume),
    }));
}

export async function indexHistory(name: string, rangeKey: string): Promise<Candle[]> {
  const days = RANGE_DAYS[rangeKey] ?? 190;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const res = await call<{ name: string; fromDate: string; toDate: string }, { rows: any[] }>(
    "getIndexHistory",
    { name, fromDate: fmtDate(from), toDate: fmtDate(to) }
  );
  return (res.rows ?? [])
    .map((r) => ({
      time: Math.floor(new Date(r.date + "T00:00:00Z").getTime() / 1000),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: 0, // NSE's index history has no volume figure
    }))
    .sort((a, b) => a.time - b.time);
}

// ---- live index snapshot (NIFTY 50 / NIFTY BANK / India VIX / ...) ----

export type IndexSnapshotEntry = {
  category: string;
  name: string;
  symbol: string;
  last: number;
  change: number;
  changePercent: number;
};

export async function indexSnapshot(): Promise<IndexSnapshotEntry[]> {
  const res = await call<Record<string, never>, { rows: any[] }>("getIndexSnapshot", {});
  return (res.rows ?? []).map((r) => ({
    category: r.category,
    name: r.name,
    symbol: r.symbol,
    last: r.last,
    change: r.change,
    changePercent: r.percentChange,
  }));
}

// ---- option chain (index options: NIFTY / BANKNIFTY / FINNIFTY) ----

export type JugaadOptionRow = {
  strike: number | null;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  inTheMoney: boolean;
};

export type JugaadChain = {
  symbol: string;
  underlyingPrice: number | null;
  expirationDates: string[];
  selectedDate: string | null;
  calls: JugaadOptionRow[];
  puts: JugaadOptionRow[];
};

function legToRow(leg: any, strike: number): JugaadOptionRow {
  return {
    strike,
    lastPrice: leg.lastPrice,
    bid: leg.buyPrice,
    ask: leg.sellPrice,
    volume: num(leg.totalTradedVolume),
    openInterest: num(leg.openInterest),
    // NSE reports IV as a percentage number (e.g. 15.23), unlike this app's
    // usual fraction convention (0.1523, matching Yahoo's raw value) — /100
    // normalizes it, but this isn't verified against a live response yet.
    impliedVolatility: leg.impliedVolatility ? leg.impliedVolatility / 100 : null,
    inTheMoney: false, // filled in by the caller, which knows the underlying price
  };
}

/**
 * Every available expiry date for a symbol's option chain, nearest first.
 * Falls back to an empty list (never throws) if the running jugaad-rpc
 * predates this RPC — optionChain() below still works fine with just the
 * one expiry it resolves itself in that case.
 */
export async function optionExpiries(symbol: string, kind: "index" | "equity"): Promise<string[]> {
  const reqSymbol = kind === "equity" ? bareSymbol(symbol) : symbol;
  try {
    const res = await call<{ symbol: string }, { expiries: string[] }>("getOptionExpiries", { symbol: reqSymbol });
    return res.expiries ?? [];
  } catch {
    return [];
  }
}

export async function optionChain(
  symbol: string,
  kind: "index" | "equity",
  expiry?: string
): Promise<JugaadChain> {
  const req: Record<string, unknown> = {
    symbol: kind === "equity" ? bareSymbol(symbol) : symbol,
    kind: kind === "equity" ? "OPTION_CHAIN_KIND_EQUITY" : "OPTION_CHAIN_KIND_INDEX",
  };
  if (expiry) req.expiry = expiry;
  const [res, expiries] = await Promise.all([
    call<typeof req, { rows: any[] }>("getOptionChain", req),
    optionExpiries(symbol, kind),
  ]);
  const rows = res.rows ?? [];

  let underlyingPrice: number | null = null;
  for (const r of rows) {
    if (r.call?.underlyingValue) { underlyingPrice = r.call.underlyingValue; break; }
    if (r.put?.underlyingValue) { underlyingPrice = r.put.underlyingValue; break; }
  }

  const calls: JugaadOptionRow[] = [];
  const puts: JugaadOptionRow[] = [];
  for (const r of rows) {
    const strike = r.strikePrice;
    if (r.call) calls.push({ ...legToRow(r.call, strike), inTheMoney: underlyingPrice !== null && strike < underlyingPrice });
    if (r.put) puts.push({ ...legToRow(r.put, strike), inTheMoney: underlyingPrice !== null && strike > underlyingPrice });
  }

  const selectedDate = rows[0]?.expiry ?? expiry ?? null;
  return {
    symbol,
    underlyingPrice,
    expirationDates: expiries.length > 0 ? expiries : selectedDate ? [selectedDate] : [],
    selectedDate,
    calls,
    puts,
  };
}

// ---- large deals: bulk/short/block (short-volume widget's NSE analogue) ----

export type LargeDeal = {
  dealType: "bulk" | "short" | "block" | string;
  symbol: string;
  companyName: string;
  clientName: string | null;
  buySell: string | null;
  quantity: number;
  weightedAvgPrice: number | null;
  remarks: string | null;
  date: string;
};

export async function largeDeals(): Promise<LargeDeal[]> {
  const res = await call<Record<string, never>, { rows: any[] }>("getLargeDeals", {});
  return (res.rows ?? []).map((r) => ({
    dealType: r.dealType,
    symbol: r.symbol,
    companyName: r.companyName,
    clientName: opt<string>(r, "clientName", "client_name"),
    buySell: opt<string>(r, "buySell", "buy_sell"),
    quantity: num(r.quantity),
    weightedAvgPrice: opt<number>(r, "weightedAvgPrice", "weighted_avg_price"),
    remarks: opt<string>(r, "remarks", "remarks"),
    date: r.date,
  }));
}

// ---- corporate announcements (best-effort Insider-widget signal — general
// exchange disclosures, not specifically SEBI insider-trading filings; see
// the README roadmap) ----

export type CorporateAnnouncement = {
  symbol: string | null;
  companyName: string;
  category: string;
  description: string;
  announcementTime: string;
  attachmentUrl: string | null;
};

export async function corporateAnnouncements(
  symbol: string,
  days = 90
): Promise<CorporateAnnouncement[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const res = await call<
    { segment: string; symbol: string; fromDate: string; toDate: string },
    { rows: any[] }
  >("getCorporateAnnouncements", {
    segment: "equities",
    symbol: bareSymbol(symbol),
    fromDate: fmtDate(from),
    toDate: fmtDate(to),
  });
  return (res.rows ?? []).map((r) => ({
    symbol: opt<string>(r, "symbol", "symbol"),
    companyName: r.companyName,
    category: r.category,
    description: r.description,
    announcementTime: r.announcementTime,
    attachmentUrl: opt<string>(r, "attachmentUrl", "attachment_url"),
  }));
}

// ---- market status (holiday-aware NSE open/closed) ----

export type MarketSegment = {
  market: string;
  status: string;
  tradeDate: string;
};

export async function marketStatus(): Promise<MarketSegment[]> {
  const res = await call<Record<string, never>, { segments: any[] }>("getMarketStatus", {});
  return (res.segments ?? []).map((s) => ({ market: s.market, status: s.status, tradeDate: s.tradeDate }));
}
