// Сборщик ленты. Запускается в GitHub Actions каждые 20 минут:
// скачивает все источники из config.json, разбирает и кладёт результат в _site/feed.json
// вместе с файлами приложения. Телефон потом забирает один готовый файл со своего же сайта.
import { DOMParser } from 'linkedom';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const he = createRequire(import.meta.url)('he');
globalThis.DOMParser = DOMParser;
globalThis.__decodeEnt = s => he.decode(String(s));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await import(path.join(ROOT, 'parse.js'));
const { parseFeed, feedCandidates, decodeBuf, stripHtml, hash } = globalThis.Otbor;

const OUT = path.join(ROOT, '_site');
const MAX_ITEMS = 40, MAX_AGE_DAYS = 7, TIMEOUT = 20000, PARALLEL = 8;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const config = JSON.parse(await fs.readFile(process.env.OTBOR_CONFIG || path.join(ROOT, 'config.json'), 'utf8'));

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: {
      'User-Agent': UA,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
    }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return decodeBuf(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'таймаут' : (e.message || String(e)));
  } finally { clearTimeout(t); }
}

async function load(src) {
  let firstErr;
  try {
    const f = parseFeed(await get(src.url), src.url);
    if (f && f.items.length) return { feed: f, via: src.url };
    firstErr = new Error('не RSS или пустая лента');
  } catch (e) { firstErr = e; }
  // запасной путь: найти RSS на странице сайта
  if (src.site) {
    try {
      const html = await get(src.site);
      for (const cand of feedCandidates(html, src.site).filter(u => u !== src.url).slice(0, 6)) {
        try {
          const f = parseFeed(await get(cand), cand);
          if (f && f.items.length) return { feed: f, via: cand };
        } catch (e) {}
      }
    } catch (e) {}
  }
  throw firstErr;
}

const cut = Date.now() - MAX_AGE_DAYS * 864e5;
const feeds = {};
const queue = [...config.sources];
let okCount = 0;

await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (queue.length) {
    const src = queue.shift();
    const started = Date.now();
    try {
      const { feed, via } = await load(src);
      const items = feed.items
        .filter(it => it.title && it.link)
        .map(it => {
          let ts = Date.parse(it.date);
          if (!ts || ts > Date.now() + 3600e3) ts = 0;
          return { title: it.title.slice(0, 300), link: it.link, html: stripHtml(it.html).slice(0, 400),
                   date: ts ? new Date(ts).toISOString() : '', img: it.img || '' };
        })
        .filter(it => !it.date || Date.parse(it.date) >= cut)
        .slice(0, MAX_ITEMS);
      feeds[src.url] = { ok: true, title: feed.title || '', via, items };
      okCount++;
      console.log(`✓ ${src.name.padEnd(22)} ${String(items.length).padStart(3)}  ${Date.now() - started} мс${via !== src.url ? '  → ' + via : ''}`);
    } catch (e) {
      feeds[src.url] = { ok: false, err: e.message || String(e), items: [] };
      console.log(`✗ ${src.name.padEnd(22)} ${e.message}`);
    }
  }
}));

// приложение + данные
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
for (const f of ['index.html', 'parse.js', 'sw.js', 'manifest.webmanifest', 'config.json',
                 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
  await fs.copyFile(path.join(ROOT, f), path.join(OUT, f));
}
await fs.writeFile(path.join(OUT, '.nojekyll'), '');
const payload = {
  updated: new Date().toISOString(),
  topics: config.topics,
  block: config.block,
  sources: config.sources.map(s => ({ id: hash(s.url), name: s.name, url: s.url, mode: s.mode, topic: s.topic || '' })),
  feeds
};
await fs.writeFile(path.join(OUT, 'feed.json'), JSON.stringify(payload));
console.log(`\nГотово: ${okCount} из ${config.sources.length} источников, feed.json ${(JSON.stringify(payload).length / 1024).toFixed(0)} КБ`);
