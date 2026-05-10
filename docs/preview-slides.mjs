#!/usr/bin/env node
/**
 * slides-completion-image.html の各 .slide を PNG に分割出力（プレビュー用）
 * Usage: node docs/preview-slides.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'slides-completion-image.html');
const outDir = path.join(__dirname, 'previews');

fs.mkdirSync(outDir, { recursive: true });

const fileUrl = `file:///${htmlPath.split(path.sep).join('/')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const slides = await page.$$('.slide');
  for (let i = 0; i < slides.length; i++) {
    const n = String(i + 1).padStart(2, '0');
    const outPath = path.join(outDir, `slide-${n}.png`);
    await slides[i].screenshot({ path: outPath });
    console.log(outPath);
  }
  console.log(`Done: ${slides.length} slides`);
} finally {
  await browser.close();
}
