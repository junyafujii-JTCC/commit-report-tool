#!/usr/bin/env node
/**
 * docs/ を http://127.0.0.1:4173 で配信（file:// や日本語パス問題の回避用）
 * Usage: node docs/local-server.mjs
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const PORT = 4173;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (!decoded || decoded.includes('..')) return null;
  const segments = decoded.split(/[/\\]+/).filter(Boolean);
  const resolved = path.resolve(ROOT, ...segments);
  const rootR = path.resolve(ROOT);
  if (resolved !== rootR && !resolved.startsWith(rootR + path.sep)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  let target = safePath(req.url === '/' ? '/index.html' : req.url);
  if (!target) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(err ? 404 : 404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(target).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  const slides = `${base}/slides-completion-image.html`;
  const takiCounter = `${base}/taki-daily-counter.html`;
  console.log('');
  console.log('  ブラウザで次を開いてください:');
  console.log(`    ${base}/`);
  console.log(`    ${slides}`);
  console.log(`    ${takiCounter}`);
  console.log('');
  console.log('  止める: Ctrl+C');
  console.log('');

  const open = process.platform === 'win32'
    ? `start "" "${slides}"`
    : process.platform === 'darwin'
      ? `open "${slides}"`
      : `xdg-open "${slides}"`;

  exec(open, { shell: true }, () => {});
});
