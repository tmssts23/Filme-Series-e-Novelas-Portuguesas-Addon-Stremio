/**
 * Scraper para Novelas Portuguesas (novelasportuguesas.com) — tema Zetaflix / WordPress.
 * Catálogo: listagens .display-item; players: REST zetaplayer/v2.
 */

const http = require('http');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const { getMetaByImdbId, findImdbIdByTitle } = require('./cinemeta');

const BASE_URL = 'https://novelasportuguesas.com';
const FILMES_ARCHIVE = `${BASE_URL}/filme/`;
const SERIES_ARCHIVE = `${BASE_URL}/serie/`;
const NOVELAS_GENRE_ARCHIVE = `${BASE_URL}/genero/novelas/`;
const ZETA_API = `${BASE_URL}/wp-json/zetaplayer/v2`;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Render / Fly / etc.: menos sockets e mais timeout reduz ETIMEDOUT e saturação. */
const IS_CLOUD_HOST =
  process.env.RENDER === 'true' ||
  !!process.env.FLY_APP_NAME ||
  process.env.STREMIO_NP_LOW_CONCURRENCY === '1';

const HTTP_TIMEOUT_MS = Math.max(
  8000,
  Number(process.env.STREMIO_NP_HTTP_TIMEOUT_MS) || (IS_CLOUD_HOST ? 45000 : 25000),
);

const HTTPS_MAX_SOCKETS = Math.max(
  4,
  Number(process.env.STREMIO_NP_MAX_HTTPS_SOCKETS) || (IS_CLOUD_HOST ? 40 : 64),
);

const httpsKeepAlive = new https.Agent({ keepAlive: true, maxSockets: HTTPS_MAX_SOCKETS });
const httpKeepAlive = new http.Agent({ keepAlive: true, maxSockets: HTTPS_MAX_SOCKETS });

const client = axios.create({
  baseURL: BASE_URL,
  timeout: HTTP_TIMEOUT_MS,
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
  timeout: Math.min(120000, Math.max(12000, HTTP_TIMEOUT_MS)),
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
  const synPart =
    CATALOG_SYNOPSIS_ENABLED || CATALOG_RELEASE_ENABLED
      ? ` | páginas de detalhe (resumo/ano): ${synopsisRequests} pedidos, ${synopsisOk} OK`
      : IS_CLOUD_HOST
        ? ' | grelha rápida: sem resumo/ano extra (defeito na cloud; STREMIO_NP_CATALOG_SYNOPSIS=1 ou STREMIO_NP_CATALOG_RELEASE=1 para ativar)'
        : ' | páginas de detalhe: desativadas (STREMIO_NP_CATALOG_SYNOPSIS=0 e STREMIO_NP_CATALOG_RELEASE=0)';
  console.log(
    `${LOG_PREFIX} REFRESH catálogo [${label}] ${items} títulos | páginas de arquivo (listagem): ${archivePages}${synPart} | ${ms} ms | fonte: ${startUrl}`,
  );
}

/**
 * Resumo / ano na grelha do catálogo = 1 pedido HTTP por título (muito lento na Render com centenas de filmes).
 * Cloud: só ativo com STREMIO_NP_CATALOG_SYNOPSIS=1 ou STREMIO_NP_CATALOG_RELEASE=1.
 * Local: ativo por defeito; desativar com =0.
 */
const CATALOG_SYNOPSIS_ENABLED = IS_CLOUD_HOST
  ? process.env.STREMIO_NP_CATALOG_SYNOPSIS === '1'
  : process.env.STREMIO_NP_CATALOG_SYNOPSIS !== '0';
const CATALOG_RELEASE_ENABLED = IS_CLOUD_HOST
  ? process.env.STREMIO_NP_CATALOG_RELEASE === '1'
  : process.env.STREMIO_NP_CATALOG_RELEASE !== '0';
const CATALOG_SYNOPSIS_CONCURRENCY = Math.max(
  1,
  Number(process.env.STREMIO_NP_SYNOPSIS_CONCURRENCY) || (IS_CLOUD_HOST ? 16 : 10),
);
/** 0 = todos os títulos; senão limita quantos resumos buscar por refresh do catálogo */
const CATALOG_SYNOPSIS_MAX = Number(process.env.STREMIO_NP_MAX_SYNOPSIS);
const CATALOG_DESC_PREVIEW_LEN = Math.min(2000, Number(process.env.STREMIO_NP_CATALOG_DESC_LEN) || 900);

/** Pedidos paralelos às páginas de arquivo (listagens WordPress) */
const ARCHIVE_PAGE_CONCURRENCY = Math.max(
  1,
  Number(process.env.STREMIO_NP_ARCHIVE_CONCURRENCY) || (IS_CLOUD_HOST ? 12 : 10),
);
/** Limite de páginas de arquivo (evita números errados na paginação) */
const ARCHIVE_MAX_PAGES = Math.max(1, Number(process.env.STREMIO_NP_MAX_ARCHIVE_PAGES) || 500);

if (IS_CLOUD_HOST) {
  const hyd =
    CATALOG_SYNOPSIS_ENABLED || CATALOG_RELEASE_ENABLED
      ? `grelha+detalhe ON (×${CATALOG_SYNOPSIS_CONCURRENCY}; pode demorar com muitos títulos)`
      : 'grelha+detalhe OFF (só listagens; ano/resumo ao abrir o título)';
  console.log(
    `${LOG_PREFIX} Cloud: ${HTTP_TIMEOUT_MS}ms | sockets ${HTTPS_MAX_SOCKETS} | arquivo×${ARCHIVE_PAGE_CONCURRENCY} | ${hyd}`,
  );
}

const RETRYABLE_NET_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

function logScrapeNetworkError(ctx, path, err) {
  const code = err && (err.code || err.cause?.code);
  const msg = (err && err.message) || String(err);
  const line = `${code ? `[${code}] ` : ''}${msg}`.slice(0, 200);
  console.warn(`${LOG_PREFIX} ${ctx}: ${path} → ${line}`);
}

/**
 * GET ao site com reintentos; não lança — devolve a resposta Axios ou null (logs concisos).
 */
async function safeClientGet(path, retries = 3) {
  const n = Math.max(1, retries);
  for (let attempt = 1; attempt <= n; attempt++) {
    try {
      return await client.get(path);
    } catch (e) {
      const code = e && (e.code || e.cause?.code);
      const canRetry = attempt < n && RETRYABLE_NET_CODES.has(code);
      if (canRetry) {
        const wait = 500 * attempt;
        console.warn(
          `${LOG_PREFIX} GET ${path} ${code || 'erro'} (${attempt}/${n}) → nova tentativa em ${wait}ms`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      logScrapeNetworkError('GET falhou', path, e);
      return null;
    }
  }
  return null;
}

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
 * Ano ou período (ex.: 2010–2015) a partir do bloco .details-desc do tema Zetaflix.
 * @param {'movie'|'series'} contentType
 * @returns {{ year?: number, releaseInfo?: string }|null}
 */
function extractReleaseInfoFromDetailPage($, contentType) {
  const raw = $('.details-desc')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
  const h1 = $('h1').first().text().replace(/\s+/g, ' ').trim().normalize('NFC');

  if (contentType === 'movie') {
    const m = raw.match(/Ano do Filme:\s*((?:19|20)\d{2})(?!\d)/i);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1870 && y <= 2100) return { year: y, releaseInfo: String(y) };
    }
  } else {
    const m =
      raw.match(/Ano da\s+Série:\s*((?:19|20)\d{2})(?!\d)/i) ||
      raw.match(/Ano do\s+Série:\s*((?:19|20)\d{2})(?!\d)/i) ||
      raw.match(/Ano da\s+Serie:\s*((?:19|20)\d{2})(?!\d)/i) ||
      raw.match(/Ano do\s+Serie:\s*((?:19|20)\d{2})(?!\d)/i) ||
      raw.match(/Ano da\s+[Ss][ée]rie:\s*((?:19|20)\d{2})(?!\d)/i) ||
      raw.match(/Ano do\s+[Ss][ée]rie:\s*((?:19|20)\d{2})(?!\d)/i);
    if (m) {
      const y = parseInt(m[1], 10);
      if (y >= 1870 && y <= 2100) return { year: y, releaseInfo: String(y) };
    }
  }

  const periodMatch = raw.match(
    /Per[ií]odo(?:\s+de exibi[cç][aã]o)?\s*:\s*(.+?)(?=(?:Nome do|Nome da|Ano do|Ano da|Resumo)|$)/i,
  );
  if (periodMatch) {
    const slice = periodMatch[1].trim().replace(/\s*-\s*/g, '-');
    const years = slice.match(/\b((?:19|20)\d{2})\b/g);
    if (years && years.length >= 2) {
      const ys = [...new Set(years.map((y) => parseInt(y, 10)))].sort((a, b) => a - b);
      return {
        year: ys[0],
        releaseInfo: `${ys[0]}-${ys[ys.length - 1]}`,
      };
    }
    if (years && years.length === 1) {
      const y = parseInt(years[0], 10);
      if (y >= 1870 && y <= 2100) return { year: y, releaseInfo: String(y) };
    }
  }

  const paren = h1.match(/\((\d{4})\)/);
  if (paren) {
    const y = parseInt(paren[1], 10);
    if (y >= 1870 && y <= 2100) return { year: y, releaseInfo: String(y) };
  }

  return null;
}

const META_YEAR_MIN = 1870;
const META_YEAR_MAX = 2100;

function isPlausibleMetaYear(y) {
  const n = typeof y === 'number' ? y : parseInt(String(y), 10);
  return Number.isFinite(n) && n >= META_YEAR_MIN && n <= META_YEAR_MAX;
}

/** Remove anos absurdos (ex. 20 por regex antigo) e releaseInfo só com 1–3 dígitos. */
function sanitizeItemYearRelease(item) {
  if (item.year != null) {
    if (!isPlausibleMetaYear(item.year)) {
      delete item.year;
    } else {
      item.year = typeof item.year === 'number' ? item.year : parseInt(String(item.year), 10);
    }
  }
  if (item.releaseInfo != null) {
    const s = String(item.releaseInfo).trim();
    if (/^\d{1,3}$/.test(s)) {
      delete item.releaseInfo;
    }
  }
  if (item.year != null && (item.releaseInfo == null || String(item.releaseInfo).trim() === '')) {
    item.releaseInfo = String(item.year);
  }
}

function assignReleaseFromDetail($, item, contentType) {
  const rel = extractReleaseInfoFromDetailPage($, contentType);
  if (!rel) return;
  if (rel.year != null) item.year = rel.year;
  if (rel.releaseInfo != null && String(rel.releaseInfo).trim() !== '') {
    item.releaseInfo = String(rel.releaseInfo).trim();
  } else if (rel.year != null) {
    item.releaseInfo = String(rel.year);
  }
  sanitizeItemYearRelease(item);
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

/**
 * Hiperligação para a ficha IMDb.
 * Categoria `imdb` é reservada no SDK mas é o que o cliente Stremio trata à parte: botão IMDb com
 * target="_blank" e aviso stremio.com/warning → abre no browser do sistema (não só na webview).
 * O campo `url` deve ser só o id tt… — o UI monta https://www.imdb.com/title/<url>.
 */
function imdbPageLink(imdbIdClean, ratingStr) {
  const name =
    ratingStr != null && String(ratingStr).trim() !== ''
      ? `IMDb ${String(ratingStr).trim()}/10`
      : 'IMDb';
  return {
    name,
    category: 'imdb',
    url: imdbIdClean,
  };
}

async function enrichMetaFromCinemeta(item, stremioType) {
  const rawId = item.imdbId && String(item.imdbId).trim();
  if (!rawId || !rawId.toLowerCase().startsWith('tt')) return item;
  const imdbIdClean = rawId.toLowerCase();

  try {
    const cm = await getMetaByImdbId(stremioType, item.imdbId);
    const siteDesc = (item.description || '').trim();

    if (cm) {
      if (siteDesc.length < 160 && cm.description) {
        item.description = siteDesc
          ? `${siteDesc}\n\n${cm.description}`.trim().slice(0, DESC_MAX)
          : cm.description.slice(0, DESC_MAX);
      }
      if (cm.poster && !item.poster) item.poster = cm.poster;
      if (cm.background && !item.background) item.background = cm.background;
      if (cm.genres?.length && !item.genres?.length) item.genres = cm.genres;
      if (cm.cast && !item.cast) item.cast = cm.cast;
      if (cm.director && !item.director) item.director = cm.director;
      if (cm.runtime && !item.runtime) item.runtime = cm.runtime;
      if (cm.imdbRating != null) item.imdbRating = cm.imdbRating;
      if (cm.trailers?.length) item.trailers = cm.trailers;
      /* Não copiar releaseInfo/released do Cinemeta: substitui o ano do site (ex. Lulu 2025 → 1980)
         e o Stremio funde metas → “20” / ano errado. Ano fica só do HTML + findImdbId. */
    }

    const links = [imdbPageLink(imdbIdClean, item.imdbRating)];
    const tr = item.trailers;
    const yt =
      Array.isArray(tr) &&
      tr.find((t) => t && typeof t.source === 'string' && t.source.trim());
    if (yt) {
      const vid = yt.source.trim();
      links.push({
        name: 'Trailer (YouTube)',
        category: 'trailers',
        url: `https://www.youtube.com/watch?v=${vid}`,
      });
    } else {
      links.push({
        name: 'Trailers / vídeos (IMDb)',
        category: 'trailers',
        url: `https://www.imdb.com/title/${imdbIdClean}/videogallery/`,
      });
    }
    item.links = links;

    sanitizeItemYearRelease(item);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.warn(`${LOG_PREFIX} enrichMetaFromCinemeta ignorado (${item.slug || item.name}): ${msg.slice(0, 120)}`);
  }
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
 * Páginas de detalhe: resumo (opcional) e ano / período de lançamento para o catálogo Stremio.
 * @returns {{ synopsisRequests: number, synopsisOk: number }}
 */
async function hydrateCatalogSynopses(items, wpPathSeg) {
  const wantSynopsis = CATALOG_SYNOPSIS_ENABLED;
  const wantRelease = CATALOG_RELEASE_ENABLED;
  if ((!wantSynopsis && !wantRelease) || !items.length) {
    return { synopsisRequests: 0, synopsisOk: 0 };
  }

  const synopsisCap =
    wantSynopsis && Number.isFinite(CATALOG_SYNOPSIS_MAX) && CATALOG_SYNOPSIS_MAX > 0
      ? CATALOG_SYNOPSIS_MAX
      : Infinity;

  const contentType = wpPathSeg === 'filme' ? 'movie' : 'series';

  const needsDetailFetch = (item, indexInAll) => {
    const needRelease = wantRelease && item.year == null && item.releaseInfo == null;
    const needSynopsis = wantSynopsis && !item.description && indexInAll < synopsisCap;
    return needRelease || needSynopsis;
  };

  let synopsisRequests = 0;
  let synopsisOk = 0;

  const estFetches = items.filter((it, idx) => needsDetailFetch(it, idx)).length;
  if (estFetches > 80) {
    console.log(
      `${LOG_PREFIX} Catálogo (${wpPathSeg}): a consultar ~${estFetches} páginas de detalhe (resumo e/ou ano)…`,
    );
  }

  for (let i = 0; i < items.length; i += CATALOG_SYNOPSIS_CONCURRENCY) {
    const batch = items.slice(i, i + CATALOG_SYNOPSIS_CONCURRENCY);
    await Promise.all(
      batch.map(async (item, j) => {
        const idx = i + j;
        if (!needsDetailFetch(item, idx)) return;
        try {
          synopsisRequests += 1;
          const res = await safeClientGet(`/${wpPathSeg}/${item.slug}/`, 2);
          if (!res || res.status !== 200 || typeof res.data !== 'string') return;
          synopsisOk += 1;
          const $ = cheerio.load(res.data);
          assignReleaseFromDetail($, item, contentType);
          if (wantSynopsis && !item.description && idx < synopsisCap) {
            const desc = extractSynopsis($);
            if (desc) item.description = desc.slice(0, CATALOG_DESC_PREVIEW_LEN);
          }
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
    sanitizeCatalogItems(filmesCache.items);
    return filmesCache.items;
  }

  const t0 = Date.now();
  const seen = new Set();
  const items = [];
  const archivePages = await fetchAllArchivePagesInto(FILMES_ARCHIVE, items, seen, 'movie');
  if (archivePages === 0 && items.length === 0) {
    console.warn(
      `${LOG_PREFIX} REFRESH filmes: rede/site indisponível (0 páginas). Mantém cache anterior se existir.`,
    );
    if (filmesCache && filmesCache.items.length) {
      sanitizeCatalogItems(filmesCache.items);
      return filmesCache.items;
    }
    return [];
  }
  const { synopsisRequests, synopsisOk } = await hydrateCatalogSynopses(items, 'filme');
  filmesCache = { time: now, items };
  logCatalogRefresh('filmes', FILMES_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  sanitizeCatalogItems(items);
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
  const list = await Promise.all(paths.map((path) => safeClientGet(path, 3)));
  return list.map((res, i) => {
    if (res && res.status === 200 && typeof res.data === 'string') return res;
    if (paths[i]) {
      console.warn(`${LOG_PREFIX} arquivo listagem ignorada (falha/rede): ${paths[i]}`);
    }
    return { status: 0, data: '' };
  });
}

/**
 * Percorre o arquivo WordPress e preenche `items`. Devolve quantas páginas de listagem foram obtidas com sucesso.
 */
async function fetchAllArchivePagesInto(startUrl, items, seenSlugs, contentType) {
  let pagesFetched = 0;
  const firstUrl = normalizeListPageUrl(startUrl);
  const visited = new Set();

  const firstPath = firstUrl.startsWith(BASE_URL) ? firstUrl.slice(BASE_URL.length) || '/' : firstUrl;
  const res = await safeClientGet(firstPath, 4);
  if (!res || res.status !== 200 || typeof res.data !== 'string') {
    console.warn(
      `${LOG_PREFIX} Arquivo: falha na 1.ª página (${contentType}) ${res ? `status=${res.status}` : 'sem resposta'} → ${firstUrl}`,
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
    const resN = await safeClientGet(path, 3);
    if (!resN || resN.status !== 200 || typeof resN.data !== 'string') break;
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
    sanitizeCatalogItems(seriesPortuguesasCache.items);
    return seriesPortuguesasCache.items;
  }
  const t0 = Date.now();
  const { items, archivePages, synopsisRequests, synopsisOk } = await buildSeriesCatalogFromArchive(
    SERIES_ARCHIVE,
  );
  if (archivePages === 0 && items.length === 0) {
    console.warn(
      `${LOG_PREFIX} REFRESH séries: rede/site indisponível. Mantém cache anterior se existir.`,
    );
    if (seriesPortuguesasCache && seriesPortuguesasCache.items.length) {
      sanitizeCatalogItems(seriesPortuguesasCache.items);
      return seriesPortuguesasCache.items;
    }
    return [];
  }
  seriesPortuguesasCache = { time: now, items };
  logCatalogRefresh('séries portuguesas', SERIES_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  sanitizeCatalogItems(items);
  return items;
}

/** Catálogo /genero/novelas/ (novelas portuguesas). */
async function getNovelasPortuguesas() {
  const now = Date.now();
  if (novelasPortuguesasCache && now - novelasPortuguesasCache.time < CACHE_MS) {
    logCatalogCacheHit('novelas portuguesas', novelasPortuguesasCache.items.length, novelasPortuguesasCache.time);
    sanitizeCatalogItems(novelasPortuguesasCache.items);
    return novelasPortuguesasCache.items;
  }
  const t0 = Date.now();
  const { items, archivePages, synopsisRequests, synopsisOk } = await buildSeriesCatalogFromArchive(
    NOVELAS_GENRE_ARCHIVE,
  );
  if (archivePages === 0 && items.length === 0) {
    console.warn(
      `${LOG_PREFIX} REFRESH novelas: rede/site indisponível. Mantém cache anterior se existir.`,
    );
    if (novelasPortuguesasCache && novelasPortuguesasCache.items.length) {
      sanitizeCatalogItems(novelasPortuguesasCache.items);
      return novelasPortuguesasCache.items;
    }
    return [];
  }
  novelasPortuguesasCache = { time: now, items };
  logCatalogRefresh('novelas portuguesas', NOVELAS_GENRE_ARCHIVE, {
    items: items.length,
    archivePages,
    synopsisRequests,
    synopsisOk,
    ms: Date.now() - t0,
  });
  sanitizeCatalogItems(items);
  return items;
}

function wpPostIdFromHtml(html) {
  const m = html.match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function getFilmeMeta(slug) {
  const res = await safeClientGet(`/filme/${slug}/`, 3);
  if (!res || res.status !== 200 || typeof res.data !== 'string') return null;
  const html = res.data;
  const $ = cheerio.load(html);

  const rawName =
    $('h1').first().text().trim() ||
    $('.heading-archive, .display-page-heading h1').first().text().trim() ||
    slug.replace(/-/g, ' ');
  const name = toTitleCase(rawName);

  let year = null;
  let releaseInfo = null;
  const rel = extractReleaseInfoFromDetailPage($, 'movie');
  if (rel) {
    if (rel.year != null) year = rel.year;
    if (rel.releaseInfo != null) releaseInfo = String(rel.releaseInfo).trim();
  }
  if (year == null) {
    const h1y = $('h1').first().text().match(/\((\d{4})\)/);
    const bodyOneLine = $('body').text().replace(/\s+/g, ' ');
    const bodyAno = bodyOneLine.match(/\bAno do\s+Filme:\s*((?:19|20)\d{2})(?!\d)/i);
    const yMatch = h1y || bodyAno;
    if (yMatch) year = parseInt(yMatch[1], 10);
  }
  if (!releaseInfo && year != null) releaseInfo = String(year);

  let imdbId = null;
  const bodyText = $('body').text();
  const bodyHtml = $.html();
  const imdbMatch =
    bodyText.match(/IMDb[:\s]*(tt\d{7,9})/i) ||
    bodyText.match(/(tt\d{7,9})/) ||
    bodyHtml.match(/imdb\.com\/title\/(tt\d{7,9})/i);
  if (imdbMatch) imdbId = imdbMatch[1] || imdbMatch[0];

  const itemPre = { year, releaseInfo };
  sanitizeItemYearRelease(itemPre);
  year = itemPre.year ?? null;
  releaseInfo = itemPre.releaseInfo ?? null;

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
    releaseInfo: releaseInfo || undefined,
    poster: poster || undefined,
    background: background || undefined,
    description,
    imdbId: imdbId || undefined,
    wpPostId: Number.isFinite(wpPostId) && wpPostId > 0 ? wpPostId : undefined,
  };
  if (!item.imdbId) {
    const resolved = await findImdbIdByTitle('movie', item.name, item.year ?? null);
    if (resolved) item.imdbId = resolved;
  }
  await enrichMetaFromCinemeta(item, 'movie');
  sanitizeItemYearRelease(item);
  return item;
}

async function getSeriesMeta(slug) {
  const res = await safeClientGet(`/serie/${slug}/`, 3);
  if (!res || res.status !== 200 || typeof res.data !== 'string') return null;
  const html = res.data;
  const $ = cheerio.load(html);

  const rawName =
    $('h1').first().text().trim() ||
    $('.display-page-heading h1').first().text().trim() ||
    slug.replace(/-/g, ' ');
  const name = toTitleCase(rawName);

  let year = null;
  let releaseInfo = null;
  const relS = extractReleaseInfoFromDetailPage($, 'series');
  if (relS) {
    if (relS.year != null) year = relS.year;
    if (relS.releaseInfo != null) releaseInfo = String(relS.releaseInfo).trim();
  }
  if (year == null) {
    const h1y = $('h1').first().text().match(/\((\d{4})\)/);
    const bodyOneLine = $('body').text().replace(/\s+/g, ' ');
    const bodyAno =
      bodyOneLine.match(/\bAno do\s+Série:\s*((?:19|20)\d{2})(?!\d)/i) ||
      bodyOneLine.match(/\bAno da\s+Série:\s*((?:19|20)\d{2})(?!\d)/i);
    const yMatch = h1y || bodyAno;
    if (yMatch) year = parseInt(yMatch[1], 10);
  }
  if (!releaseInfo && year != null) releaseInfo = String(year);

  let imdbId = null;
  const bodyText = $('body').text();
  const bodyHtml = $.html();
  const imdbMatch =
    bodyText.match(/IMDb[:\s]*(tt\d{7,9})/i) ||
    bodyText.match(/(tt\d{7,9})/) ||
    bodyHtml.match(/imdb\.com\/title\/(tt\d{7,9})/i);
  if (imdbMatch) imdbId = imdbMatch[1] || imdbMatch[0];

  const itemPreS = { year, releaseInfo };
  sanitizeItemYearRelease(itemPreS);
  year = itemPreS.year ?? null;
  releaseInfo = itemPreS.releaseInfo ?? null;

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
    releaseInfo: releaseInfo || undefined,
    poster: poster || undefined,
    background: background || undefined,
    description,
    imdbId: imdbId || undefined,
    episodes,
  };
  if (!item.imdbId) {
    const resolved = await findImdbIdByTitle('series', item.name, item.year ?? null);
    if (resolved) item.imdbId = resolved;
  }
  await enrichMetaFromCinemeta(item, 'series');
  sanitizeItemYearRelease(item);
  return item;
}

/**
 * Opções de stream para filme (iframe URLs) via zetaplayer: /{postId}/mv/{n}
 */
function normalizeStreamUrlKey(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const x = new URL(u.trim());
    return `${x.origin}${x.pathname}${x.search}`.toLowerCase();
  } catch (_) {
    return u.trim().toLowerCase();
  }
}

async function getMovieStreamSources(wpPostId) {
  if (!wpPostId) return [];
  const out = [];
  const seen = new Set();
  for (let n = 1; n <= 30; n++) {
    let res;
    try {
      res = await zetaClient.get(`/${wpPostId}/mv/${n}`);
    } catch (e) {
      logScrapeNetworkError('zeta', `/${wpPostId}/mv/${n}`, e);
      break;
    }
    if (res.status !== 200 || !res.data) break;
    const d = res.data;
    if (d.type === false && !d.embed_url) break;
    if (!d.embed_url || typeof d.embed_url !== 'string') continue;
    let u = d.embed_url.trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('http://')) u = u.replace(/^http:\/\//i, 'https://');
    const key = normalizeStreamUrlKey(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: 'url',
      title: `Opção ${out.length + 1}`,
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
  let res;
  try {
    res = await zetaClient.get(`/tvep/${wpEpisodePid}`);
  } catch (e) {
    logScrapeNetworkError('zeta', `/tvep/${wpEpisodePid}`, e);
    return [];
  }
  if (res.status !== 200 || !res.data) return [];

  const embed = res.data.embed;
  if (!Array.isArray(embed) || embed.length === 0) return [];

  const seen = new Set();
  const rows = [];
  for (let i = 0; i < embed.length; i++) {
    const item = embed[i];
    let u = (item.code || '').trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('http://')) u = u.replace(/^http:\/\//i, 'https://');
    if (!u) continue;
    const key = normalizeStreamUrlKey(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = item.name || item.title || `Opção ${rows.length + 1}`;
    rows.push({ type: 'url', title, url: u });
  }
  return rows;
}

async function getSeriesEpisodes(seriesSlug) {
  const meta = await getSeriesMeta(seriesSlug);
  if (!meta || !meta.episodes) return [];
  return meta.episodes;
}

function sanitizeCatalogItems(items) {
  if (!Array.isArray(items) || !items.length) return items;
  for (const it of items) {
    sanitizeItemYearRelease(it);
  }
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
  getSeriesEpisodes,
};
