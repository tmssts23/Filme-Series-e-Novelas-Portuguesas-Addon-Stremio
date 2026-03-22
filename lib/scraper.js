/**
 * Scraper para Novelas Portuguesas (novelasportuguesas.com) — tema Zetaflix / WordPress.
 * Catálogo: listagens .display-item; players: REST zetaplayer/v2.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const { getMetaByImdbId } = require('./cinemeta');

const BASE_URL = 'https://novelasportuguesas.com';
const FILMES_ARCHIVE = `${BASE_URL}/filme/`;
const SERIES_ARCHIVE = `${BASE_URL}/serie/`;
const NOVELAS_GENRE_ARCHIVE = `${BASE_URL}/genero/novelas/`;
const ZETA_API = `${BASE_URL}/wp-json/zetaplayer/v2`;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: 64 });
const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: 64 });

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 25000,
  httpAgent: httpKeepAlive,
  httpsAgent: httpsKeepAlive,
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
  timeout: 20000,
  httpAgent: httpKeepAlive,
  httpsAgent: httpsKeepAlive,
  headers: {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Referer: `${BASE_URL}/`,
  },
  validateStatus: () => true,
});

/** Cache em memória (catálogos completos são pesados) */
let filmesCache = null;
let seriesPortuguesasCache = null;
let novelasPortuguesasCache = null;
const CACHE_MS = Number(process.env.STREMIO_NP_CACHE_MS) || 6 * 60 * 60 * 1000;

const LOG_PREFIX = '[NovelasPT]';

function logCatalogCacheHit(label, count, cachedAtMs) {
  const ageMin = Math.round((Date.now() - cachedAtMs) / 60000);
  const ttlMin = Math.max(0, Math.round((cachedAtMs + CACHE_MS - Date.now()) / 60000));
  console.log(
    `${LOG_PREFIX} CACHE catálogo [${label}] ${count} títulos | carregado há ~${ageMin} min | TTL restante ~${ttlMin} min`,
  );
}

function logCatalogRefresh(label, startUrl, stats) {
  const { items, archivePages, ms, synopsisRequests, synopsisOk } = stats;
  const synPart = CATALOG_SYNOPSIS_ENABLED
    ? ` | páginas de detalhe (resumos): ${synopsisRequests} pedidos, ${synopsisOk} OK`
    : ' | resumos no catálogo: desativados (STREMIO_NP_CATALOG_SYNOPSIS=0)';
  console.log(
    `${LOG_PREFIX} REFRESH catálogo [${label}] ${items} títulos | páginas de arquivo (listagem): ${archivePages}${synPart} | ${ms} ms | fonte: ${startUrl}`,
  );
}

/** Resumo na grelha do Stremio: pedidos à página de detalhe (desativar: STREMIO_NP_CATALOG_SYNOPSIS=0) */
const CATALOG_SYNOPSIS_ENABLED = process.env.STREMIO_NP_CATALOG_SYNOPSIS !== '0';
const CATALOG_SYNOPSIS_CONCURRENCY = Math.max(1, Number(process.env.STREMIO_NP_SYNOPSIS_CONCURRENCY) || 8);
/** 0 = todos os títulos; senão limita quantos resumos buscar por refresh do catálogo */
const CATALOG_SYNOPSIS_MAX = Number(process.env.STREMIO_NP_MAX_SYNOPSIS);
const CATALOG_DESC_PREVIEW_LEN = Math.min(2000, Number(process.env.STREMIO_NP_CATALOG_DESC_LEN) || 900);

/** Pedidos paralelos às páginas de arquivo (listagens WordPress) */
const ARCHIVE_PAGE_CONCURRENCY = Math.max(1, Number(process.env.STREMIO_NP_ARCHIVE_CONCURRENCY) || 8);
/** Limite de páginas de arquivo (evita números errados na paginação) */
const ARCHIVE_MAX_PAGES = Math.max(1, Number(process.env.STREMIO_NP_MAX_ARCHIVE_PAGES) || 500);

function toTitleCase(str) {
  if (!str) return str;
  return str
    .toLowerCase()
    .replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function absoluteUrl(u, base = BASE_URL) {
  if (!u || typeof u !== 'string') return u;
  u = u.trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http')) return u;
  const b = base.replace(/\/$/, '');
  return u.startsWith('/') ? b + u : `${b}/${u}`;
}

/** TMDB: usar resolução máxima para fundo no Stremio (vista “Ver show”). */
function upgradeTmdbToOriginalForBackdrop(url) {
  if (!url || typeof url !== 'string') return url;
  if (!/image\.tmdb\.org\/t\/p\//i.test(url)) return url;
  return url.replace(/\/t\/p\/[^/]+\//i, '/t/p/original/');
}

const BACKDROP_SKIP_RE =
  /(logo\.png|favicon|gravatar|spacer|blank\.|pixel\.gif|1x1|emoji|smiley)/i;

function tmdbAssetFilename(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/image\.tmdb\.org\/t\/p\/[^/]+\/([^/?#]+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * Imagens de destaque do tema (player + galeria acima de “Links para Download”, etc.)
 * para o campo `background` do Stremio.
 * @param {string} [posterUrl] — se houver outro still no site (ficheiro TMDB diferente), usa-se como fundo.
 */
function extractSiteBackdropUrl($, posterUrl) {
  const candidates = [];

  function pushRaw(raw) {
    if (!raw || typeof raw !== 'string') return;
    const u = absoluteUrl(raw.trim());
    if (!/^https?:\/\//i.test(u)) return;
    if (BACKDROP_SKIP_RE.test(u)) return;
    candidates.push(upgradeTmdbToOriginalForBackdrop(u));
  }

  const primarySelectors = [
    '.player-display img',
    '.preplayer img',
    '.icons-gallery .gallery-images img',
    '.icons-gallery .image-icon img',
    '.icons-gallery img',
    '.display-page-heading img',
  ];
  for (const sel of primarySelectors) {
    $(sel).each((_, el) => {
      const $el = $(el);
      pushRaw($el.attr('src') || $el.attr('data-src') || $el.attr('data-original'));
    });
  }

  $('.main-content .wrapper img')
    .not('.episodes-list img, .ep-thumb img, .search-results img, .comments img, .logo img')
    .each((_, el) => {
      const $el = $(el);
      pushRaw($el.attr('src') || $el.attr('data-src') || $el.attr('data-original'));
    });

  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  if (!uniq.length) return null;

  const scoreUrl = (u) => {
    if (/\/t\/p\/original\//i.test(u)) return 100;
    if (/\/t\/p\/w1280\//i.test(u)) return 85;
    if (/\/t\/p\/w780\//i.test(u)) return 70;
    if (/\/t\/p\/w500\//i.test(u)) return 50;
    if (/\/t\/p\/w\d+\//i.test(u)) return 30;
    return 40;
  };

  uniq.sort((a, b) => scoreUrl(b) - scoreUrl(a));

  const posterKey = posterUrl ? tmdbAssetFilename(posterUrl.trim()) : null;
  if (posterKey) {
    const alternate = uniq.find(
      (u) => tmdbAssetFilename(u) && tmdbAssetFilename(u) !== posterKey && scoreUrl(u) >= 55,
    );
    if (alternate) return upgradeTmdbToOriginalForBackdrop(alternate);
  }

  return uniq[0];
}

const DESC_MAX = 4500;

/**
 * Sinopse / resumo do tema Zetaflix (.details-desc), com labels "Resumo do Filme:", etc.
 */
function extractSynopsis($) {
  const raw = $('.details-desc').first().text().replace(/\s+/g, ' ').trim();
  if (!raw) {
    const og = $('meta[property="og:description"]').attr('content');
    return (og && og.trim()) || '';
  }
  const splitters = [
    /Resumo do Filme:\s*(.+)/i,
    /Resumo da [Ss]érie:\s*(.+)/i,
    /Resumo:\s*(.+)/i,
    /Sinopse:\s*(.+)/i,
  ];
  for (const re of splitters) {
    const m = raw.match(re);
    if (m && m[1] && m[1].trim().length > 15) return m[1].trim().slice(0, DESC_MAX);
  }
  if (/Nome do Filme:/i.test(raw) || /Ano do Filme:/i.test(raw)) {
    const parts = raw.split(/Resumo do Filme:\s*/i);
    if (parts[1] && parts[1].trim().length > 15) return parts[1].trim().slice(0, DESC_MAX);
  }
  if (raw.length > 25) return raw.slice(0, DESC_MAX);
  return '';
}

/**
 * data-ssid no site é ID interno, não "temporada 1". O Stremio pede stream para S01E01 por defeito.
 * Mapeamos cada ssid distinto para temporada 1…N (ordem numérica do ssid).
 */
function remapEpisodeSeasons(rawList) {
  if (!rawList.length) return [];
  const ssids = [...new Set(rawList.map((e) => e.rawSsid))].sort((a, b) => a - b);
  const ssidToSeason = new Map();
  ssids.forEach((id, i) => ssidToSeason.set(id, i + 1));
  return rawList.map((e) => ({
    season: ssidToSeason.get(e.rawSsid),
    episode: e.episode,
    wpPid: e.wpPid,
    name: e.name,
  }));
}

async function enrichMetaFromCinemeta(item, stremioType) {
  if (!item.imdbId || !String(item.imdbId).startsWith('tt')) return item;
  const siteDesc = (item.description || '').trim();
  if (siteDesc.length >= 160) return item;
  const cm = await getMetaByImdbId(stremioType, item.imdbId);
  if (!cm) return item;
  if (cm.description) {
    item.description = siteDesc
      ? `${siteDesc}\n\n${cm.description}`.trim().slice(0, DESC_MAX)
      : cm.description.slice(0, DESC_MAX);
  }
  if (cm.poster && !item.poster) item.poster = cm.poster;
  if (cm.background && !item.background) item.background = cm.background;
  if (cm.genres?.length && !item.genres?.length) item.genres = cm.genres;
  if (cm.cast && !item.cast) item.cast = cm.cast;
  if (cm.director && !item.director) item.director = cm.director;
  if (cm.imdbRating != null && item.imdbRating == null) item.imdbRating = cm.imdbRating;
  if (cm.runtime && !item.runtime) item.runtime = cm.runtime;
  return item;
}

/**
 * Extrai filme ou série de cada .display-item (listagens do tema).
 * @param {'movie'|'series'} contentType
 */
function parseDisplayItems($, items, seenSlugs, contentType) {
  const pathSeg = contentType === 'movie' ? 'filme' : 'serie';

  $('.display-item .item-box').each((_, box) => {
    const $box = $(box);
    const a = $box.find('a[href]').first();
    const href = a.attr('href');
    if (!href) return;

    const abs = absoluteUrl(href);
    let pathname;
    try {
      pathname = new URL(abs).pathname;
    } catch (_) {
      return;
    }

    const parts = pathname.split('/').filter(Boolean);
    const pi = parts.indexOf(pathSeg);
    if (pi < 0 || !parts[pi + 1]) return;
    const slug = parts[pi + 1];
    if (slug === 'page' || slug === 'feed') return;

    const key = `${contentType}_${slug}`;
    if (seenSlugs.has(key)) return;
    seenSlugs.add(key);

    const img = $box.find('img').first();
    let poster =
      img.attr('data-original') || img.attr('data-src') || img.attr('src') || undefined;
    if (poster && !poster.startsWith('http')) poster = absoluteUrl(poster);

    let name =
      (img.attr('alt') || '').trim() ||
      $box.find('.item-desc-title h3, .item-desc-title').first().text().trim() ||
      slug.replace(/-/g, ' ');
    name = toTitleCase(name);

    const id =
      contentType === 'movie' ? `novelaspt_movie_${slug}` : `novelaspt_series_${slug}`;

    items.push({
      id,
      name,
      slug,
      type: contentType,
      poster: poster || undefined,
    });
  });
}

/**
 * Preenche `item.description` (resumo) para o catálogo Stremio, antes de abrir o título.
 * @returns {{ synopsisRequests: number, synopsisOk: number }}
 */
async function hydrateCatalogSynopses(items, wpPathSeg) {
  if (!CATALOG_SYNOPSIS_ENABLED || !items.length) {
    return { synopsisRequests: 0, synopsisOk: 0 };
  }

  let list = items;
  if (Number.isFinite(CATALOG_SYNOPSIS_MAX) && CATALOG_SYNOPSIS_MAX > 0) {
    list = items.slice(0, CATALOG_SYNOPSIS_MAX);
  }

  let synopsisRequests = 0;
  let synopsisOk = 0;

  if (list.length > 80) {
    console.log(
      `${LOG_PREFIX} Resumos do catálogo: a consultar ${list.length} páginas de detalhe (${wpPathSeg})…`,
    );
  }

  for (let i = 0; i < list.length; i += CATALOG_SYNOPSIS_CONCURRENCY) {
    const batch = list.slice(i, i + CATALOG_SYNOPSIS_CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        if (item.description) return;
        try {
          synopsisRequests += 1;
          const res = await client.get(`/${wpPathSeg}/${item.slug}/`);
          if (res.status !== 200 || typeof res.data !== 'string') return;
          synopsisOk += 1;
          const $ = cheerio.load(res.data);
          const desc = extractSynopsis($);
          if (desc) item.description = desc.slice(0, CATALOG_DESC_PREVIEW_LEN);
        } catch (_) {
          /* ignora falhas pontuais */
        }
      }),
    );
  }

  return { synopsisRequests, synopsisOk };
}

async function getFilmes() {
  const now = Date.now();
  if (filmesCache && now - filmesCache.time < CACHE_MS) {
    logCatalogCacheHit('filmes', filmesCache.items.length, filmesCache.time);
    return filmesCache.items;
  }

  const t0 = Date.now();
  const seen = new Set();
  const items = [];
  const archivePages = await fetchAllArchivePagesInto(FILMES_ARCHIVE, items, seen, 'movie');
  const { synopsisRequests, synopsisOk } = await hydrateCatalogSynopses(items, 'filme');
  filmesCache = { time: now, items };
  logCatalogRefresh('filmes', FILMES_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  return items;
}

function normalizeListPageUrl(absUrl) {
  if (!absUrl || typeof absUrl !== 'string') return absUrl;
  const u = absoluteUrl(absUrl.trim());
  return u.endsWith('/') ? u : `${u}/`;
}

/**
 * Última página na paginação WordPress (link rel="last", números em .page-numbers, etc.).
 */
function detectMaxArchivePage($, html) {
  let max = 1;
  const lastHref = $('link[rel="last"]').attr('href');
  if (lastHref) {
    const abs = absoluteUrl(lastHref);
    const m = abs.match(/\/page\/(\d+)\/?(?:\?|$)/i) || abs.match(/[?&]paged=(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10) || 1);
  }
  $('a.page-numbers, a.page-number').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, '').trim();
    const n = parseInt(t, 10);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return Number.isFinite(max) && max >= 1 ? max : 1;
}

function nextListPageHref($, html) {
  let next = $('link[rel="next"]').attr('href');
  if (!next) next = $('a.next.page-numbers').attr('href');
  if (!next) {
    const m = html.match(/<link[^>]*\srel=["']next["'][^>]*\s+href=["']([^"']+)["']/i);
    if (m) next = m[1];
  }
  return next ? absoluteUrl(next) : null;
}

function listPageUrlForIndex(baseWithSlash, page) {
  const base = baseWithSlash.replace(/\/$/, '');
  if (page <= 1) return `${base}/`;
  return `${base}/page/${page}/`;
}

async function fetchArchiveHtmlPaths(paths) {
  return Promise.all(
    paths.map((path) => client.get(path)),
  );
}

/**
 * Percorre o arquivo WordPress e preenche `items`. Devolve quantas páginas de listagem foram obtidas com sucesso.
 */
async function fetchAllArchivePagesInto(startUrl, items, seenSlugs, contentType) {
  let pagesFetched = 0;
  const firstUrl = normalizeListPageUrl(startUrl);
  const visited = new Set();

  const firstPath = firstUrl.startsWith(BASE_URL) ? firstUrl.slice(BASE_URL.length) || '/' : firstUrl;
  const res = await client.get(firstPath);
  if (res.status !== 200 || typeof res.data !== 'string') {
    console.warn(
      `${LOG_PREFIX} Arquivo: falha na 1.ª página (${contentType}) status=${res.status} → ${firstUrl}`,
    );
    return pagesFetched;
  }

  pagesFetched += 1;
  const $ = cheerio.load(res.data);
  parseDisplayItems($, items, seenSlugs, contentType);
  visited.add(firstUrl);

  const maxPage = Math.min(detectMaxArchivePage($, res.data), ARCHIVE_MAX_PAGES);
  const baseList = firstUrl.replace(/\/$/, '');

  if (maxPage > 1) {
    const extraUrls = [];
    for (let p = 2; p <= maxPage; p++) {
      const u = normalizeListPageUrl(listPageUrlForIndex(`${baseList}/`, p));
      if (!visited.has(u)) extraUrls.push(u);
    }
    let parallelOk = 0;
    for (let i = 0; i < extraUrls.length; i += ARCHIVE_PAGE_CONCURRENCY) {
      const chunk = extraUrls.slice(i, i + ARCHIVE_PAGE_CONCURRENCY);
      const paths = chunk.map((u) => (u.startsWith(BASE_URL) ? u.slice(BASE_URL.length) || '/' : u));
      const responses = await fetchArchiveHtmlPaths(paths);
      chunk.forEach((u, idx) => {
        const r = responses[idx];
        if (!r || r.status !== 200 || typeof r.data !== 'string') return;
        parallelOk += 1;
        pagesFetched += 1;
        visited.add(u);
        parseDisplayItems(cheerio.load(r.data), items, seenSlugs, contentType);
      });
    }
    const useSequentialFallback = extraUrls.length > 0 && parallelOk === 0;
    if (!useSequentialFallback) return pagesFetched;
  }

  let url = nextListPageHref($, res.data);
  while (url) {
    const abs = normalizeListPageUrl(url);
    if (visited.has(abs)) break;
    visited.add(abs);
    const path = abs.startsWith(BASE_URL) ? abs.slice(BASE_URL.length) || '/' : abs;
    const resN = await client.get(path);
    if (resN.status !== 200 || typeof resN.data !== 'string') break;
    pagesFetched += 1;
    const $n = cheerio.load(resN.data);
    parseDisplayItems($n, items, seenSlugs, contentType);
    url = nextListPageHref($n, resN.data);
  }
  return pagesFetched;
}

async function buildSeriesCatalogFromArchive(startUrl) {
  const seen = new Set();
  const items = [];
  const archivePages = await fetchAllArchivePagesInto(startUrl, items, seen, 'series');
  const { synopsisRequests, synopsisOk } = await hydrateCatalogSynopses(items, 'serie');
  return { items, archivePages, synopsisRequests, synopsisOk };
}

/** Catálogo /serie/ (séries portuguesas, sem o arquivo de novelas). */
async function getSeriesPortuguesas() {
  const now = Date.now();
  if (seriesPortuguesasCache && now - seriesPortuguesasCache.time < CACHE_MS) {
    logCatalogCacheHit('séries portuguesas', seriesPortuguesasCache.items.length, seriesPortuguesasCache.time);
    return seriesPortuguesasCache.items;
  }
  const t0 = Date.now();
  const { items, archivePages, synopsisRequests, synopsisOk } = await buildSeriesCatalogFromArchive(
    SERIES_ARCHIVE,
  );
  seriesPortuguesasCache = { time: now, items };
  logCatalogRefresh('séries portuguesas', SERIES_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  return items;
}

/** Catálogo /genero/novelas/ (novelas portuguesas). */
async function getNovelasPortuguesas() {
  const now = Date.now();
  if (novelasPortuguesasCache && now - novelasPortuguesasCache.time < CACHE_MS) {
    logCatalogCacheHit('novelas portuguesas', novelasPortuguesasCache.items.length, novelasPortuguesasCache.time);
    return novelasPortuguesasCache.items;
  }
  const t0 = Date.now();
  const { items, archivePages, synopsisRequests, synopsisOk } = await buildSeriesCatalogFromArchive(
    NOVELAS_GENRE_ARCHIVE,
  );
  novelasPortuguesasCache = { time: now, items };
  logCatalogRefresh('novelas portuguesas', NOVELAS_GENRE_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  return items;
}

function wpPostIdFromHtml(html) {
  const m = html.match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function getFilmeMeta(slug) {
  const res = await client.get(`/filme/${slug}/`);
  if (res.status !== 200 || typeof res.data !== 'string') return null;
  const html = res.data;
  const $ = cheerio.load(html);

  const rawName =
    $('h1').first().text().trim() ||
    $('.heading-archive, .display-page-heading h1').first().text().trim() ||
    slug.replace(/-/g, ' ');
  const name = toTitleCase(rawName);

  let year = null;
  const yMatch = $('body').text().match(/\((\d{4})\)/) || $('body').text().match(/\b(19|20)\d{2}\b/);
  if (yMatch) year = parseInt(yMatch[1] || yMatch[0], 10);

  let imdbId = null;
  const bodyText = $('body').text();
  const bodyHtml = $.html();
  const imdbMatch =
    bodyText.match(/IMDb[:\s]*(tt\d{7,9})/i) ||
    bodyText.match(/(tt\d{7,9})/) ||
    bodyHtml.match(/imdb\.com\/title\/(tt\d{7,9})/i);
  if (imdbMatch) imdbId = imdbMatch[1] || imdbMatch[0];

  let poster =
    $('meta[property="og:image"]').attr('content') ||
    $('.display-item img.thumb, .item-box img').first().attr('src') ||
    $('img.thumb, .poster img').first().attr('data-original');
  if (poster && !poster.startsWith('http')) poster = absoluteUrl(poster);
  if (poster) poster = poster.trim();

  const backdrop = extractSiteBackdropUrl($, poster);
  let background =
    backdrop || (poster ? upgradeTmdbToOriginalForBackdrop(poster) : undefined);
  if (background) background = background.trim();

  let description = extractSynopsis($);
  if (!description) {
    description =
      $('.plot, .description, .entry-content, .content, .single-desc').first().text().trim().slice(0, DESC_MAX) ||
      undefined;
  } else if (description.length > DESC_MAX) description = description.slice(0, DESC_MAX);

  const wpPostId =
    wpPostIdFromHtml(html) ||
    parseInt($('.zetaflix_player_option').first().attr('data-post') || '', 10) ||
    null;

  const item = {
    id: `novelaspt_movie_${slug}`,
    name,
    slug,
    type: 'movie',
    year: year || undefined,
    poster: poster || undefined,
    background: background || undefined,
    description,
    imdbId: imdbId || undefined,
    wpPostId: Number.isFinite(wpPostId) && wpPostId > 0 ? wpPostId : undefined,
  };
  await enrichMetaFromCinemeta(item, 'movie');
  return item;
}

async function getSeriesMeta(slug) {
  const res = await client.get(`/serie/${slug}/`);
  if (res.status !== 200 || typeof res.data !== 'string') return null;
  const html = res.data;
  const $ = cheerio.load(html);

  const rawName =
    $('h1').first().text().trim() ||
    $('.display-page-heading h1').first().text().trim() ||
    slug.replace(/-/g, ' ');
  const name = toTitleCase(rawName);

  let year = null;
  const yMatch = $('body').text().match(/\((\d{4})\)/) || $('body').text().match(/\b(19|20)\d{2}\b/);
  if (yMatch) year = parseInt(yMatch[1] || yMatch[0], 10);

  let imdbId = null;
  const bodyText = $('body').text();
  const bodyHtml = $.html();
  const imdbMatch =
    bodyText.match(/IMDb[:\s]*(tt\d{7,9})/i) ||
    bodyText.match(/(tt\d{7,9})/) ||
    bodyHtml.match(/imdb\.com\/title\/(tt\d{7,9})/i);
  if (imdbMatch) imdbId = imdbMatch[1] || imdbMatch[0];

  let poster = $('meta[property="og:image"]').attr('content');
  if (poster && !poster.startsWith('http')) poster = absoluteUrl(poster);
  if (poster) poster = poster.trim();

  const backdrop = extractSiteBackdropUrl($, poster);
  let background =
    backdrop || (poster ? upgradeTmdbToOriginalForBackdrop(poster) : undefined);
  if (background) background = background.trim();

  let description = extractSynopsis($);
  if (!description) {
    description =
      $('.plot, .description, .entry-content, .single-desc').first().text().trim().slice(0, DESC_MAX) ||
      undefined;
  } else if (description.length > DESC_MAX) description = description.slice(0, DESC_MAX);

  const rawEpisodes = [];
  $('.play-ep').each((_, el) => {
    const $el = $(el);
    const wpPid = parseInt($el.attr('data-pid') || '', 10);
    const episode = parseInt($el.attr('data-epid') || '', 10);
    const rawSsid = parseInt($el.attr('data-ssid') || '', 10);
    if (!Number.isFinite(wpPid) || wpPid <= 0) return;
    if (!Number.isFinite(episode) || episode < 1) return;
    if (!Number.isFinite(rawSsid) || rawSsid < 1) return;

    const epTitle = $el.find('.ep-title').first().text().trim();
    const epName = epTitle || `Episódio ${episode}`;

    if (!rawEpisodes.some((e) => e.rawSsid === rawSsid && e.episode === episode)) {
      rawEpisodes.push({
        rawSsid,
        episode,
        wpPid,
        name: epName,
      });
    }
  });

  const episodes = remapEpisodeSeasons(rawEpisodes);
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

  const item = {
    id: `novelaspt_series_${slug}`,
    name,
    slug,
    type: 'series',
    year: year || undefined,
    poster: poster || undefined,
    background: background || undefined,
    description,
    imdbId: imdbId || undefined,
    episodes,
  };
  await enrichMetaFromCinemeta(item, 'series');
  return item;
}

/**
 * Opções de stream para filme (iframe URLs) via zetaplayer: /{postId}/mv/{n}
 */
async function getMovieStreamSources(wpPostId) {
  if (!wpPostId) return [];
  const out = [];
  for (let n = 1; n <= 30; n++) {
    const res = await zetaClient.get(`/${wpPostId}/mv/${n}`);
    if (res.status !== 200 || !res.data) break;
    const d = res.data;
    if (d.type === false && !d.embed_url) break;
    if (!d.embed_url || typeof d.embed_url !== 'string') continue;
    let u = d.embed_url.trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('http://')) u = u.replace(/^http:\/\//i, 'https://');
    out.push({
      type: 'url',
      title: `Opção ${n}`,
      url: u,
    });
  }
  return out;
}

/**
 * Opções de stream para episódio (cada episódio = post WP com data-pid).
 */
async function getTvEpisodeStreamSources(wpEpisodePid) {
  if (!wpEpisodePid) return [];
  const res = await zetaClient.get(`/tvep/${wpEpisodePid}`);
  if (res.status !== 200 || !res.data) return [];

  const embed = res.data.embed;
  if (!Array.isArray(embed) || embed.length === 0) return [];

  return embed
    .map((item, i) => {
      let u = (item.code || '').trim();
      if (u.startsWith('//')) u = 'https:' + u;
      if (u.startsWith('http://')) u = u.replace(/^http:\/\//i, 'https://');
      const title = item.name || item.title || `Opção ${item.num || i + 1}`;
      return u ? { type: 'url', title, url: u } : null;
    })
    .filter(Boolean);
}

async function getSeriesEpisodes(seriesSlug) {
  const meta = await getSeriesMeta(seriesSlug);
  if (!meta || !meta.episodes) return [];
  return meta.episodes;
}

module.exports = {
  BASE_URL,
  getFilmes,
  getSeriesPortuguesas,
  getNovelasPortuguesas,
  getFilmeMeta,
  getSeriesMeta,
  getMovieStreamSources,
  getTvEpisodeStreamSources,
  getSeriesEpisodes,
};
