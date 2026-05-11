#!/usr/bin/env node
/**
 * market-brief-news.json を要約して Slack Incoming Webhook に POST する。
 * メイン本文は長い場合のみ最初の section で省略。マーケットブリーフリンクは別 section で常に全文表示。
 *
 * 環境変数:
 *   SLACK_WEBHOOK_URL  … 必須（未設定の場合は何もせず exit 0）
 *   BRIEF_PAGE_URL     … 任意（追加の一覧URL。マーケットブリーフ固定URLと異なるときだけ本文に「詳細」リンク）
 *
 * https://api.slack.com/messaging/webhooks
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "market-brief-news.json");

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.log("SLACK_WEBHOOK_URL 未設定のため Slack 投稿をスキップ");
  process.exit(0);
}

const raw = fs.readFileSync(JSON_PATH, "utf8");
const data = JSON.parse(raw);
const briefUrl = process.env.BRIEF_PAGE_URL || "";

/** 市場デイリーアップデート（HTML）。Slack 本文に常に載せる */
const MARKET_BRIEF_URL =
  "https://junya-fujii-komineko.surge.sh/market-brief.html";

function normalizeUrl(u) {
  return String(u || "")
    .trim()
    .replace(/\/+$/, "");
}

function link(url, title) {
  if (!url) return title;
  return `<${url}|${title.replace(/[<>]/g, "")}>`;
}

const maLines =
  (data.ma || []).slice(0, 8).map((a, i) => {
    const t = a.title || "(無題)";
    const mk =
      a.maMarket === "jp" ? " _JP_" : a.maMarket === "us" ? " _US_" : "";
    return `${i + 1}. ${link(a.url, t)}${mk}${a.source ? ` _${a.source}_` : ""}`;
  }) || [];

const worldLines =
  (data.world || []).slice(0, 10).map((a, i) => {
    const t = a.title || "(無題)";
    return `${i + 1}. ${link(a.url, t)}`;
  }) || [];

const ipoLines =
  (data.ipo || []).slice(0, 8).map((a, i) => {
    const t = a.title || "(無題)";
    const mk =
      a.ipoMarket === "jp" ? " _JP_" : a.ipoMarket === "us" ? " _US_" : "";
    return `${i + 1}. ${link(a.url, t)}${mk}${a.source ? ` _${a.source}_` : ""}`;
  }) || [];

const fetched = data.fetchedAt
  ? new Date(data.fetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
  : "—";

/** メイン section の mrkdwn は最大 3000 文字（Slack 制限） */
const MAIN_SECTION_MAX = 2900;

function truncateMainMrkdwn(s) {
  if (s.length <= MAIN_SECTION_MAX) return s;
  const tail = "\n…（文字数制限のため省略）";
  return s.slice(0, MAIN_SECTION_MAX - tail.length) + tail;
}

let mdMain = `*ECモーニングブリーフ*（取得 ${fetched} JST）\n\n`;
mdMain += `*【M&A】*（NewsAPI）\n${maLines.length ? maLines.join("\n") : "—"}\n\n`;
mdMain += `*【IPO】*（NewsAPI）\n${ipoLines.length ? ipoLines.join("\n") : "—"}\n\n`;
mdMain += `*【世界経済】*（Yahoo!ニュース RSS）\n${worldLines.length ? worldLines.join("\n") : "—"}\n`;

let mdMarketBrief = `*マーケットブリーフ:* ${link(MARKET_BRIEF_URL, MARKET_BRIEF_URL)}`;
if (
  briefUrl &&
  normalizeUrl(briefUrl) !== normalizeUrl(MARKET_BRIEF_URL)
) {
  mdMarketBrief += `\n${link(briefUrl, "ブラウザで一覧を開く")}`;
}

const mdDisclaimer =
  "_投資助言ではありません。各リンク先の利用条件に従ってください。_";

const payload = {
  text:
    `ECモーニングブリーフ ${fetched} ／ ${MARKET_BRIEF_URL}`,
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncateMainMrkdwn(mdMain),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: mdMarketBrief,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: mdDisclaimer,
      },
    },
  ],
};

const res = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const t = await res.text();
  console.error("Slack webhook error:", res.status, t);
  process.exit(1);
}
console.log("Slack 投稿 OK");
