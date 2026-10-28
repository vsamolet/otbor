// Отбор: разбор RSS/Atom и правила тем. Общий код для браузера и для сборщика на GitHub Actions.
// В браузере подключается как обычный <script>, на сервере — через import; всё кладётся в globalThis.Otbor.
(function (G) {
  'use strict';

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

  let decEl = null;
  function decodeEnt(s) {
    if (G.__decodeEnt) return G.__decodeEnt(s);
    if (!decEl) decEl = document.createElement('textarea');
    decEl.innerHTML = s; return decEl.value;
  }
  const stripHtml = h => decodeEnt(String(h || '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();

  const cleanLink = u => {
    try {
      const x = new URL(u);
      [...x.searchParams.keys()].forEach(k => { if (/^(utm_|from$|ref$|rss$|yclid|fbclid)/i.test(k)) x.searchParams.delete(k); });
      x.hash = ''; return x.href;
    } catch (e) { return u; }
  };

  /* ---- кодировки: UTF-8, иначе то, что объявлено в файле (обычно windows-1251) ---- */
  function decodeBuf(buf, ct) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
    const head = new TextDecoder('windows-1252').decode(buf.slice(0, 1024));
    const m = head.match(/encoding=["']([\w-]+)["']/i) || head.match(/charset=["']?([\w-]+)/i) || String(ct || '').match(/charset=([\w-]+)/i);
    let cs = m ? m[1] : 'windows-1251';
    if (/utf-?8/i.test(cs)) cs = 'windows-1251';
    try { return new TextDecoder(cs).decode(buf); } catch (e) { return new TextDecoder('windows-1251').decode(buf); }
  }

  /* ---- разбор лент ---- */
  const IMG_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
  const XML_ENT = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
  function fixXml(t) {
    return String(t).replace(/^﻿?\s+/, '')
      .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => XML_ENT.has(n.toLowerCase()) ? m : decodeEnt(m).replace(/&/g, '&amp;').replace(/</g, '&lt;'))
      .replace(/&(?!#?[a-z0-9]+;)/gi, '&amp;');
  }
  const tname = el => String(el.tagName || '').toLowerCase();
  const tag = (el, ...names) => { for (const n of names) for (const c of el.children) if (tname(c) === n) return c; return null; };
  const txt = (el, ...names) => { const c = tag(el, ...names); return c ? c.textContent.trim() : ''; };

  function findImage(el, html) {
    const all = [...el.querySelectorAll('*')];
    for (const c of all) {
      const tn = tname(c), type = (c.getAttribute('type') || '').toLowerCase();
      const url = c.getAttribute('url') || c.getAttribute('href') || '';
      if (tn === 'enclosure' && url && (type.startsWith('image') || IMG_RE.test(url))) return url;
      if ((tn === 'media:content' || tn === 'media:thumbnail') && url &&
          (!type || type.startsWith('image') || c.getAttribute('medium') === 'image' || IMG_RE.test(url))) return url;
    }
    for (const c of all) {
      if (!c.children.length) { const t = c.textContent.trim(); if (/^https?:\/\/\S+$/.test(t) && IMG_RE.test(t)) return t; }
    }
    const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
    return m ? decodeEnt(m[1]) : '';
  }

  function parseFeed(text, base) {
    let doc;
    try { doc = new G.DOMParser().parseFromString(fixXml(text), 'text/xml'); } catch (e) { return null; }
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return null;
    const root = tname(doc.documentElement).replace(/^.*:/, '');
    const abs = u => { try { return new URL(u, base).href; } catch (e) { return u; } };
    const out = [];
    if (root === 'rss' || root === 'rdf') {
      const ch = doc.getElementsByTagName('channel')[0];
      const title = ch ? txt(ch, 'title') : '';
      for (const it of [...doc.getElementsByTagName('item')]) {
        const html = txt(it, 'content:encoded') || txt(it, 'description', 'yandex:full-text');
        let link = txt(it, 'link');
        if (!link) { const g = tag(it, 'guid'); if (g && /^https?:/.test(g.textContent.trim())) link = g.textContent.trim(); }
        out.push({ title: stripHtml(txt(it, 'title')), link: abs(link), html,
          date: txt(it, 'pubdate', 'dc:date', 'published', 'updated'), img: findImage(it, html) });
      }
      return { title, items: out };
    }
    if (root === 'feed') {
      const title = txt(doc.documentElement, 'title');
      for (const it of [...doc.getElementsByTagName('entry')]) {
        const links = [...it.children].filter(c => tname(c) === 'link');
        const l = links.find(x => (x.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
        const html = txt(it, 'content') || txt(it, 'summary', 'media:group');
        out.push({ title: stripHtml(txt(it, 'title')), link: abs(l ? l.getAttribute('href') : ''), html,
          date: txt(it, 'published', 'updated'), img: findImage(it, html) });
      }
      return { title, items: out };
    }
    return null;
  }

  // Адреса RSS, объявленные на HTML-странице, плюс типовые варианты
  function feedCandidates(html, base) {
    const out = [];
    const re = /<link\b[^>]*>/gi; let m;
    while ((m = re.exec(String(html)))) {
      const t = m[0];
      if (!/rel=["'][^"']*alternate/i.test(t) || !/type=["'][^"']*(rss|atom|xml)/i.test(t)) continue;
      const h = t.match(/href=["']([^"']+)["']/i);
      if (h) { try { out.push(new URL(decodeEnt(h[1]), base).href); } catch (e) {} }
    }
    try { const o = new URL(base).origin; out.push(o + '/feed/', o + '/rss/', o + '/rss.xml', o + '/feed.xml'); } catch (e) {}
    return [...new Set(out)];
  }

  /* ---- правила тем ----
     «девелоп» — начало слова (найдёт «девелопер», «девелопмента»);
     короткие слова (до 3 букв) и слова с «!» в конце — целиком;
     аббревиатуры из заглавных (ИИ, PR, IT, LLM) — с учётом регистра, чтобы английское «it» не считалось за IT;
     фраза «элитн жиль» найдёт «элитное жильё». */
  const normLow = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
  const normCase = s => String(s ?? '').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const SEP = '[\\p{L}\\p{N}-]*[\\s\\u00a0]+';
  function compileWords(str) {
    const parts = String(str || '').split(/[,;\n]+/).map(s => normCase(s).trim()).filter(Boolean);
    const ci = [], cs = [];
    for (let p of parts) {
      let exact = p.endsWith('!'); if (exact) p = p.slice(0, -1).trim();
      if (!p) continue;
      const caps = (p.match(/\p{Lu}/gu) || []).length >= 2;
      const words = (caps ? p : p.toLowerCase()).split(/\s+/).map(escRe);
      const body = words.join(SEP);
      if (caps) { cs.push(body + (exact ? '(?![\\p{L}\\p{N}])' : '(?![\\p{Lu}\\p{N}])')); continue; }
      if (!exact && words.length === 1 && p.length <= 3) exact = true;
      ci.push(exact ? body + '(?![\\p{L}\\p{N}])' : body);
    }
    const mk = (list, fl) => { if (!list.length) return null; try { return new RegExp('(?<![\\p{L}\\p{N}])(?:' + list.join('|') + ')', fl); } catch (e) { return null; } };
    const reCi = mk(ci, 'u'), reCs = mk(cs, 'u');
    if (!reCi && !reCs) return null;
    return { test: t => !!((reCi && reCi.test(normLow(t))) || (reCs && reCs.test(normCase(t)))) };
  }

  G.Otbor = { hostOf, hash, decodeEnt, stripHtml, cleanLink, decodeBuf, parseFeed, feedCandidates, compileWords, IMG_RE };
})(typeof globalThis !== 'undefined' ? globalThis : window);
