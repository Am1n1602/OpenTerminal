export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
}

export type Quote = {
  symbol: string;
  name: string | null;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  avgVolume: number | null;
  marketCap: number | null;
  pe: number | null;
  eps: number | null;
  dividendYield: number | null;
  week52High: number | null;
  week52Low: number | null;
  beta: number | null;
  sharesOutstanding: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  source: string;
  sector?: string;
  label?: string;
};

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtBig(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pctClass(n: number | null | undefined): string {
  if (n === null || n === undefined) return "dim";
  return n >= 0 ? "up" : "down";
}

// ---- India-tuned formatting: Indian digit grouping (12,34,567) and
// Lakh/Crore magnitude suffixes, used for INR-denominated quotes alongside
// the existing US-style fmt/fmtBig used for USD ones. ----

export function fmtINR(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Lakh/Crore-suffixed magnitude, Indian convention (1 Cr = 1e7, 1 L = 1e5). */
export function fmtBigINR(n: number | null | undefined): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
  if (abs >= 1e5) return (n / 1e5).toFixed(2) + " L";
  if (abs >= 1e3) return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return String(n);
}

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥" };

export function currencySymbol(currency?: string | null): string {
  return CURRENCY_SYMBOL[currency ?? ""] ?? "";
}

/** A .NS/.BO-suffixed symbol is NSE/BSE-listed (INR) under this app's symbol convention. */
export function isIndianSymbol(symbol: string): boolean {
  return /\.(NS|BO)$/i.test(symbol);
}

/** A per-share/index price, currency-prefixed and grouped per the quote's own currency. */
export function fmtPrice(n: number | null | undefined, currency?: string | null, digits = 2): string {
  const val = currency === "INR" ? fmtINR(n, digits) : fmt(n, digits);
  return val === "—" ? val : `${currencySymbol(currency)}${val}`;
}

/** A large money amount (market cap, position value), currency-prefixed with the right magnitude suffix. */
export function fmtMoney(n: number | null | undefined, currency?: string | null): string {
  const val = currency === "INR" ? fmtBigINR(n) : fmtBig(n);
  return val === "—" ? val : `${currencySymbol(currency)}${val}`;
}

/** A plain count (volume, shares outstanding) — no currency symbol, but still Cr/L-scaled for INR quotes. */
export function fmtCount(n: number | null | undefined, currency?: string | null): string {
  return currency === "INR" ? fmtBigINR(n) : fmtBig(n);
}
