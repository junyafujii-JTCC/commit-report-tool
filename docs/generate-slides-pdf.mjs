#!/usr/bin/env node
/**
 * slides-completion-image.html を PDF に出力（16:9 相当・背景色付き）
 * Usage: node docs/generate-slides-pdf.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, 'slides-completion-image.html');
const outPath = path.join(__dirname, 'completion-image-slides.pdf');

const fileUrl = `file:///${htmlPath.split(path.sep).join('/')}`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: 'networkidle' });
  await page.pdf({
    path: outPath,
    printBackground: true,
    preferCSSPageSize: true,
  });
  console.log('Wrote:', outPath);
} finally {
  await browser.close();
}
