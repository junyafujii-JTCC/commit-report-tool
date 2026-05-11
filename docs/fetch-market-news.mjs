#!/usr/bin/env node
/**
 * M&A / IPO: NewsAPI — 日英別取得・各プール同一 source は最大1件・各最大4件を交互マージ・最終でも同一 source は1件まで（maMarket / ipoMarket）
 * 世界経済: Yahoo!ニュース 公式RSS（国際トピックス＋経済トピックスから海外・マクロ系のみ抽出）
 *
 * 使い方:
 *   $env:NEWS_API_KEY="..."; node docs/fetch-market-news.mjs
 *
 * Yahoo RSS 一覧: https://news.yahoo.co.jp/rss
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "market-brief-news.json");

const key = process.env.NEWS_API_KEY || process.env.NEWSAPI_ORG_KEY;
if (!key) {
  console.error("NEWS_API_KEY を環境変数に設定してください（登録: https://newsapi.org/register）");
  process.exit(1);
}

/** Yahoo!ニュース 公式 RSS（topics） */
const YAHOO_RSS_WORLD = "https://news.yahoo.co.jp/rss/topics/world.xml";
const YAHOO_RSS_BUSINESS = "https://news.yahoo.co.jp/rss/topics/business.xml";

/** 経済RSSのうち「世界経済・海外マクロ」に寄せる見出しフィルタ（コラム相当はトピックスに混在するため） */
const WORLD_ECON_TITLE =
  /世界経済|国際金融|海外|米国|米\s|中国|欧州|欧\s|中東|FRB|IMF|世界銀行|ECB|利上げ|利下げ|政策金利|為替|ドル円|円安|円高|ユーロ|ウォール街|ナスダック|S&P|WTI|原油|インフレ|景気後退|GDP|貿易摩擦|関税|越境|グローバル|サミット|G7|G20/i;

function fromDateIso() {
  const d = new Date(Date.now() - 7 * 864e5);
  return d.toISOString().slice(0, 10);
}

async function fetchEverything(q, lang, pageSize) {
  const u = new URL("https://newsapi.org/v2/everything");
  u.searchParams.set("q", q);
  u.searchParams.set("language", lang);
  u.searchParams.set("sortBy", "publishedAt");
  u.searchParams.set("pageSize", String(pageSize));
  u.searchParams.set("from", fromDateIso());
  u.searchParams.set("apiKey", key);

  const res = await fetch(u);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NewsAPI ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

function pickArticles(data) {
  return (data.articles || []).filter((a) => a.title && a.title !== "[Removed]");
}

function strip(a) {
  const src =
    typeof a.source === "string"
      ? a.source
      : a.source && typeof a.source === "object" && a.source.name
        ? a.source.name
        : "";
  return {
    title: a.title,
    url: a.url,
    source: src,
    publishedAt: a.publishedAt,
    description: (a.description || "").replace(/\s+/g, " ").trim(),
  };
}

/** M&Aらしい記事だけ残す（クエリでヒット後もノイズ除外） */
const MA_POSITIVE =
  /企業買収|買収|子会社化|公開買付|公開買い付け|ＴＯＢ|TOB|M&A|M＆A|M&A\s+deal|買収提案|買収へ|買収する|買収完了|買収価格|敵対的買収|経営統合|事業譲渡|株式譲渡|スピンオフ|吸収合併|会社合併|企業合併|合併|資本提携|資本業務提携|出資比率|出資|merger|acquisitions?|buyout|takeover|tender\s*offer|to\s+acquire|agrees\s+to\s+buy/i;
const MA_NEGATIVE =
  /市町村合併|行政区|選挙|政党|結婚|併殺|併用|合同練習|合併症|校.?合併|駅.?合併|芸能|スキャンダル/i;

function isProbablyMaNews(a) {
  const text = `${a.title || ""}\n${a.description || ""}`;
  if (MA_NEGATIVE.test(text)) return false;
  return MA_POSITIVE.test(text);
}

/** IPO・上場関連の見出し／概要だけ残す */
const IPO_POSITIVE =
  /新規上場|上場承認|上場申請|上場\s*承認|株式\s*上場|上場\s*へ|上場\s*予定|上場に向け|東証[-‐]?(グロース|プライム|スタンダード)|マザーズ|IPO\s*承認|公募\s*価格|新株\s*発行|上場\s*企業|(?:^|[\s（「])IPO(?:[\s）」]|$)|initial\s+public\s+offering|going\s+public|goes\s+public|files?\s+for\s+(?:an\s+)?IPO|stock\s+listing|lists\s+on/i;
const IPO_NEGATIVE =
  /市町村選|参議院選|衆議院選|学校法人|架空|デマ|詐欺|ランキング\s*だけ|おすすめ\s*銘柄\s*10/i;

function isProbablyIpoNews(a) {
  const text = `${a.title || ""}\n${a.description || ""}`;
  if (IPO_NEGATIVE.test(text)) return false;
  return IPO_POSITIVE.test(text);
}

function dedupeByUrl(articles) {
  const seen = new Set();
  const out = [];
  for (const a of articles) {
    const u = (a.url || "").replace(/\?.*$/, "");
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(a);
  }
  return out;
}

/** NewsAPI 記事の source を正規化キーに */
function articleSourceKey(a) {
  const s =
    typeof a.source === "string"
      ? a.source
      : a.source && typeof a.source === "object" && a.source.name
        ? a.source.name
        : "";
  return s.trim().toLowerCase() || "__unknown__";
}

/**
 * URL 重複除去後、同一メディア(source) は新しい順で最大1件まで（全体で最大 maxCount 件）。
 * IPO / M&A で同一ソースの類似記事が並ぶのを防ぐ。
 */
function dedupeUrlThenMaxOnePerSource(articles, maxCount) {
  const byUrl = dedupeByUrl(articles);
  byUrl.sort((a, b) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  });
  const seenSrc = new Set();
  const out = [];
  for (const a of byUrl) {
    const key = articleSourceKey(a);
    if (seenSrc.has(key)) continue;
    seenSrc.add(key);
    out.push(a);
    if (out.length >= maxCount) break;
  }
  return out;
}

/** strip 後の JSON 用: 同一 source は出現順で先頭のみ（日経×2 などを最終リストから除外） */
function dedupeStrippedBySourceInOrder(items, maxTotal) {
  const seenSrc = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.source || "").trim().toLowerCase() || "__unknown__";
    if (seenSrc.has(key)) continue;
    seenSrc.add(key);
    out.push(item);
    if (out.length >= maxTotal) break;
  }
  return out;
}

/**
 * 日本・米国の記事を各プールで「同一 source 最大1件」かつ各最大 maxEach 件にしたうえで交互マージ。
 * マージ後も同一 source が残れば順序優先で1件に絞る（maxTotal まで）。
 * regionKey 例: "maMarket" | "ipoMarket"
 */
function interleaveRegionalNews(jpArticles, usArticles, maxEach, maxTotal, regionKey) {
  const j = dedupeUrlThenMaxOnePerSource(jpArticles, maxEach).map((a) => ({
    ...strip(a),
    [regionKey]: "jp",
  }));
  const u = dedupeUrlThenMaxOnePerSource(usArticles, maxEach).map((a) => ({
    ...strip(a),
    [regionKey]: "us",
  }));
  const merged = [];
  let ji = 0;
  let ui = 0;
  while (merged.length < maxTotal && (ji < j.length || ui < u.length)) {
    if (ji < j.length && merged.length < maxTotal) merged.push(j[ji++]);
    if (ui < u.length && merged.length < maxTotal) merged.push(u[ui++]);
  }
  return dedupeStrippedBySourceInOrder(merged, maxTotal);
}

function extractTag(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`,
    "i",
  );
  const m = block.match(re);
  if (!m) return "";
  return (m[1] ?? m[2] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

/** Yahoo RSS 2.0 の item をパース */
function parseYahooRss(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    if (!title || !link) continue;
    let publishedAt = null;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!Number.isNaN(d.getTime())) publishedAt = d.toISOString();
    }
    items.push({
      title,
      url: link.trim(),
      source: "Yahoo!ニュース",
      publishedAt,
      description: "",
    });
  }
  return items;
}

async function fetchYahooWorldEconomyHeadlines() {
  const [worldXml, bizXml] = await Promise.all([
    fetch(YAHOO_RSS_WORLD).then((r) => r.text()),
    fetch(YAHOO_RSS_BUSINESS).then((r) => r.text()),
  ]);

  const fromWorld = parseYahooRss(worldXml);
  const fromBiz = parseYahooRss(bizXml);

  const econWorld = fromWorld.filter((it) => WORLD_ECON_TITLE.test(it.title));
  const econBiz = fromBiz.filter((it) => WORLD_ECON_TITLE.test(it.title));

  function dedupeMerge(lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
      for (const it of list) {
        const key = it.url.replace(/\?.*$/, "");
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
      }
    }
    merged.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    return merged;
  }

  let merged = dedupeMerge([econBiz, econWorld]);
  if (merged.length < 10) {
    merged = dedupeMerge([econBiz, econWorld, fromWorld]);
  }

  return merged.slice(0, 10).map(strip);
}

async function main() {
  /** 日本 M&A: 買収・合併・TOB・出資・子会社化・経営統合 等 */
  const maQueryJp =
    '("買収" OR "合併" OR TOB OR "ＴＯＢ" OR "出資" OR "子会社化" OR "経営統合" OR "公開買付" OR "公開買い付け" OR "資本提携" OR "資本業務提携" OR "株式譲渡" OR "事業譲渡" OR "企業買収" OR "吸収合併" OR "敵対的買収" OR "M&A" OR "M＆A")';

  /** 米国 M&A */
  const maQueryUs =
    '(acquisition OR merger OR takeover OR buyout OR "M&A deal" OR "M&A" OR "mergers and acquisitions" OR "to acquire" OR "agrees to buy" OR "takeover bid" OR divestiture OR consolidation)';

  /** 日本IPO: 日本語クエリ（IPO・上場・東証 系） */
  const ipoQueryJp =
    '("IPO" OR "新規上場" OR "上場申請" OR "上場承認" OR "株式上場" OR "公募" OR "新株予約") AND ("東証" OR "東京証券取引所" OR "グロース" OR "プライム" OR "スタンダード" OR "マザーズ")';

  /** 米国IPO: 英語クエリ */
  const ipoQueryUs =
    '("IPO" OR "initial public offering" OR listing OR "goes public" OR "stock debut" OR debut) AND (NASDAQ OR NYSE OR "New York Stock Exchange" OR "Wall Street")';

  const rawMaJp = pickArticles(await fetchEverything(maQueryJp, "jp", 40));
  const filteredMaJp = dedupeByUrl(rawMaJp.filter(isProbablyMaNews));

  const rawMaUs = pickArticles(await fetchEverything(maQueryUs, "en", 40));
  const filteredMaUs = dedupeByUrl(rawMaUs.filter(isProbablyMaNews));

  const ma = interleaveRegionalNews(filteredMaJp, filteredMaUs, 4, 8, "maMarket");

  const rawIpoJp = pickArticles(await fetchEverything(ipoQueryJp, "jp", 40));
  const filteredIpoJp = dedupeByUrl(rawIpoJp.filter(isProbablyIpoNews));

  const rawIpoUs = pickArticles(await fetchEverything(ipoQueryUs, "en", 40));
  const filteredIpoUs = dedupeByUrl(rawIpoUs.filter(isProbablyIpoNews));

  const ipo = interleaveRegionalNews(filteredIpoJp, filteredIpoUs, 4, 8, "ipoMarket");

  const world = await fetchYahooWorldEconomyHeadlines();

  const payload = {
    fetchedAt: new Date().toISOString(),
    maProvider: "https://newsapi.org/",
    ipoProvider: "https://newsapi.org/",
    worldProvider: "Yahoo!ニュース RSS（国際＋経済トピックス・見出しフィルタ）",
    worldRss: [YAHOO_RSS_WORLD, YAHOO_RSS_BUSINESS],
    ma,
    ipo,
    world,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log("Wrote", OUT);
  const maJpN = payload.ma.filter((x) => x.maMarket === "jp").length;
  const maUsN = payload.ma.filter((x) => x.maMarket === "us").length;
  const ipoJpN = payload.ipo.filter((x) => x.ipoMarket === "jp").length;
  const ipoUsN = payload.ipo.filter((x) => x.ipoMarket === "us").length;
  console.log(
    "  M&A:",
    payload.ma.length,
    "(jp",
    maJpN,
    "/ us",
    maUsN,
    ") | IPO:",
    payload.ipo.length,
    "(jp",
    ipoJpN,
    "/ us",
    ipoUsN,
    ") | World (Yahoo):",
    payload.world.length,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
