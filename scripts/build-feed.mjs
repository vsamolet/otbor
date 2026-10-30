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

async function get(url, retried = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: {
      'User-Agent': UA,
      'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
    }});
    if (res.status === 429 && !retried) {          // Reddit и др. просят подождать
      clearTimeout(t); await new Promise(r => setTimeout(r, 8000)); return get(url, true);
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return decodeBuf(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'таймаут' : (e.message || String(e)));
  } finally { clearTimeout(t); }
}

async function load(src) {
  let firstErr;
  for (const u of [src.url, ...(src.alt || [])]) {   // основной адрес, затем запасные
    try {
      const f = parseFeed(await get(u), u);
      if (f && f.items.length) return { feed: f, via: u };
      firstErr = firstErr || new Error('не RSS или пустая лента');
    } catch (e) { firstErr = firstErr || e; }
  }
  // запасной путь: найти RSS на странице сайта
  if (src.site) {
    try {
      const html = await get(src.site);
      for (const cand of feedCandidates(html, src.site).filter(u => u !== src.url && !(src.alt || []).includes(u)).slice(0, 6)) {
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

// ---- перевод иноязычных заголовков и анонсов: Google Translate (бесплатный веб-адрес, без ключа) ----
// Переводится только новое: готовые переводы берутся из прошлой сборки (prev-feed.json кладёт workflow).
const isForeign = s => {
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length, lat = (s.match(/[A-Za-z]/g) || []).length;
  return lat >= 12 && cyr < lat * 0.1;
};
const prevTr = new Map();
try {
  const prev = JSON.parse(await fs.readFile(process.env.OTBOR_PREV || path.join(ROOT, 'prev-feed.json'), 'utf8'));
  for (const f of Object.values(prev.feeds || {})) for (const it of f.items || [])
    if (it.tTitle) prevTr.set(it.link, { tTitle: it.tTitle, tHtml: it.tHtml || '', lang: it.lang || '' });
} catch (e) {}

// Два адреса Google: пакетный (clients5, до 20 текстов за запрос) и одиночный (gtx) — запасной.
// При 429/5xx ждём и повторяем; если Google упорно отказывает — останавливаемся,
// непереведённое доделает телефон, а следующая сборка попробует снова.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function gfetch(url, opts = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
async function trBatch(texts) {
  const body = texts.map(t => 'q=' + encodeURIComponent(t)).join('&');
  const j = await gfetch('https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=ru', {
    method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
  if (!Array.isArray(j) || j.length !== texts.length) throw new Error('неожиданный ответ');
  return j.map(x => Array.isArray(x) ? { text: String(x[0] || ''), lang: String(x[1] || '') } : { text: String(x || ''), lang: '' });
}
async function trOne(text) {
  const j = await gfetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=' + encodeURIComponent(text));
  return { text: (j[0] || []).map(x => x && x[0] || '').join(''), lang: j[2] || '' };
}
async function withRetry(fn) {
  let err;
  for (const wait of [0, 8000, 25000]) {
    if (wait) await sleep(wait);
    try { return await fn(); } catch (e) { err = e; if (e.status && e.status < 429 && e.status !== 408) break; }
  }
  throw err;
}

const todo = [];
let reused = 0;
for (const f of Object.values(feeds)) for (const it of f.items) {
  if (!isForeign(it.title + ' ' + it.html)) continue;
  const p = prevTr.get(it.link);
  if (p) { Object.assign(it, p); reused++; } else todo.push(it);
}
const srcText = it => (it.title + (it.html ? '\n' + it.html.slice(0, 300) : '')).replace(/\n+/g, m => m.length > 1 ? '\n' : m);
function apply(it, r) {
  if (!r || !r.text || r.lang === 'ru') return false;
  const nl = r.text.indexOf('\n');
  it.tTitle = (nl >= 0 ? r.text.slice(0, nl) : r.text).trim();
  it.tHtml = nl >= 0 ? r.text.slice(nl + 1).trim() : '';
  it.lang = r.lang;
  if (!it.tTitle) { delete it.tTitle; delete it.tHtml; return false; }
  return true;
}
let translated = 0, failedBatches = 0, trErr = '', usedFallback = 0;
const trDeadline = Date.now() + 5 * 60e3;
const pending = todo.slice();
while (pending.length && failedBatches < 3 && Date.now() < trDeadline) {
  const batch = pending.splice(0, 20);
  try {
    const res = await withRetry(() => trBatch(batch.map(srcText)));
    batch.forEach((it, i) => { if (apply(it, res[i])) translated++; });
    failedBatches = 0;
  } catch (e) {
    trErr = 'пакетный: ' + e.message;
    // запасной адрес — по одному
    let ok = 0;
    for (const it of batch) {
      try { if (apply(it, await trOne(srcText(it)))) { translated++; usedFallback++; ok++; } }
      catch (e2) { trErr += '; одиночный: ' + e2.message; break; }
      await sleep(150);
    }
    if (!ok) { failedBatches++; pending.unshift(...batch.filter(it => !it.tTitle)); await sleep(5000); }
  }
  await sleep(300);
}
const left = todo.filter(it => !it.tTitle).length;
console.log(`\nПеревод: новых ${translated}${usedFallback ? ' (запасным адресом ' + usedFallback + ')' : ''}, из прошлой сборки ${reused}, осталось без перевода ${left}${left && trErr ? ' (последняя ошибка: ' + trErr + ')' : ''}`);

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
