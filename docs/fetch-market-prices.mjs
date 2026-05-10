/**
 * 終値を取得し、基準日から指数化（=100）した series を market-brief-prices.json に書き出す。
 *
 * 運用想定: GitHub Actions などで毎日1回実行。当日の終値は含めず、東京カレンダーの前日までが既定（PRICE_TO_DATE 省略時）。
 *
 * 日本: J-Quants API V2（API Key）— レート制限はプラン別（Free は 5 req/分 目安）
 * 米国: Polygon.io Aggregates（API Key）
 *
 * Secrets / env（GitHub Actions）:
 *   JQUANTS_API_KEY   … J-Quants ダッシュボードの API Key（推奨・V2）
 *   POLYGON_API_KEY   … Polygon API Key
 *
 * 旧 V1 利用者向け（どちらか一方）:
 *   JQUANTS_REFRESH_TOKEN … リフレッシュトークン → ID トークン取得して /v1/prices/daily_quotes
 *
 * 任意:
 *   PRICE_BASE_DATE     … 指数化の起点日 YYYY-MM-DD（既定: 2026-01-01、最初の取引終値を100に）
 *   PRICE_TO_DATE       … 取得終了日 YYYY-MM-DD（既定: 東京カレンダーの前日＝当日の終値は含めない）
 *   JQUANTS_DELAY_MS    … J-Quants 連続リクエスト間隔 ms（既定: 12500 = Free 5/分 目安）
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

const JQUANTS_DELAY_MS = Number(process.env.JQUANTS_DELAY_MS || "12500");
const POLYGON_DELAY_MS = Number(process.env.POLYGON_DELAY_MS || "350");

/** 日経平均に相当するプロキシ: 日経225連動ETF（銘柄コード 1321 → API は 13210） */
const JP_EQUITIES = [
  { id: "nikkei225_etf", label: "日経225連動ETF", code: "13210" },
  { id: "bushiroad", label: "ブシロード", code: "78030" },
  { id: "bandai_namco", label: "バンダイナムコ", code: "78320" },
  { id: "konami", label: "コナミ", code: "97660" },
  { id: "geo", label: "ゲオ", code: "26810" },
  { id: "hardoff", label: "ハードオフ", code: "26740" },
];

/** Polygon: 指数は I: プレフィックス（NASDAQ Composite 等） */
const US_TICKERS = [
  { id: "nasdaq_comp", label: "NASDAQ総合", ticker: "I:COMP" },
  { id: "draftkings", label: "DraftKings", ticker: "DKNG" },
  { id: "evolution", label: "Evolution", ticker: "EVVTY" },
  { id: "amazon", label: "Amazon", ticker: "AMZN" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ymdToJQuants(d) {
  return d.replace(/-/g, "");
}

async function jquantsGetIdToken() {
  const rt = process.env.JQUANTS_REFRESH_TOKEN;
  if (!rt) return null;
  const url = new URL("https://api.jquants.com/v1/token/auth_refresh");
  url.searchParams.set("refreshtoken", rt);
  const r = await fetch(url.toString(), { method: "POST" });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`J-Quants auth_refresh ${r.status}: ${t}`);
  }
  const j = await r.json();
  return j.idToken || null;
}

async function jquantsFetchDailyV2(code, fromYmd, toYmd) {
  const key = process.env.JQUANTS_API_KEY;
  if (!key) throw new Error("JQUANTS_API_KEY missing");
  const headers = { "x-api-key": key };
  let paginationKey = "";
  const rows = [];
  const from = ymdToJQuants(fromYmd);
  const to = ymdToJQuants(toYmd);
  for (;;) {
    const u = new URL("https://api.jquants.com/v2/equities/bars/daily");
    u.searchParams.set("code", code);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (paginationKey) u.searchParams.set("pagination_key", paginationKey);
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`J-Quants v2 equities ${r.status}: ${t}`);
    }
    const j = await r.json();
    const chunk = Array.isArray(j.data) ? j.data : [];
    rows.push(...chunk);
    paginationKey = j.pagination_key || "";
    if (!paginationKey) break;
  }
  return rows;
}

async function jquantsFetchDailyV1(idToken, code, fromYmd, toYmd) {
  let paginationKey = "";
  const rows = [];
  const from = ymdToJQuants(fromYmd);
  const to = ymdToJQuants(toYmd);
  const headers = { Authorization: `Bearer ${idToken}` };
  for (;;) {
    const u = new URL("https://api.jquants.com/v1/prices/daily_quotes");
    u.searchParams.set("code", code);
    u.searchParams.set("from", from);
    u.searchParams.set("to", to);
    if (paginationKey) u.searchParams.set("pagination_key", paginationKey);
    const r = await fetch(u.toString(), { headers });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`J-Quants v1 daily_quotes ${r.status}: ${t}`);
    }
    const j = await r.json();
    const chunk = Array.isArray(j.daily_quotes) ? j.daily_quotes : [];
    rows.push(...chunk);
    paginationKey = j.pagination_key || "";
    if (!paginationKey) break;
  }
  return rows;
}

function closeFromJQuantsRow(row, v2) {
  if (v2) {
    const adj = row.AdjC;
    const raw = row.C;
    if (adj != null && !Number.isNaN(Number(adj))) return Number(adj);
    if (raw != null && !Number.isNaN(Number(raw))) return Number(raw);
    return null;
  }
  const adj = row.AdjustmentClose;
  const raw = row.Close;
  if (adj != null && !Number.isNaN(Number(adj))) return Number(adj);
  if (raw != null && !Number.isNaN(Number(raw))) return Number(raw);
  return null;
}

function normalizeJpRows(rows, v2) {
  const map = new Map();
  for (const row of rows) {
    const d = row.Date;
    if (!d) continue;
    const c = closeFromJQuantsRow(row, v2);
    if (c == null || c <= 0) continue;
    map.set(d, c);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, close]) => ({ d, close }));
}

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
    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Polygon ${ticker} ${r.status}: ${t}`);
    }
    const j = await r.json();
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
  const jpMode = process.env.JQUANTS_API_KEY ? "v2-api-key" : process.env.JQUANTS_REFRESH_TOKEN ? "v1-refresh" : "none";

  let idToken = null;
  if (jpMode === "v1-refresh") {
    try {
      idToken = await jquantsGetIdToken();
      if (!idToken) errors.push({ scope: "jp", message: "J-Quants V1: idToken を取得できませんでした" });
    } catch (e) {
      errors.push({ scope: "jp", message: String(e.message || e) });
    }
  }

  if (jpMode !== "none" && (process.env.JQUANTS_API_KEY || idToken)) {
    const v2 = !!process.env.JQUANTS_API_KEY;
    let i = 0;
    for (const s of JP_EQUITIES) {
      if (i++ > 0) await sleep(JQUANTS_DELAY_MS);
      try {
        const raw = v2
          ? await jquantsFetchDailyV2(s.code, BASE_DATE, TO_DATE)
          : await jquantsFetchDailyV1(idToken, s.code, BASE_DATE, TO_DATE);
        const pts = clipPointsThrough(normalizeJpRows(raw, v2), TO_DATE);
        series.push({
          id: s.id,
          market: "jp",
          label: s.label,
          code: s.code,
          currency: "JPY",
          provider: "j-quants",
          providerMode: jpMode,
          points: rebaseTo100(pts, BASE_DATE),
        });
      } catch (e) {
        errors.push({ scope: "jp", code: s.code, message: String(e.message || e) });
      }
    }
  } else {
    errors.push({
      scope: "jp",
      message:
        "スキップ: JQUANTS_API_KEY または JQUANTS_REFRESH_TOKEN を設定してください（日本株・ETF）",
    });
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
      jp: jpMode === "none" ? null : process.env.JQUANTS_API_KEY ? "j-quants-v2" : "j-quants-v1",
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
