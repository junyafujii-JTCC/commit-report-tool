/**
 * 終値を取得し、基準日から指数化（=100）した series を market-brief-prices.json に書き出す。
 *
 * 運用想定: GitHub Actions などで毎日1回実行。当日の終値は含めず、東京カレンダーの前日までが既定（PRICE_TO_DATE 省略時）。
 *
 * 日本: Yahoo Finance chart API（yfinance と同系統の query1.finance.yahoo.com/v8/finance/chart）。API キー不要。
 *   参考: https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1y
 *   本スクリプトは BASE/TO に合わせ period1/period2 で期間指定（range=1y より取りこぼしにくい）。
 * 米国: Polygon.io Aggregates（API Key）
 *
 * Secrets / env（GitHub Actions）:
 *   POLYGON_API_KEY   … Polygon API Key（米国株）
 *
 * 任意:
 *   PRICE_BASE_DATE     … 指数化の起点日 YYYY-MM-DD（既定: 2026-01-01）
 *   PRICE_TO_DATE       … 取得終了日 YYYY-MM-DD（既定: 東京カレンダーの前日）
 *   YAHOO_DELAY_MS      … Yahoo 連続リクエスト間隔 ms（既定: 800）
 *   POLYGON_DELAY_MS    … Polygon 間隔 ms（既定: 350）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "market-brief-prices.json");

const BASE_DATE =
  (process.env.PRICE_BASE_DATE || "").trim() || "2026-01-01";

/** 東京の「今日」の YYYY-MM-DD */
function todayYmdTokyo(d = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** カレンダー日の加算（YYYY-MM-DD） */
function addCalendarDaysYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const u = Date.UTC(y, m - 1, d + deltaDays);
  return new Date(u).toISOString().slice(0, 10);
}

/** 終値の最新日は「前日」まで：既定は東京カレンダーの昨日 */
function defaultPriceToDateTokyo() {
  return addCalendarDaysYmd(todayYmdTokyo(), -1);
}

const TO_DATE =
  (process.env.PRICE_TO_DATE || "").trim() || defaultPriceToDateTokyo();

const YAHOO_CHART_BASE =
  "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_DELAY_MS = Number(process.env.YAHOO_DELAY_MS || "800");
const POLYGON_DELAY_MS = Number(process.env.POLYGON_DELAY_MS || "350");

/** 東証銘柄は Yahoo ティッカー末尾 .T（例: 7203.T） */
const JP_EQUITIES = [
  { id: "nikkei225_etf", label: "日経225連動ETF", yahooTicker: "1321.T" },
  { id: "bushiroad", label: "ブシロード", yahooTicker: "7803.T" },
  { id: "bandai_namco", label: "バンダイナムコ", yahooTicker: "7832.T" },
  { id: "konami", label: "コナミ", yahooTicker: "9766.T" },
  { id: "geo", label: "ゲオ", yahooTicker: "2681.T" },
  { id: "hardoff", label: "ハードオフ", yahooTicker: "2674.T" },
];

/**
 * 米国株・指数（変更しない想定）: Polygon.io のみ。ティッカー・取得ロジックは従来どおり。
 * 日本株のみ Yahoo chart に切り替え済み。
 */
const US_TICKERS = [
  { id: "nasdaq_comp", label: "NASDAQ総合", ticker: "I:COMP" },
  { id: "draftkings", label: "DraftKings", ticker: "DKNG" },
  { id: "evolution", label: "Evolution", ticker: "EVVTY" },
  { id: "amazon", label: "Amazon", ticker: "AMZN" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Yahoo のバー時刻を東京日付 YYYY-MM-DD に */
function tsToYmdTokyo(sec) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(sec * 1000));
}

/**
 * Yahoo Finance v8 chart（日足）。period1/period2 は Unix 秒（UTC）。
 * range=1y の例: …/chart/7203.T?interval=1d&range=1y
 */
async function yahooChartFetchDaily(ticker, fromYmd, toYmd) {
  const period1 = Math.floor(
    new Date(fromYmd + "T00:00:00.000Z").getTime() / 1000
  );
  const period2 = Math.floor(
    new Date(toYmd + "T23:59:59.999Z").getTime() / 1000
  );
  const u = new URL(`${YAHOO_CHART_BASE}/${encodeURIComponent(ticker)}`);
  u.searchParams.set("interval", "1d");
  u.searchParams.set("period1", String(period1));
  u.searchParams.set("period2", String(period2));

  const r = await fetch(u.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; commit-report-tool/1.0; +https://github.com/)",
      Accept: "application/json",
    },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Yahoo chart ${ticker} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text);
  const err = j.chart?.error;
  if (err) {
    throw new Error(
      `Yahoo chart ${ticker}: ${err.description || err.code || JSON.stringify(err)}`
    );
  }
  const result = j.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart ${ticker}: empty result`);
  }
  const ts = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjRow = result.indicators?.adjclose?.[0];
  const adjArr = adjRow && Array.isArray(adjRow.adjclose) ? adjRow.adjclose : null;
  const closesRaw = quote.close;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const sec = ts[i];
    if (sec == null) continue;
    const d = tsToYmdTokyo(sec);
    let c =
      adjArr && adjArr[i] != null && !Number.isNaN(Number(adjArr[i]))
        ? Number(adjArr[i])
        : closesRaw && closesRaw[i] != null && !Number.isNaN(Number(closesRaw[i]))
          ? Number(closesRaw[i])
          : null;
    if (c == null || c <= 0) continue;
    points.push({ d, close: c });
  }
  points.sort((a, b) => a.d.localeCompare(b.d));
  const dedup = new Map();
  for (const p of points) dedup.set(p.d, p.close);
  return [...dedup.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, close]) => ({ d, close }));
}

/** 米国: Polygon 日足（日本株側の変更の影響を受けない） */
async function polygonFetchDaily(ticker, fromYmd, toYmd) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) throw new Error("POLYGON_API_KEY missing");
  const from = fromYmd;
  const to = toYmd;
  let url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(
    ticker
  )}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(
    apiKey
  )}`;
  const points = [];
  for (;;) {
    const res = await fetch(url);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Polygon ${ticker} ${res.status}: ${t}`);
    }
    const j = await res.json();
    const results = j.results || [];
    for (const bar of results) {
      const ms = bar.t;
      const close = bar.c;
      if (ms == null || close == null) continue;
      const d = new Date(ms).toISOString().slice(0, 10);
      points.push({ d, close: Number(close) });
    }
    const next = j.next_url;
    if (!next) break;
    url =
      next.includes("apiKey=") || next.includes("apikey=")
        ? next
        : `${next}${next.includes("?") ? "&" : "?"}apiKey=${encodeURIComponent(apiKey)}`;
  }
  points.sort((a, b) => a.d.localeCompare(b.d));
  const dedup = new Map();
  for (const p of points) dedup.set(p.d, p.close);
  return [...dedup.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, close]) => ({ d, close }));
}

function rebaseTo100(points, baseDateStr) {
  const onOrAfter = points.filter((p) => p.d >= baseDateStr && p.close > 0);
  if (!onOrAfter.length) {
    return points.map((p) => ({ ...p, idx: null }));
  }
  const baseClose = onOrAfter[0].close;
  return points.map((p) => {
    if (p.d < baseDateStr || p.close == null || p.close <= 0) {
      return { ...p, idx: null };
    }
    return { ...p, idx: (p.close / baseClose) * 100 };
  });
}

/** 当日を含めず終値を確定した日まで（rangeTo まで） */
function clipPointsThrough(points, maxYmd) {
  return points.filter((p) => p.d <= maxYmd);
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const errors = [];
  const series = [];

  let i = 0;
  for (const s of JP_EQUITIES) {
    if (i++ > 0) await sleep(YAHOO_DELAY_MS);
    try {
      const pts = clipPointsThrough(
        await yahooChartFetchDaily(s.yahooTicker, BASE_DATE, TO_DATE),
        TO_DATE
      );
      series.push({
        id: s.id,
        market: "jp",
        label: s.label,
        ticker: s.yahooTicker,
        currency: "JPY",
        provider: "yahoo-chart",
        points: rebaseTo100(pts, BASE_DATE),
      });
    } catch (e) {
      errors.push({
        scope: "jp",
        ticker: s.yahooTicker,
        message: String(e.message || e),
      });
    }
  }

  const polyKey = process.env.POLYGON_API_KEY;
  if (polyKey) {
    let j = 0;
    for (const s of US_TICKERS) {
      if (j++ > 0) await sleep(POLYGON_DELAY_MS);
      try {
        const pts = clipPointsThrough(
          await polygonFetchDaily(s.ticker, BASE_DATE, TO_DATE),
          TO_DATE
        );
        series.push({
          id: s.id,
          market: "us",
          label: s.label,
          ticker: s.ticker,
          currency: "USD",
          provider: "polygon",
          points: rebaseTo100(pts, BASE_DATE),
        });
      } catch (e) {
        errors.push({ scope: "us", ticker: s.ticker, message: String(e.message || e) });
      }
    }
  } else {
    errors.push({
      scope: "us",
      message: "スキップ: POLYGON_API_KEY を設定してください（米国株・指数）",
    });
  }

  const baseSeries = series.map((s) => {
    const firstIdx = (s.points || []).find((p) => p.idx != null && p.d >= BASE_DATE);
    return {
      id: s.id,
      baseDateUsed: firstIdx ? firstIdx.d : null,
      baseClose: firstIdx ? s.points.find((p) => p.d === firstIdx.d)?.close ?? null : null,
    };
  });

  const out = {
    fetchedAt,
    baseDateRequested: BASE_DATE,
    rangeTo: TO_DATE,
    closeLatestNote:
      "終値の最新日は東京カレンダーの前日まで（当日バーは含めず、前営業日の終値が最新）",
    indexBaseValue: 100,
    sources: {
      jp: "yahoo-finance-chart-unofficial",
      us: polyKey ? "polygon" : null,
    },
    series,
    baseSeriesMeta: baseSeries,
    errors,
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
  console.log("Wrote", OUT, "series=", series.length, "errors=", errors.length);
  if (errors.length) console.warn(JSON.stringify(errors, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
