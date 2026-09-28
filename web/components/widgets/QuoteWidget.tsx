"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtCount, fmtMoney, fmtPrice, pctClass, type Quote } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import Flash from "../Flash";

type ShortVolume = { date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortVolumePercent: number };

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${symbol}`))[0],
    refetchInterval: 1_000,
  });
  // FINRA's Reg SHO file only updates once a day (next-morning), so no point polling it fast.
  const { data: shortVol } = useQuery({
    queryKey: ["short-volume", symbol],
    queryFn: () => apiGet<ShortVolume | null>(`/api/short-volume/${symbol}`),
    staleTime: 3_600_000,
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
