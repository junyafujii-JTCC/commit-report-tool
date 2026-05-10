#!/usr/bin/env node
/**
 * M&A: NewsAPI everything（絞り込みクエリ＋取得後フィルタ）
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

/** M&Aらしい記事だけ残す（「合併」単独などのノイズを落とす） */
const MA_POSITIVE =
  /企業買収|子会社化|公開買付|公開買い付け|ＴＯＢ|TOB|M&A|M＆A|買収提案|買収へ|買収する|買収完了|買収価格|敵対的買収|経営統合|事業譲渡|株式譲渡|スピンオフ|合併.*?会社|吸収合併|merger|acquisition|buyout|takeover|tender\s*offer/i;
const MA_NEGATIVE =
  /市町村合併|行政区|選挙|政党|結婚|併殺|併用|合同練習|合併症|校.?合併|駅.?合併/i;

function isProbablyMaNews(a) {
  const text = `${a.title || ""}\n${a.description || ""}`;
  if (MA_NEGATIVE.test(text)) return false;
  return MA_POSITIVE.test(text);
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
  const maQueryJp =
    '("企業買収" OR "公開買付" OR "公開買い付け" OR TOB OR "M&A" OR "M＆A" OR "敵対的買収" OR "経営統合" OR "事業譲渡" OR "株式譲渡" OR "子会社化" OR buyout OR merger OR acquisition)';

  let rawMa = pickArticles(await fetchEverything(maQueryJp, "jp", 30));
  let ma = rawMa.filter(isProbablyMaNews);

  if (ma.length < 3) {
    const en = pickArticles(
      await fetchEverything(
        '("merger" OR "acquisition" OR "buyout" OR "takeover" OR "to acquire" OR "Tender Offer")',
        "en",
        30,
      ),
    );
    for (const a of en) {
      if (isProbablyMaNews(a)) ma.push(a);
      if (ma.length >= 10) break;
    }
  }

  ma = ma.slice(0, 3).map(strip);

  const world = await fetchYahooWorldEconomyHeadlines();

  const payload = {
    fetchedAt: new Date().toISOString(),
    maProvider: "https://newsapi.org/",
    worldProvider: "Yahoo!ニュース RSS（国際＋経済トピックス・見出しフィルタ）",
    worldRss: [YAHOO_RSS_WORLD, YAHOO_RSS_BUSINESS],
    ma,
    world,
  };

  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log("Wrote", OUT);
  console.log("  M&A articles:", payload.ma.length, "| World (Yahoo):", payload.world.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
