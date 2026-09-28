import { XMLParser } from "fast-xml-parser";

export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
  symbol: string | null;
};

const parser = new XMLParser({ ignoreAttributes: false });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

async function fetchRss(url: string, publisher: string, symbol: string | null): Promise<NewsItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`rss ${res.status} ${url}`);
  const xml = await res.text();
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? [];
  const list = Array.isArray(items) ? items : [items];
  return list
    .filter((i: any) => i?.title && i?.link)
    .map((i: any) => ({
      title: String(i.title),
      link: String(i.link),
      publisher: i.source?.["#text"] ?? publisher,
      publishedAt: i.pubDate ? new Date(i.pubDate).toISOString() : null,
      symbol,
    }));
}

export async function symbolNews(symbol: string, region: "US" | "IN" = "US"): Promise<NewsItem[]> {
  const lang = region === "IN" ? "en-IN" : "en-US";
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=${region}&lang=${lang}`;
  return fetchRss(url, "Yahoo Finance", symbol);
}

export async function topNews(query = "stock market", region: "US" | "IN" = "US"): Promise<NewsItem[]> {
  const hl = region === "IN" ? "en-IN" : "en-US";
  const gl = region === "IN" ? "IN" : "US";
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
  return fetchRss(url, "Google News", null);
}

/** Merge, de-duplicate by normalized title, newest first. */
export function dedupe(lists: NewsItem[][]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of lists.flat()) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}
