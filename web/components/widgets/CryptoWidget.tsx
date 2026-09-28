"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, fmtCount, fmtMoney, fmtPrice, fmt, pctClass } from "../../lib/api";
import Flash from "../Flash";
import { useTerminal } from "../../store/terminal";

type CryptoRow = {
  id: string; symbol: string; name: string; price: number;
  changePercent24h: number | null; marketCap: number | null; volume24h: number | null;
  rank: number | null; sparkline: number[]; currency: string;
};
type GlobalStats = { totalMarketCap: number; btcDominance: number; ethDominance: number; currency: string };

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 60;
  const h = 16;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / (max - min || 1)) * h}`)
    .join(" ");
  const upTrend = data[data.length - 1] >= data[0];
  return (
    <svg width={w} height={h}>
      <polyline points={pts} fill="none" stroke={upTrend ? "#00c853" : "#ff3d3d"} strokeWidth={1} />
    </svg>
  );
}

function priceCell(c: CryptoRow): string {
  const symbol = c.currency === "INR" ? "₹" : "$";
  return c.price >= 1 ? fmtPrice(c.price, c.currency) : symbol + c.price.toPrecision(4);
}

export default function CryptoWidget() {
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [currency, setCurrency] = useState<"usd" | "inr">("usd");
  const { data = [], error } = useQuery({
    queryKey: ["crypto", currency],
    queryFn: () => apiGet<CryptoRow[]>(`/api/crypto?currency=${currency}`),
    refetchInterval: 1_000,
  });
  const { data: global } = useQuery({
    queryKey: ["crypto-global", currency],
    queryFn: () => apiGet<GlobalStats>(`/api/crypto/global?currency=${currency}`),
    refetchInterval: 30_000,
  });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;

  return (
    <div>
      <div className="flex gap-1 p-1">
        {(["usd", "inr"] as const).map((c) => (
          <button key={c} className={`term-btn ${currency === c ? "active" : ""}`} onClick={() => setCurrency(c)}>
            {c.toUpperCase()}
          </button>
        ))}
      </div>
      {global && (
        <div className="flex gap-4 px-2 py-1 border-b border-[var(--border)] dim">
          <span>Total MCap <span className="text-[var(--text)]">{fmtMoney(global.totalMarketCap, global.currency)}</span></span>
          <span>BTC.D <span className="amber">{fmt(global.btcDominance, 1)}%</span></span>
          <span>ETH.D <span className="amber">{fmt(global.ethDominance, 1)}%</span></span>
        </div>
      )}
      <table className="data-table">
        <thead>
          <tr><th>#</th><th>Asset</th><th>Price</th><th>24h%</th><th>MCap</th><th>Vol 24h</th><th>7d</th></tr>
        </thead>
        <tbody>
          {data.map((c) => (
            <tr key={c.id} onClick={() => setActiveSymbol(c.symbol)}>
              <td className="dim">{c.rank ?? "—"}</td>
              <td className="!text-left"><span className="font-bold">{c.symbol}</span> <span className="dim">{c.name}</span></td>
              <td><Flash value={c.price}>{priceCell(c)}</Flash></td>
              <td className={pctClass(c.changePercent24h)}>
                <Flash value={c.changePercent24h}>{fmt(c.changePercent24h)}%</Flash>
              </td>
              <td>{fmtMoney(c.marketCap, c.currency)}</td>
              <td>{fmtCount(c.volume24h, c.currency)}</td>
              <td><Sparkline data={c.sparkline.filter((_, i) => i % 4 === 0)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
