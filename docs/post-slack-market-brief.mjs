#!/usr/bin/env node
/**
 * market-brief-news.json を要約して Slack Incoming Webhook に POST する。
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

let md = `*ECモーニングブリーフ*（取得 ${fetched} JST）\n\n`;
md += `*【M&A】*（NewsAPI）\n${maLines.length ? maLines.join("\n") : "—"}\n\n`;
md += `*【IPO】*（NewsAPI）\n${ipoLines.length ? ipoLines.join("\n") : "—"}\n\n`;
md += `*【世界経済】*（Yahoo!ニュース RSS）\n${worldLines.length ? worldLines.join("\n") : "—"}\n`;
md += `\n*マーケットブリーフ:* ${link(MARKET_BRIEF_URL, MARKET_BRIEF_URL)}`;
if (
  briefUrl &&
  normalizeUrl(briefUrl) !== normalizeUrl(MARKET_BRIEF_URL)
) {
  md += `\n<${briefUrl}|ブラウザで一覧を開く>`;
}
md += `\n_投資助言ではありません。各リンク先の利用条件に従ってください。_`;

const payload = {
  text: `ECモーニングブリーフ ${fetched}`, // 通知プレビュー用フォールバック
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: md.slice(0, 2900),
      },
    },
  ],
};

if (md.length > 2900) {
  payload.blocks[0].text.text =
    md.slice(0, 2800) + "\n…（文字数制限のため省略）";
}

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
