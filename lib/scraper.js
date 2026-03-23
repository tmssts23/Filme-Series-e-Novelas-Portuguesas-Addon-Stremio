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

let filmesCache = null;
let seriesCache = null;
let novelasCache = null;
const movieMetaCache = new Map();
const seriesMetaCache = new Map();

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
    map.set(`${contentType}:${slug}`, { id, slug, type: contentType, name, poster: poster || undefined });
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
  if (block && block.length > 20) return block.slice(0, 4500);
  const alt = $('.entry-content, .content, .single-desc, .description').first().text().replace(/\s+/g, ' ').trim();
  return alt ? alt.slice(0, 4500) : undefined;
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
      const item = { ...fallback, type: 'movie' };
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
  const year = yearFromText($('.details-desc').first().text() || $('body').text()) || yearFromText($('h1').first().text());
  const releaseInfo = year ? String(year) : undefined;
  const poster = absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '');
  const imdbM = $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) || $('body').text().match(/(tt\d{7,9})/i);
  const imdbId = imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined;
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
    poster: poster || undefined,
    imdbId,
    wpPostId: Number.isFinite(wpPostId) ? wpPostId : undefined,
  };
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
  const year = yearFromText($('.details-desc').first().text() || $('body').text()) || yearFromText($('h1').first().text());
  const releaseInfo = year ? String(year) : undefined;
  const poster = absoluteUrl($('meta[property="og:image"]').attr('content') || $('img').first().attr('src') || '');
  const imdbM = $.html().match(/imdb\.com\/title\/(tt\d{7,9})/i) || $('body').text().match(/(tt\d{7,9})/i);
  const imdbId = imdbM ? String(imdbM[1] || imdbM[0]).toLowerCase() : undefined;

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
    poster: poster || undefined,
    imdbId,
    episodes,
  };
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
  sanitizeCatalogItems,
  getFilmeMeta,
  getSeriesMeta,
  getMovieStreamSources,
  getTvEpisodeStreamSources,
  shellMovieMetaFromStremioId,
  shellSeriesMetaFromStremioId,
};
