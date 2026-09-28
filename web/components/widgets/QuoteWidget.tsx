"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtCount, fmtMoney, fmtPrice, isIndianSymbol, pctClass, type Quote } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import Flash from "../Flash";

type ShortVolume = { date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortVolumePercent: number };
type LargeDeal = { dealType: string; quantity: number; weightedAvgPrice: number | null; buySell: string | null; date: string };

function summarizeLargeDeals(deals: LargeDeal[] | undefined): string {
  if (!deals || deals.length === 0) return "—";
  const counts = new Map<string, number>();
  for (const d of deals) counts.set(d.dealType, (counts.get(d.dealType) ?? 0) + 1);
  const parts = [...counts.entries()].map(([type, n]) => `${n} ${type}`).join(", ");
  return `${deals.length} (${parts})`;
}

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const isIndia = isIndianSymbol(symbol);
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${symbol}`))[0],
    refetchInterval: 1_000,
  });
  // FINRA's Reg SHO file only updates once a day (next-morning), so no point polling it fast.
  const { data: shortVol } = useQuery({
    queryKey: ["short-volume", symbol],
    queryFn: () => apiGet<ShortVolume | null>(`/api/short-volume/${symbol}`),
    enabled: !isIndia,
    staleTime: 3_600_000,
  });
  // NSE's bulk/short/block deals feed — best-effort India equivalent of the
  // FINRA row above, via jugaad-rpc (see README roadmap).
  const { data: largeDeals } = useQuery({
    queryKey: ["large-deals", symbol],
    queryFn: () => apiGet<LargeDeal[]>(`/api/large-deals/${symbol}`),
    enabled: isIndia,
    staleTime: 15 * 60_000,
  });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!data) return <div className="p-2 dim">Loading {symbol}…</div>;

  const rows: Array<[string, string, string?]> = [
    ["Open", fmtPrice(data.open, data.currency)],
    ["High", fmtPrice(data.high, data.currency)],
    ["Low", fmtPrice(data.low, data.currency)],
    ["Prev Close", fmtPrice(data.previousClose, data.currency)],
    ["Bid", fmtPrice(data.bid, data.currency)],
    ["Ask", fmtPrice(data.ask, data.currency)],
    ["Volume", fmtCount(data.volume, data.currency)],
    ["Avg Vol 3M", fmtCount(data.avgVolume, data.currency)],
    ...(shortVol ? ([["Short Vol %", fmt(shortVol.shortVolumePercent, 1) + "%"]] as Array<[string, string]>) : []),
    ...(isIndia ? ([["Large Deals (Today)", summarizeLargeDeals(largeDeals)]] as Array<[string, string]>) : []),
    ["Mkt Cap", fmtMoney(data.marketCap, data.currency)],
    ["P/E (ttm)", fmt(data.pe)],
    ["EPS (ttm)", fmtPrice(data.eps, data.currency)],
    ["Div Yield", data.dividendYield !== null ? fmt(data.dividendYield * 100) + "%" : "—"],
    ["52W High", fmtPrice(data.week52High, data.currency)],
    ["52W Low", fmtPrice(data.week52Low, data.currency)],
    ["Beta", fmt(data.beta)],
    ["Shares Out", fmtCount(data.sharesOutstanding, data.currency)],
  ];

  return (
    <div className="p-2">
      <div className="flex items-baseline gap-3 mb-1">
        <Flash value={data.price} className="text-xl font-bold">{fmtPrice(data.price, data.currency)}</Flash>
        <Flash value={data.changePercent} className={`${pctClass(data.changePercent)} text-sm`}>
          {data.change !== null && data.change >= 0 ? "+" : ""}
          {fmtPrice(data.change, data.currency)} ({fmt(data.changePercent)}%)
        </Flash>
        <span className="dim text-[10px] ml-auto">
          {data.exchange ?? ""} · {data.currency ?? ""} · {data.source}
        </span>
      </div>
      <div className="dim text-[11px] mb-2 truncate">{data.name}</div>
      <div className="grid grid-cols-2 gap-x-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-[#161616] py-0.5">
            <span className="dim">{label}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
