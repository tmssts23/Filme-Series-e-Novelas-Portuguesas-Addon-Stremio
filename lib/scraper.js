const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://novelasportuguesas.com';
const FILMES_ARCHIVE = `${BASE_URL}/filme/`;
const SERIES_ARCHIVE = `${BASE_URL}/serie/`;
const NOVELAS_ARCHIVE = `${BASE_URL}/genero/novelas/`;
const ZETA_API = `${BASE_URL}/wp-json/zetaplayer/v2`;

const LOG_PREFIX = '[NovelasPT]';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36';

const HTTP_TIMEOUT_MS = Math.max(5000, Number(process.env.STREMIO_NP_HTTP_TIMEOUT_MS) || 25000);
const CATALOG_CACHE_MS = Math.max(60000, Number(process.env.STREMIO_NP_CACHE_MS) || 6 * 60 * 60 * 1000);
const META_CACHE_MS = Math.max(60000, Number(process.env.STREMIO_NP_META_CACHE_MS) || CATALOG_CACHE_MS);
const META_TIMEOUT_MS = Math.max(2500, Number(process.env.STREMIO_NP_META_TIMEOUT_MS) || 6000);
const META_RETRIES = Math.max(1, Number(process.env.STREMIO_NP_META_RETRIES) || 1);
const META_MAX_PATHS = Math.max(1, Number(process.env.STREMIO_NP_META_MAX_PATHS) || 3);
const ARCHIVE_MAX_PAGES = Math.max(1, Number(process.env.STREMIO_NP_MAX_ARCHIVE_PAGES) || 500);
const ARCHIVE_CONCURRENCY = Math.max(1, Number(process.env.STREMIO_NP_ARCHIVE_CONCURRENCY) || 10);

const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN']);
const RETRYABLE_STATUS = new Set([403, 429, 502, 503, 504]);

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const client = axios.create({
  baseURL: BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    Referer: `${BASE_URL}/`,
  },
  validateStatus: () => true,
});

const zetaClient = axios.create({
  baseURL: ZETA_API,
  timeout: Math.min(120000, Math.max(12000, HTTP_TIMEOUT_MS)),
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Referer: `${BASE_URL}/`,
  },
  validateStatus: () => true,
});

const cinemetaClient = axios.create({
  baseURL: 'https://v3-cinemeta.strem.io',
  timeout: 9000,
  validateStatus: () => true,
});

const imdbTitleClient = axios.create({
  baseURL: 'https://www.imdb.com',
  timeout: 12000,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,pt-PT;q=0.8',
    Referer: 'https://www.imdb.com/',
  },
  validateStatus: () => true,
});

let filmesCache = null;
let seriesCache = null;
let novelasCache = null;
const genreArchiveCache = new Map();
const movieMetaCache = new Map();
const seriesMetaCache = new Map();
const imdbRatingCache = new Map();

const IMDB_ID_OVERRIDES = new Map([
  ['series:golpe de sorte', 'tt10133388'],
  ['series:golpe-de-sorte', 'tt10133388'],
]);

function clone(obj) {
  if (obj == null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function normalizeSlug(s) {
  return String(s || '')
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function absoluteUrl(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('/')) return `${BASE_URL}${raw}`;
  return `${BASE_URL}/${raw}`;
}

function toTitleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

async function safeClientGet(path, retries = 3, timeoutMs = HTTP_TIMEOUT_MS) {
  let last = null;
  const n = Math.max(1, retries);
  for (let i = 1; i <= n; i++) {
    try {
      const res = await client.get(path, { timeout: timeoutMs });
      last = res;
      if (res.status === 200) return res;
      if (RETRYABLE_STATUS.has(res.status) && i < n) {
        await new Promise((r) => setTimeout(r, 500 * i));
        continue;
      }
      return res;
    } catch (e) {
      const code = e && (e.code || e.cause?.code);
      if (i < n && RETRYABLE_CODES.has(code)) {
        await new Promise((r) => setTimeout(r, 500 * i));
        continue;
      }
      return null;
    }
  }
  return last;
}

function extractArchiveMaxPage($, html) {
  let max = 1;
  const lastHref = $('link[rel="last"]').attr('href');
  if (lastHref) {
    const m = String(lastHref).match(/\/page\/(\d+)\/?/i);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 1);
  }
  $('a.page-numbers, a.page-number').each((_, el) => {
    const n = parseInt($(el).text().trim(), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  });
  const re = /\/page\/(\d+)\/?/gi;
  let m;
  while ((m = re.exec(String(html || ''))) != null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return Math.max(1, Math.min(max, ARCHIVE_MAX_PAGES));
}

function parseDisplayItems($, contentType) {
  const seg = contentType === 'movie' ? 'filme' : 'serie';
  const map = new Map();

  $('.display-item .item-box').each((_, box) => {
    const $box = $(box);
    const href = $box.find('a[href]').first().attr('href');
    if (!href) return;
    let pathname = '';
    try {
      pathname = new URL(absoluteUrl(href)).pathname;
    } catch (_) {
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    const i = parts.indexOf(seg);
    if (i < 0 || !parts[i + 1]) return;
    const slug = normalizeSlug(parts[i + 1]);
    if (!slug || slug === 'page' || slug === 'feed') return;

    const img = $box.find('img').first();
    const poster = absoluteUrl(
      img.attr('data-original') || img.attr('data-src') || img.attr('src') || '',
    );
    const name = toTitleCase(
      (img.attr('alt') || '').trim() ||
        $box.find('.item-desc-title h3, .item-desc-title').first().text().trim() ||
        slug.replace(/-/g, ' '),
    );

    const id = contentType === 'movie' ? `novelaspt_movie_${slug}` : `novelaspt_series_${slug}`;
    map.set(`${contentType}:${slug}`, {
      id,
      slug,
      type: contentType,
      name,
      poster: poster || undefined,
      genres: ['None'],
    });
  });

  return [...map.values()];
}

function parseDisplayItemsAny($) {
  const map = new Map();
  $('.display-item .item-box').each((_, box) => {
    const $box = $(box);
    const href = $box.find('a[href]').first().attr('href');
    if (!href) return;
    let pathname = '';
    try {
      pathname = new URL(absoluteUrl(href)).pathname;
    } catch (_) {
      return;
    }
    const parts = pathname.split('/').filter(Boolean);
    let type = null;
    let slug = null;
    const iMovie = parts.indexOf('filme');
    const iSeries = parts.indexOf('serie');
    if (iMovie >= 0 && parts[iMovie + 1]) {
      type = 'movie';
      slug = normalizeSlug(parts[iMovie + 1]);
    } else if (iSeries >= 0 && parts[iSeries + 1]) {
      type = 'series';
      slug = normalizeSlug(parts[iSeries + 1]);
    }
    if (!type || !slug || slug === 'page' || slug === 'feed') return;
    const img = $box.find('img').first();
    const poster = absoluteUrl(
      img.attr('data-original') || img.attr('data-src') || img.attr('src') || '',
    );
    const name = toTitleCase(
      (img.attr('alt') || '').trim() ||
        $box.find('.item-desc-title h3, .item-desc-title').first().text().trim() ||
        slug.replace(/-/g, ' '),
    );
    const id = type === 'movie' ? `novelaspt_movie_${slug}` : `novelaspt_series_${slug}`;
    map.set(`${type}:${slug}`, { id, slug, type, name, poster: poster || undefined, genres: ['None'] });
  });
  return [...map.values()];
}

async function poolMap(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  async function runOne() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runOne()));
  return out;
}

async function fetchCatalog(startUrl, contentType) {
  const firstPath = startUrl.startsWith(BASE_URL) ? startUrl.slice(BASE_URL.length) : startUrl;
  const first = await safeClientGet(firstPath || '/', 3, HTTP_TIMEOUT_MS);
  if (!first || first.status !== 200 || typeof first.data !== 'string') return [];

  const items = parseDisplayItems(cheerio.load(first.data), contentType);
  const maxPage = extractArchiveMaxPage(cheerio.load(first.data), first.data);
  if (maxPage <= 1) return items;

  const pages = [];
  for (let p = 2; p <= maxPage; p++) {
    pages.push(`${startUrl.replace(/\/$/, '')}/page/${p}/`);
  }
  const rows = await poolMap(pages, ARCHIVE_CONCURRENCY, async (url) => {
    const path = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const res = await safeClientGet(path, 2, HTTP_TIMEOUT_MS);
    if (!res || res.status !== 200 || typeof res.data !== 'string') return [];
    return parseDisplayItems(cheerio.load(res.data), contentType);
  });

  const dedupe = new Map(items.map((x) => [x.id, x]));
  for (const arr of rows) {
    for (const it of arr) dedupe.set(it.id, it);
  }
  return [...dedupe.values()];
}

function genreToSlug(genreLabel) {
  return normalizeSlug(genreLabel)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function getItemsByGenreLabel(genreLabel) {
  const slug = genreToSlug(genreLabel);
  if (!slug) return [];
  const key = slug;
  const row = genreArchiveCache.get(key);
  if (row && Date.now() - row.time < CATALOG_CACHE_MS) return clone(row.items);

  const startUrl = `${BASE_URL}/genero/${slug}/`;
  const firstPath = startUrl.slice(BASE_URL.length);
  const first = await safeClientGet(firstPath || '/', 3, HTTP_TIMEOUT_MS);
  if (!first || first.status !== 200 || typeof first.data !== 'string') {
    return row?.items ? clone(row.items) : [];
  }

  const dedupe = new Map();
  const addRows = (arr) => {
    for (const it of arr) {
      const k = `${it.type}:${it.slug}`;
      if (!dedupe.has(k)) dedupe.set(k, it);
    }
  };

  addRows(parseDisplayItemsAny(cheerio.load(first.data)));
  const maxPage = extractArchiveMaxPage(cheerio.load(first.data), first.data);
  if (maxPage > 1) {
    const pages = [];
    for (let p = 2; p <= maxPage; p++) pages.push(`${startUrl.replace(/\/$/, '')}/page/${p}/`);
    const rows = await poolMap(pages, ARCHIVE_CONCURRENCY, async (url) => {
      const path = url.slice(BASE_URL.length);
      const res = await safeClientGet(path, 2, HTTP_TIMEOUT_MS);
      if (!res || res.status !== 200 || typeof res.data !== 'string') return [];
      return parseDisplayItemsAny(cheerio.load(res.data));
    });
    for (const arr of rows) addRows(arr);
  }

  const items = [...dedupe.values()].map((it) => ({ ...it, genres: [String(genreLabel)] }));
  genreArchiveCache.set(key, { time: Date.now(), items: clone(items) });
  return clone(items);
}

async function getCoveredIdsForGenres(labels) {
  const set = new Set();
  const arr = Array.isArray(labels) ? labels : [];
  for (const g of arr) {
    const items = await getItemsByGenreLabel(g);
    for (const it of items) set.add(it.id);
  }
  return set;
}

function getCacheRow(kind) {
  if (kind === 'movie') return filmesCache;
  if (kind === 'series') return seriesCache;
  return novelasCache;
}

function setCacheRow(kind, items) {
  const row = { time: Date.now(), items };
  if (kind === 'movie') filmesCache = row;
  else if (kind === 'series') seriesCache = row;
  else novelasCache = row;
}

async function getFilmes() {
  const row = getCacheRow('movie');
  if (row && Date.now() - row.time < CATALOG_CACHE_MS) return row.items;
  const items = await fetchCatalog(FILMES_ARCHIVE, 'movie');
  if (items.length) setCacheRow('movie', items);
  return items.length ? items : row?.items || [];
}

async function getSeriesPortuguesas() {
  const row = getCacheRow('series');
  if (row && Date.now() - row.time < CATALOG_CACHE_MS) return row.items;
  const items = await fetchCatalog(SERIES_ARCHIVE, 'series');
  if (items.length) setCacheRow('series', items);
  return items.length ? items : row?.items || [];
}

async function getNovelasPortuguesas() {
  const row = getCacheRow('novelas');
  if (row && Date.now() - row.time < CATALOG_CACHE_MS) return row.items;
  const items = await fetchCatalog(NOVELAS_ARCHIVE, 'series');
  if (items.length) setCacheRow('novelas', items);
  return items.length ? items : row?.items || [];
}

function yearFromText(text) {
  const m = String(text || '').match(/\b((?:19|20)\d{2})\b/);
  if (!m) return undefined;
  const y = parseInt(m[1], 10);
  if (!Number.isFinite(y) || y < 1870 || y > 2100) return undefined;
  return y;
}

function extractSynopsis($) {
  const block = $('.details-desc').first().text().replace(/\s+/g, ' ').trim();
  if (block) {
    const fromResumo =
      block.match(/Resumo do Filme:\s*(.+)$/i) ||
      block.match(/Resumo da S[ée]rie:\s*(.+)$/i) ||
      block.match(/Resumo do S[ée]rie:\s*(.+)$/i) ||
      block.match(/Resumo da Novela:\s*(.+)$/i) ||
      block.match(/Resumo do Novela:\s*(.+)$/i) ||
      block.match(/Resumo:\s*(.+)$/i) ||
      block.match(/Sinopse:\s*(.+)$/i);

    if (fromResumo && fromResumo[1]) {
      const clean = fromResumo[1].replace(/\s+/g, ' ').trim();
      if (clean.length > 20) return clean.slice(0, 4500);
    }

    /* fallback: se não vier com etiqueta "Resumo ...", mantém o bloco original */
    if (block.length > 20) return block.slice(0, 4500);
  }
  const alt = $('.entry-content, .content, .single-desc, .description').first().text().replace(/\s+/g, ' ').trim();
  return alt ? alt.slice(0, 4500) : undefined;
}

function extractYoutubeIdFromText(text) {
  const src = String(text || '');
  const patterns = [
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/i,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]{11})/i,
    /youtu\.be\/([A-Za-z0-9_-]{11})/i,
  ];
  for (const re of patterns) {
    const m = src.match(re);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function extractYoutubeTrailerId($, html) {
  const attrs = [
    'iframe[src*="youtube.com"], iframe[src*="youtu.be"]',
    'a[href*="youtube.com/watch"], a[href*="youtu.be/"]',
    '[data-video], [data-src], [data-url], [data-trailer]',
  ];
  for (const sel of attrs) {
    let found;
    $(sel).each((_, el) => {
      if (found) return;
      const $el = $(el);
      const raw =
        $el.attr('src') ||
        $el.attr('href') ||
        $el.attr('data-video') ||
        $el.attr('data-src') ||
        $el.attr('data-url') ||
        $el.attr('data-trailer') ||
        '';
      const id = extractYoutubeIdFromText(raw);
      if (id) found = id;
    });
    if (found) return found;
  }
  return extractYoutubeIdFromText(html);
}

function parseImdbRating(text, html) {
  const raw = `${String(text || '')}\n${String(html || '')}`;
  // Apenas padrões explícitos de IMDb para evitar apanhar rating interno do site.
  const m = raw.match(/IMDb(?:\s*Rating)?\s*[:\-]?\s*([0-9](?:[.,][0-9])?)/i);
  if (!m || !m[1]) return undefined;
  const n = parseFloat(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10) return undefined;
  return n.toFixed(1);
}

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function plausibleYear(y) {
  const n = Number.parseInt(String(y || ''), 10);
  return Number.isFinite(n) && n >= 1870 && n <= 2100 ? n : null;
}

function parseImdbRatingValue(raw) {
  const n = Number.parseFloat(String(raw || '').replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 10) return undefined;
  return n.toFixed(1);
}

function imdbOverrideId(type, title, slug) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return undefined;
  const titleKey = `${t}:${normalizeKey(title)}`;
  const slugKey = `${t}:${normalizeSlug(slug)}`;
  const id = IMDB_ID_OVERRIDES.get(titleKey) || IMDB_ID_OVERRIDES.get(slugKey);
  return /^tt\d{7,9}$/i.test(String(id || '')) ? String(id).toLowerCase() : undefined;
}

function extractImdbRatingFromTitleHtml(html) {
  const raw = String(html || '');
  if (!raw) return undefined;

  const fromJsonLd =
    raw.match(/"aggregateRating"\s*:\s*\{[^{}]*"ratingValue"\s*:\s*"?(?<r>\d+(?:\.\d+)?)"?/i) ||
    raw.match(/"ratingValue"\s*:\s*"?(?<r>\d+(?:\.\d+)?)"?/i);
  if (fromJsonLd && fromJsonLd.groups && fromJsonLd.groups.r) {
    const v = parseImdbRatingValue(fromJsonLd.groups.r);
    if (v) return v;
  }

  const fromUi =
    raw.match(/heroRatingBarAggregateRating__Score[^<]*<span[^>]*>(?<r>\d+(?:\.\d+)?)<\/span>/i) ||
    raw.match(/aria-label="IMDb rating:\s*(?<r>\d+(?:\.\d+)?)\/10"/i);
  if (fromUi && fromUi.groups && fromUi.groups.r) {
    const v = parseImdbRatingValue(fromUi.groups.r);
    if (v) return v;
  }
  return undefined;
}

async function imdbRatingById(imdbId) {
  const id = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d{7,9}$/.test(id)) return null;

  const row = imdbRatingCache.get(id);
  if (row && Date.now() - row.time < META_CACHE_MS) return row.rating || null;

  try {
    const res = await imdbTitleClient.get(`/title/${id}/`);
    if (res.status !== 200 || typeof res.data !== 'string') return row?.rating || null;
    const rating = extractImdbRatingFromTitleHtml(res.data) || null;
    imdbRatingCache.set(id, { time: Date.now(), rating });
    return rating;
  } catch (_) {
    return row?.rating || null;
  }
}

async function cinemetaByImdbId(type, imdbId) {
  const id = String(imdbId || '').trim().toLowerCase();
  if (!/^tt\d{7,9}$/.test(id)) return null;
  try {
    const r = await cinemetaClient.get(`/meta/${type}/${id}.json`);
    const m = r?.data?.meta;
    if (r.status !== 200 || !m) return null;
    return {
      imdbId: id,
      imdbRating: m.imdbRating != null ? String(m.imdbRating) : undefined,
      releaseInfo: m.releaseInfo ? String(m.releaseInfo) : undefined,
      year: plausibleYear(m.releaseInfo) || plausibleYear(m.year) || undefined,
    };
  } catch (_) {
    return null;
  }
}

async function cinemetaSearchBest(type, title, hintYear) {
  const q = String(title || '').trim();
  if (!q) return null;
  try {
    const url = `/catalog/${type}/top/search=${encodeURIComponent(q)}.json`;
    const r = await cinemetaClient.get(url);
    const metas = Array.isArray(r?.data?.metas) ? r.data.metas : [];
    if (r.status !== 200 || !metas.length) return null;

    const want = normalizeKey(q);
    const y = plausibleYear(hintYear);
    const scored = [];
    for (const m of metas.slice(0, 40)) {
      const id = String(m.id || m.imdb_id || '').trim().toLowerCase();
      if (!/^tt\d{7,9}$/.test(id)) continue;
      const name = normalizeKey(m.name || '');
      const cYear = plausibleYear(m.releaseInfo) || plausibleYear(m.year);
      let score = 0;
      if (name === want) score += 8;
      else if (name.includes(want) || want.includes(name)) score += 4;
      if (y != null && cYear != null) score += Math.max(0, 8 - Math.abs(cYear - y));
      if (m.imdbRating != null) score += 1;
      scored.push({
        score,
        imdbId: id,
        imdbRating: m.imdbRating != null ? String(m.imdbRating) : undefined,
        year: cYear || undefined,
        exactTitle: name === want,
      });
    }
    if (!scored.length) return null;
    // Evitar casar com IMDb errado quando o nome coincide mas o ano é outro (ex.: "Lulu").
    if (y != null) {
      const nearYear = scored.filter((c) => c.year != null && Math.abs(c.year - y) <= 2);
      if (nearYear.length) {
        nearYear.sort((a, b) => b.score - a.score);
        const best = nearYear[0];
        return { ...best, strong: !!best.exactTitle };
      }
      // Se temos ano de referência, não aceitar candidatos sem ano confirmado.
      return null;
    }
    scored.sort((a, b) => b.score - a.score);
    // Sem ano de referência, só aceitar match com score forte.
    if ((scored[0]?.score || 0) < 6) return null;
    const best = scored[0];
    return { ...best, strong: !!best.exactTitle && best.score >= 8 };
  } catch (_) {
    return null;
  }
}

function normalizeSpace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function blockText($) {
  return normalizeSpace($('.details-desc').first().text() || '');
}

function labelValue(block, labels) {
  const src = normalizeSpace(block);
  if (!src) return '';
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*:\\s*(.+?)(?=(?:\\b[A-ZÀ-Ý][A-Za-zÀ-ÿ ]{1,35}:)|$)`, 'i');
    const m = src.match(re);
    if (m && m[1]) {
      const v = normalizeSpace(m[1]);
      if (v) return v;
    }
  }
  return '';
}

function splitGenres(raw) {
  const txt = normalizeSpace(raw || '');
  if (!txt) return ['None'];
  const pieces = txt
    .split(/,|\/|;|\|/g)
    .map((x) => normalizeSpace(x))
    .filter(Boolean)
    .flatMap((x) => x.split(/\s+e\s+/i).map((y) => normalizeSpace(y)).filter(Boolean));
  const dedupe = [];
  const seen = new Set();
  for (const p of pieces) {
    const cleaned = p
      .replace(/^[-–—:\s]+/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    dedupe.push(cleaned);
  }
  return dedupe.length ? dedupe : ['None'];
}

function sanitizeGenres(list) {
  const out = [];
  const seen = new Set();
  const banned = /(novelas|assistir|portuguesas|online|gratis|site|download|filmes)/i;
  for (const g of list || []) {
    const v = normalizeSpace(g);
    if (!v) continue;
    if (banned.test(v)) continue;
    if (v.length > 28) continue;
    const words = v.split(/\s+/).length;
    if (words > 3) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out.length ? out : ['None'];
}

function extractGenresFromBlock(block) {
  const src = normalizeSpace(block);
  if (!src) return ['None'];
  const labeled = labelValue(src, [
    'G[ée]nero',
    'G[ée]neros',
    'Categoria',
    'Categorias',
    'Classifica[cç][aã]o',
  ]);
  if (labeled) return splitGenres(labeled);
  return ['None'];
}

function extractGenresFromPage($, block) {
  const fromBlock = extractGenresFromBlock(block);
  const out = [];
  const seen = new Set();
  const push = (g) => {
    const v = normalizeSpace(g);
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };

  if (Array.isArray(fromBlock)) {
    for (const g of fromBlock) {
      if (normalizeSpace(g).toLowerCase() !== 'none') push(g);
    }
  }

  $('a[href*="/genero/"]').each((_, a) => {
    const txt = normalizeSpace($(a).text());
    if (!txt) return;
    for (const g of splitGenres(txt)) {
      if (normalizeSpace(g).toLowerCase() !== 'none') push(g);
    }
  });

  return sanitizeGenres(out.length ? out : ['None']);
}

function releaseInfoFromBlock(block, typeHint) {
  const src = normalizeSpace(block);
  if (!src) return undefined;

  const period =
    labelValue(src, ['Per[ií]odo de Exibi[cç][aã]o', 'Per[ií]odo']) ||
    labelValue(src, ['Anos de Exibi[cç][aã]o']);
  if (period) {
    const years = [...period.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => parseInt(m[1], 10));
    if (years.length >= 2) {
      years.sort((a, b) => a - b);
      return `${years[0]}-${years[years.length - 1]}`;
    }
    if (years.length === 1) return String(years[0]);
    return period.slice(0, 40);
  }

  const yearAfterLabel = src.match(
    /(?:Ano do Filme|Ano da S[ée]rie|Ano do S[ée]rie|Ano da Novela|Ano do Novela)\s*:\s*((?:19|20)\d{2})/i,
  );
  if (yearAfterLabel && yearAfterLabel[1]) return yearAfterLabel[1];

  const dateAfterLabel = src.match(
    /(?:Data de Estreia|Estreia|Primeira Exibi[cç][aã]o)\s*:\s*(\d{1,2}[\/\-]\d{1,2}[\/\-](?:19|20)\d{2})/i,
  );
  if (dateAfterLabel && dateAfterLabel[1]) return dateAfterLabel[1];

  const estreia = labelValue(src, ['Data de Estreia', 'Estreia', 'Primeira Exibi[cç][aã]o']);
  if (estreia) {
    const y = estreia.match(/\b((?:19|20)\d{2})\b/);
    if (y) return y[1];
    return estreia.slice(0, 40);
  }

  if (typeHint === 'series') {
    const y = src.match(/\b((?:19|20)\d{2})\b/);
    if (y) return y[1];
  }
  return undefined;
}

function broadcasterFromBlock(block) {
  const src = normalizeSpace(block);
  if (!src) return undefined;

  const labeled = labelValue(src, ['Emissora', 'Canal', 'Transmiss[aã]o', 'Exibi[cç][aã]o original']);
  if (labeled) return labeled.slice(0, 40);

  const known = ['TVI', 'SIC', 'RTP1', 'RTP2', 'RTP', 'RTP Memória', 'RTP Açores', 'RTP Madeira', 'Canal Q'];
  for (const k of known) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(src)) return k;
  }
  return undefined;
}

function remapEpisodes(raw) {
  const ssids = [...new Set(raw.map((e) => e.rawSsid))].sort((a, b) => a - b);
  const map = new Map(ssids.map((id, i) => [id, i + 1]));
  return raw
    .map((e) => ({ season: map.get(e.rawSsid), episode: e.episode, wpPid: e.wpPid, name: e.name }))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
}

function detailPaths(slug, preferMovie) {
  const s = normalizeSlug(slug);
  const f = [`/filme/${s}/`, `/filme/${s}`];
  const r = [`/serie/${s}/`, `/serie/${s}`];
  const arr = preferMovie ? [...f, ...r] : [...r, ...f];
  return arr.slice(0, Math.max(1, META_MAX_PATHS));
}

async function fetchDetail(slug, preferMovie) {
  const paths = detailPaths(slug, preferMovie);
  for (const p of paths) {
    const res = await safeClientGet(p, META_RETRIES, META_TIMEOUT_MS);
    if (res && res.status === 200 && typeof res.data === 'string') return { path: p, html: res.data };
  }
  return null;
}

async function findCatalogItem(kind, slug) {
  const s = normalizeSlug(slug);
  const lists =
    kind === 'movie'
      ? [await getFilmes()]
      : [await getSeriesPortuguesas(), await getNovelasPortuguesas()];
  for (const arr of lists) {
    const hit = arr.find((x) => normalizeSlug(x.slug) === s);
    if (hit) return clone(hit);
  }
  return null;
}

function shellMovieMetaFromStremioId(decoded) {
  const id = String(decoded || '');
  if (!id.startsWith('novelaspt_movie_')) return null;
  const slug = normalizeSlug(id.slice('novelaspt_movie_'.length));
  if (!slug) return null;
  return {
    id,
    type: 'movie',
    slug,
    name: toTitleCase(slug.replace(/-/g, ' ')),
    description: 'Meta temporaria. O site de origem nao respondeu para este titulo.',
    genres: ['None'],
  };
}

function shellSeriesMetaFromStremioId(decoded) {
  const full = String(decoded || '');
  if (!full.startsWith('novelaspt_series_')) return null;
  const m = full.match(/^novelaspt_series_(.+):\d+:\d+$/);
  const id = m ? `novelaspt_series_${m[1]}` : full;
  const slug = normalizeSlug(id.slice('novelaspt_series_'.length));
  if (!slug) return null;
  return {
    id,
    type: 'series',
    slug,
    name: toTitleCase(slug.replace(/-/g, ' ')),
    description: 'Meta temporaria. O site de origem nao respondeu para esta serie.',
    genres: ['None'],
    episodes: [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }],
  };
}

async function getFilmeMeta(slug) {
  const key = normalizeSlug(slug);
  const c = movieMetaCache.get(key);
  if (c && Date.now() - c.time < META_CACHE_MS) return clone(c.item);

  const fetched = await fetchDetail(slug, true);
  if (!fetched) {
    const fallback = (await findCatalogItem('movie', slug)) || null;
    if (fallback) {
      const item = { ...fallback, type: 'movie', genres: fallback.genres || ['None'] };
      movieMetaCache.set(key, { time: Date.now(), item: clone(item) });
      return item;
    }
    const stale = c?.item || null;
    return stale ? clone(stale) : null;
  }

  const { html, path } = fetched;
  const $ = cheerio.load(html);
  const slugFromPath = normalizeSlug(path.split('/').filter(Boolean).pop());
  const canonicalSlug = slugFromPath || key;

  const name = toTitleCase(
    $('h1').first().text().trim() || $('.display-page-heading h1').first().text().trim() || canonicalSlug.replace(/-/g, ' '),
  );
  const desc = extractSynopsis($);
  const details = blockText($);
  const year =
    yearFromText(`${details} ${$('body').text()}`) ||
    yearFromText($('h1').first().text());
  const releaseInfo = releaseInfoFromBlock(details, 'movie') || (year ? String(year) : undefined);
  const runtime = broadcasterFromBlock(details);
  const genres = extractGenresFromPage($, details);
  const poster = absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '');
  const bodyTxt = $('body').text();
  const imdbM =
    $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) ||
    bodyTxt.match(/IMDb(?:\s*ID|\s*:\s*|\s+)(tt\d{7,9})/i);
  let imdbId = imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined;
  let imdbRating = parseImdbRating($('body').text(), html);
  const trailerYtId = extractYoutubeTrailerId($, html);
  const wpPostId =
    parseInt(($.html().match(/[?&]p=(\d+)/)?.[1]) || '', 10) ||
    parseInt($('.zetaflix_player_option').first().attr('data-post') || '', 10) ||
    undefined;

  const item = {
    id: `novelaspt_movie_${canonicalSlug}`,
    type: 'movie',
    slug: canonicalSlug,
    name,
    description: desc,
    year,
    releaseInfo,
    runtime,
    genres,
    poster: poster || undefined,
    imdbId,
    imdbRating,
    trailerYtId,
    wpPostId: Number.isFinite(wpPostId) ? wpPostId : undefined,
  };
  const overrideMovieImdbId = imdbOverrideId('movie', name, canonicalSlug);
  if (overrideMovieImdbId) imdbId = overrideMovieImdbId;

  // IMDb rating robusto: preferir Cinemeta (resolve casos em que o título IMDb está em inglês).
  const cmById = imdbId ? await cinemetaByImdbId('movie', imdbId) : null;
  if (cmById?.imdbRating) imdbRating = cmById.imdbRating;
  if (!imdbId || !imdbRating) {
    const cmSearch = await cinemetaSearchBest('movie', name, year);
    if (cmSearch?.imdbId && !imdbId && cmSearch.strong) imdbId = cmSearch.imdbId;
    if (cmSearch?.imdbRating && !imdbRating && cmSearch.strong) imdbRating = cmSearch.imdbRating;
  }
  const imdbRatingFromPage = imdbId ? await imdbRatingById(imdbId) : null;
  if (imdbRatingFromPage) imdbRating = imdbRatingFromPage;
  item.imdbId = imdbId;
  item.imdbRating = imdbRating;
  movieMetaCache.set(key, { time: Date.now(), item: clone(item) });
  movieMetaCache.set(canonicalSlug, { time: Date.now(), item: clone(item) });
  return clone(item);
}

async function getSeriesMeta(slug) {
  const key = normalizeSlug(slug);
  const c = seriesMetaCache.get(key);
  if (c && Date.now() - c.time < META_CACHE_MS) return clone(c.item);

  const fetched = await fetchDetail(slug, false);
  if (!fetched) {
    const fallback = (await findCatalogItem('series', slug)) || null;
    if (fallback) {
      const item = {
        ...fallback,
        type: 'series',
        genres: fallback.genres || ['None'],
        episodes: [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }],
      };
      seriesMetaCache.set(key, { time: Date.now(), item: clone(item) });
      return item;
    }
    const stale = c?.item || null;
    return stale ? clone(stale) : null;
  }

  const { html, path } = fetched;
  const $ = cheerio.load(html);
  const slugFromPath = normalizeSlug(path.split('/').filter(Boolean).pop());
  const canonicalSlug = slugFromPath || key;

  const name = toTitleCase(
    $('h1').first().text().trim() || $('.display-page-heading h1').first().text().trim() || canonicalSlug.replace(/-/g, ' '),
  );
  const desc = extractSynopsis($);
  const details = blockText($);
  const year =
    yearFromText(`${details} ${$('body').text()}`) ||
    yearFromText($('h1').first().text());
  const releaseInfo = releaseInfoFromBlock(details, 'series') || (year ? String(year) : undefined);
  const runtime = broadcasterFromBlock(details);
  const genres = extractGenresFromPage($, details);
  const poster = absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '');
  const bodyTxt = $('body').text();
  const imdbM =
    $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) ||
    bodyTxt.match(/IMDb(?:\s*ID|\s*:\s*|\s+)(tt\d{7,9})/i);
  let imdbId = imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined;
  let imdbRating = parseImdbRating($('body').text(), html);
  const trailerYtId = extractYoutubeTrailerId($, html);

  const rawEpisodes = [];
  $('.play-ep').each((_, el) => {
    const $el = $(el);
    const wpPid = parseInt($el.attr('data-pid') || '', 10);
    const ep = parseInt($el.attr('data-epid') || '', 10);
    const ssid = parseInt($el.attr('data-ssid') || '', 10);
    if (!Number.isFinite(wpPid) || wpPid <= 0) return;
    if (!Number.isFinite(ep) || ep <= 0) return;
    if (!Number.isFinite(ssid) || ssid <= 0) return;
    const title = $el.find('.ep-title').first().text().trim() || `Episodio ${ep}`;
    if (!rawEpisodes.some((e) => e.rawSsid === ssid && e.episode === ep)) {
      rawEpisodes.push({ rawSsid: ssid, episode: ep, wpPid, name: title });
    }
  });

  let episodes = remapEpisodes(rawEpisodes);
  if (!episodes.length) {
    episodes = [{ season: 1, episode: 1, name: 'A sincronizar...', wpPid: undefined }];
  }

  const item = {
    id: `novelaspt_series_${canonicalSlug}`,
    type: 'series',
    slug: canonicalSlug,
    name,
    description: desc,
    year,
    releaseInfo,
    runtime,
    genres,
    poster: poster || undefined,
    imdbId,
    imdbRating,
    trailerYtId,
    episodes,
  };
  const overrideSeriesImdbId = imdbOverrideId('series', name, canonicalSlug);
  if (overrideSeriesImdbId) imdbId = overrideSeriesImdbId;

  const cmById = imdbId ? await cinemetaByImdbId('series', imdbId) : null;
  if (cmById?.imdbRating) imdbRating = cmById.imdbRating;
  if (!imdbId || !imdbRating) {
    const cmSearch = await cinemetaSearchBest('series', name, year);
    if (cmSearch?.imdbId && !imdbId && cmSearch.strong) imdbId = cmSearch.imdbId;
    if (cmSearch?.imdbRating && !imdbRating && cmSearch.strong) imdbRating = cmSearch.imdbRating;
  }
  const imdbRatingFromPage = imdbId ? await imdbRatingById(imdbId) : null;
  if (imdbRatingFromPage) imdbRating = imdbRatingFromPage;
  item.imdbId = imdbId;
  item.imdbRating = imdbRating;
  seriesMetaCache.set(key, { time: Date.now(), item: clone(item) });
  seriesMetaCache.set(canonicalSlug, { time: Date.now(), item: clone(item) });
  return clone(item);
}

async function getMovieStreamSources(wpPostId) {
  if (!wpPostId) return [];
  const out = [];
  const seen = new Set();
  for (let n = 1; n <= 30; n++) {
    let res;
    try {
      res = await zetaClient.get(`/${wpPostId}/mv/${n}`);
    } catch (_) {
      break;
    }
    if (res.status !== 200 || !res.data) break;
    const u0 = String(res.data.embed_url || '').trim();
    if (!u0) {
      if (res.data.type === false) break;
      continue;
    }
    let u = u0.startsWith('//') ? `https:${u0}` : u0;
    u = u.replace(/^http:\/\//i, 'https://');
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'url', title: `Opcao ${out.length + 1}`, url: u });
  }
  return out;
}

async function getTvEpisodeStreamSources(wpEpisodePid) {
  if (!wpEpisodePid) return [];
  let res;
  try {
    res = await zetaClient.get(`/tvep/${wpEpisodePid}`);
  } catch (_) {
    return [];
  }
  if (res.status !== 200 || !res.data || !Array.isArray(res.data.embed)) return [];
  const out = [];
  const seen = new Set();
  for (const row of res.data.embed) {
    const u0 = String(row.code || '').trim();
    if (!u0) continue;
    let u = u0.startsWith('//') ? `https:${u0}` : u0;
    u = u.replace(/^http:\/\//i, 'https://');
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'url', title: row.name || row.title || `Opcao ${out.length + 1}`, url: u });
  }
  return out;
}

function sanitizeCatalogItems(items) {
  return items;
}

module.exports = {
  BASE_URL,
  getFilmes,
  getSeriesPortuguesas,
  getNovelasPortuguesas,
  getItemsByGenreLabel,
  getCoveredIdsForGenres,
  sanitizeCatalogItems,
  getFilmeMeta,
  getSeriesMeta,
  getMovieStreamSources,
  getTvEpisodeStreamSources,
  shellMovieMetaFromStremioId,
  shellSeriesMetaFromStremioId,
};
