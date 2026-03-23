/**
 * Addon Stremio — Filmes, Series e Novelas Portuguesas (novelasportuguesas.com)
 * Reprodução: externalUrl (players iframe do site).
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scraper = require('./lib/scraper');

const PORT = process.env.PORT || 7000;
const LOG_PREFIX = '[NovelasPT]';
/**
 * Por defeito NÃO enviamos imdbId/imdb_id no JSON do meta: o Stremio costuma fundir com o Cinemeta
 * pelo mesmo tt e substituir ano/nota (efeito “pisca certo e fica 20 / sem IMDb”).
 * Para expor: STREMIO_NP_EXPOSE_IMDB_ID=1
 */
const EXPOSE_IMDB_ID_TO_CLIENT = process.env.STREMIO_NP_EXPOSE_IMDB_ID === '1';

// Prefixo dos nossos IDs
const MOVIE_PREFIX = 'novelaspt_movie_';
const SERIES_PREFIX = 'novelaspt_series_';

/** Nome apresentado no Stremio (pedido: “Filmes, Series e Novelas … Addon Stremio”). */
const ADDON_DISPLAY_NAME = 'Filmes, Series e Novelas Portuguesas Addon Stremio';

/** Base URL pública (ex.: https://teu-túnel.ngrok.app) para o campo `logo` do manifest. */
function manifestOriginFromRequest(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const raw = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = raw === 'https' || raw === 'http' ? raw : 'http';
  return `${proto}://${host}`;
}

function getManifest(config, originBase) {
  const base = { configurable: false, configurationRequired: false };
  const origin = originBase && String(originBase).replace(/\/$/, '');
  /* Stremio: campo logo = URL para PNG (SVG costuma ser ignorado → ícone puzzle). */
  const logo = origin ? `${origin}/addon-logo.png` : undefined;
  return {
    id: 'pt.filmes-series-portuguesas',
    name: ADDON_DISPLAY_NAME,
    description:
      'Filmes, séries e novelas portugueses. Catálogos separados: filmes, séries portuguesas e novelas portuguesas. Os reprodutores abrem no browser (URL externa).',
    version: '1.0.19',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: [MOVIE_PREFIX, SERIES_PREFIX],
    ...(logo ? { logo } : {}),
    catalogs: [
      {
        type: 'movie',
        id: 'novelaspt_filmes',
        name: 'Filmes Portugueses',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false },
        ],
      },
      {
        type: 'series',
        id: 'novelaspt_series',
        name: 'Séries Portuguesas',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false },
        ],
      },
      {
        type: 'series',
        id: 'novelaspt_novelas',
        name: 'Novelas Portuguesas',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'skip', isRequired: false },
        ],
      },
    ],
    behaviorHints: base,
    stremioAddonsConfig: {
      issuer: 'https://stremio-addons.net',
      signature:
        'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..CvmszUdKMfeHbghC9AHUrg.yH5koKZYZegsGzt5niT80p9iegzINGvYKaBGqboGYbCaomKmUBr_FWYB7xH3cmXNT8qf2xFNxBsMMmWEUt-vzY2N_daIh1uLIMihzvN6aygGHV5AAjyrJmqG4anQYQ5U.u3_ityrxIwgFlCZg2n7DHg',
    },
  };
}

const STREMIO_YEAR_MIN = 1870;
const STREMIO_YEAR_MAX = 2100;

function plausibleStremioYear(y) {
  if (y == null) return null;
  const n = typeof y === 'number' ? y : parseInt(String(y), 10);
  if (!Number.isFinite(n) || n < STREMIO_YEAR_MIN || n > STREMIO_YEAR_MAX) return null;
  return n;
}

/**
 * Só `releaseInfo` (string) para o ano no meta Stremio — não enviamos `year` numérico nem `released` no
 * objeto meta (evita clientes a mostrarem fragmentos tipo “20”).
 */
function stremioReleaseInfoFromItem(item) {
  const ri = item.releaseInfo != null ? String(item.releaseInfo).trim() : '';
  if (ri) {
    if (/^\d{1,3}$/.test(ri)) return undefined;
    return ri;
  }
  const y = plausibleStremioYear(item.year);
  return y != null ? String(y) : undefined;
}

/** Ano base (número) para datas sintéticas em `videos` de séries. */
function seriesBaseYearForVideos(item) {
  const y = plausibleStremioYear(item.year);
  if (y != null) return y;
  const ri = item.releaseInfo != null ? String(item.releaseInfo).trim() : '';
  const m = ri.match(/((?:19|20)\d{2})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= STREMIO_YEAR_MIN && n <= STREMIO_YEAR_MAX) return n;
  }
  return null;
}

function metaPreviewFromItem(item) {
  const releaseInfo = stremioReleaseInfoFromItem(item);
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    posterShape: 'poster',
    description: item.description,
    ...(releaseInfo != null && { releaseInfo }),
    ...(EXPOSE_IMDB_ID_TO_CLIENT &&
      item.imdbId != null && { imdbId: item.imdbId, imdb_id: item.imdbId }),
    ...(item.imdbRating != null && item.imdbRating !== '' && { imdbRating: String(item.imdbRating) }),
  };
}

function metaFullFromItem(item) {
  const releaseInfo = stremioReleaseInfoFromItem(item);
  const base = {
    id: item.id,
    type: item.type,
    name: item.name,
    posterShape: 'poster',
    ...(item.poster != null && { poster: item.poster }),
    ...(item.description != null && item.description !== '' && { description: item.description }),
    ...(releaseInfo != null && { releaseInfo }),
    ...(EXPOSE_IMDB_ID_TO_CLIENT &&
      item.imdbId != null && { imdbId: item.imdbId, imdb_id: item.imdbId }),
    ...(item.background != null && { background: item.background }),
    ...(item.genres != null && item.genres.length > 0 && { genres: item.genres }),
    ...(item.cast != null && { cast: item.cast }),
    ...(item.director != null && { director: item.director }),
    ...(item.imdbRating != null && item.imdbRating !== '' && { imdbRating: String(item.imdbRating) }),
    ...(item.runtime != null && { runtime: item.runtime }),
    ...(item.trailers != null &&
      Array.isArray(item.trailers) &&
      item.trailers.length > 0 && { trailers: item.trailers }),
    ...(item.links != null && Array.isArray(item.links) && item.links.length > 0 && { links: item.links }),
  };
  if (item.type === 'series' && item.episodes && item.episodes.length) {
    const y0 = seriesBaseYearForVideos(item) ?? 2020;
    base.videos = item.episodes.map((ep, idx) => {
      const season = Math.max(1, Number(ep.season) || 1);
      const episode = Math.max(1, Number(ep.episode) || 1);
      const day = 1 + (idx % 28);
      const mon = 1 + ((idx + season * 31 + episode) % 12);
      const released = `${y0}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00.000Z`;
      return {
        id: `${item.id}:${season}:${episode}`,
        title: ep.name || `Episódio ${episode}`,
        episode,
        season,
        released,
      };
    });
  }
  /* Filme: um vídeo explícito evita UI estranha (ex. Season 0) em alguns clientes. */
  if (item.type === 'movie') {
    const yFromRi = (() => {
      const ri = item.releaseInfo != null ? String(item.releaseInfo).trim() : '';
      const m = ri.match(/((?:19|20)\d{2})/);
      return m ? parseInt(m[1], 10) : null;
    })();
    const y = plausibleStremioYear(item.year) ?? yFromRi;
    const safeY =
      y != null && y >= STREMIO_YEAR_MIN && y <= STREMIO_YEAR_MAX ? y : 2020;
    const nm = item.name && String(item.name).trim() ? String(item.name).trim() : 'Filme';
    base.videos = [
      {
        id: item.id,
        title: nm,
        released: `${safeY}-06-15T12:00:00.000Z`,
      },
    ];
  }
  return base;
}

function dedupeStreamSourcesByUrl(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const u = s && s.url;
    if (!u || typeof u !== 'string') continue;
    let key;
    try {
      const x = new URL(u.trim());
      key = `${x.origin}${x.pathname}${x.search}`.toLowerCase();
    } catch (_) {
      key = u.trim().toLowerCase();
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function streamIdFromUrl(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 24);
}

async function handleCatalog(type, id, extra, config) {
  let items = [];
  if (type === 'movie') {
    items = await scraper.getFilmes();
  } else if (type === 'series') {
    if (id === 'novelaspt_novelas') {
      items = await scraper.getNovelasPortuguesas();
    } else if (id === 'novelaspt_series') {
      items = await scraper.getSeriesPortuguesas();
    } else {
      console.warn(`${LOG_PREFIX} HTTP catalog: id desconhecido type=series id=${id} → 0 metas`);
    }
  } else {
    console.warn(`${LOG_PREFIX} HTTP catalog: tipo desconhecido type=${type} id=${id}`);
  }
  const search = extra?.search;
  const beforeSearch = items.length;
  if (search && typeof search === 'string' && search.trim() !== '') {
    const q = normalizeForCatalogSearch(search);
    items = items.filter((i) => {
      if (!q) return true;
      const name = normalizeForCatalogSearch(i.name || '');
      if (name.includes(q)) return true;
      const slugAsText = normalizeForCatalogSearch(String(i.slug || '').replace(/-/g, ' '));
      if (slugAsText.includes(q)) return true;
      return false;
    });
    console.log(
      `${LOG_PREFIX} HTTP catalog resposta: ${type}/${id} → ${items.length} metas após pesquisa "${search}" (${beforeSearch} → ${items.length})`,
    );
  } else {
    console.log(`${LOG_PREFIX} HTTP catalog resposta: ${type}/${id} → ${items.length} metas (total antes da paginação)`);
  }
  const skip = catalogSkipFromExtra(extra);
  const page = items.slice(skip, skip + STREMIO_CATALOG_PAGE_SIZE);
  console.log(
    `${LOG_PREFIX} HTTP catalog página: skip=${skip} → ${page.length} metas (página ${STREMIO_CATALOG_PAGE_SIZE})`,
  );
  return { metas: page.map(metaPreviewFromItem) };
}

function stripStreamEpisodeSuffix(seriesId) {
  const m = String(seriesId).match(/^novelaspt_series_(.+):(\d+):(\d+)$/);
  if (m) return m[1];
  return String(seriesId).replace(SERIES_PREFIX, '');
}

/**
 * Resposta meta: o `id` tem de coincidir com o que o cliente pediu (incl. acentos); senão alguns
 * builds do Stremio tratam como erro → “No metadata was found”.
 * Se o pedido vier com :season:episode no id (raro), devolve só o id base da série.
 */
function seriesMetaBaseIdFromDecoded(decoded) {
  const s = String(decoded);
  if (!s.startsWith(SERIES_PREFIX)) return s;
  const m = s.match(/^novelaspt_series_(.+):(\d+):(\d+)$/);
  if (m) return `${SERIES_PREFIX}${m[1]}`;
  return s;
}

function fallbackTitleFromSlug(slug) {
  const raw = String(slug || '').trim();
  if (!raw) return 'Sem título';
  return raw
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function handleMeta(type, id, config) {
  const decoded = safeDecodeStremioId(id);
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) {
    return { meta: null };
  }
  const slug = decoded.startsWith(MOVIE_PREFIX)
    ? decoded.replace(MOVIE_PREFIX, '')
    : stripStreamEpisodeSuffix(decoded);
  let item = null;
  let metaFromCatalogOnly = false;
  let metaShell = false;
  if (decoded.startsWith(MOVIE_PREFIX)) {
    item = await scraper.getFilmeMeta(slug);
    if (!item) {
      await scraper.warmCatalogForMetaLookup(true);
      item = scraper.minimalMovieMetaFromCatalog(slug);
      metaFromCatalogOnly = !!item;
    }
    if (!item) {
      item = scraper.shellMovieMetaFromStremioId(decoded);
      metaFromCatalogOnly = true;
      metaShell = !!item;
    }
  } else {
    item = await scraper.getSeriesMeta(slug);
    if (!item) {
      await scraper.warmCatalogForMetaLookup(false);
      item = scraper.minimalSeriesMetaFromCatalog(slug);
      metaFromCatalogOnly = !!item;
    }
    if (!item) {
      item = scraper.shellSeriesMetaFromStremioId(decoded);
      metaFromCatalogOnly = true;
      metaShell = !!item;
    }
  }
  if (!item) return { meta: null };

  const metaResponseId = decoded.startsWith(MOVIE_PREFIX)
    ? decoded
    : seriesMetaBaseIdFromDecoded(decoded);
  if (item.id !== metaResponseId) {
    item.id = metaResponseId;
  }
  if (!item.name || !String(item.name).trim()) {
    item.name = fallbackTitleFromSlug(slug);
  }

  if (metaShell) {
    console.warn(
      `${LOG_PREFIX} meta SHELL (site inacessível ao servidor — bloqueio/WAF/rede). Streams podem falhar. Opções: addon em PC local, STREMIO_NP_PROXY, ou VPN residencial. id=${decoded.slice(0, 100)}`,
    );
  } else if (metaFromCatalogOnly) {
    console.warn(
      `${LOG_PREFIX} meta só a partir do catálogo (detalhe HTTP falhou) slug=${slug} type=${decoded.startsWith(MOVIE_PREFIX) ? 'movie' : 'series'}`,
    );
  }
  scraper.sanitizeCatalogItems([item]);
  const metaOut = metaFullFromItem(item);
  metaOut.type = decoded.startsWith(MOVIE_PREFIX) ? 'movie' : 'series';
  if (!metaOut.name || !String(metaOut.name).trim()) {
    metaOut.name = fallbackTitleFromSlug(slug);
  }
  const kind = decoded.startsWith(MOVIE_PREFIX) ? 'filme' : 'série ou novela (mesmo tipo no Stremio)';
  const ri = metaOut.releaseInfo ?? '-';
  const yr = item.year != null ? String(item.year) : '-';
  const imdbInternal = item.imdbId ?? '-';
  const imdbClient = EXPOSE_IMDB_ID_TO_CLIENT ? 'sim' : 'não (evita fusão Cinemeta)';
  const note = item.imdbRating != null ? String(item.imdbRating) : '-';
  console.log(
    `${LOG_PREFIX} meta stremio=${type} | ${kind} | título="${item.name}" | slug=${slug} | releaseInfo=${ri} | year=${yr} | imdbId_interno=${imdbInternal} | imdb_id→cliente=${imdbClient} | imdbRating=${note}`,
  );
  return { meta: metaOut };
}

async function handleStream(type, id, extra, _config) {
  const decoded = safeDecodeStremioId(id);
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) {
    return { streams: [] };
  }
  const itemNameBase = 'Novelas Portuguesas';
  let itemName = itemNameBase;
  let sources = [];
  let slugForLog = '';
  let kindLog = '';
  let epLog = '';

  if (type === 'movie') {
    kindLog = 'filme';
    const slug = decoded.replace(MOVIE_PREFIX, '');
    slugForLog = slug;
    const meta = await scraper.getFilmeMeta(slug);
    if (!meta?.wpPostId) {
      console.log(
        `${LOG_PREFIX} stream stremio=${type} | ${kindLog} | título="${meta?.name || '?'}" | slug=${slug} | sem wpPostId → 0 opções`,
      );
      return { streams: [] };
    }
    itemName = meta.name || itemNameBase;
    sources = await scraper.getMovieStreamSources(meta.wpPostId);
  } else if (type === 'series') {
    kindLog = 'série/novela';
    const epMatch = decoded.match(/^novelaspt_series_(.+):(\d+):(\d+)$/);
    let slug;
    let season;
    let episode;
    if (epMatch) {
      slug = epMatch[1];
      season = Math.max(1, parseInt(epMatch[2], 10) || 1);
      episode = Math.max(1, parseInt(epMatch[3], 10) || 1);
    } else {
      slug = decoded.replace(SERIES_PREFIX, '');
      season = Math.max(1, parseInt(String(extra?.season ?? 1), 10) || 1);
      episode = Math.max(1, parseInt(String(extra?.episode ?? 1), 10) || 1);
    }
    slugForLog = slug;
    const meta = await scraper.getSeriesMeta(slug);
    if (!meta) {
      console.log(
        `${LOG_PREFIX} stream stremio=${type} | ${kindLog} | slug=${slug} | meta inexistente → 0 opções`,
      );
      return { streams: [] };
    }
    itemName = meta.name || itemNameBase;
    const ep = meta.episodes?.find((e) => e.season === season && e.episode === episode);
    const epLabel = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const epTitle = ep?.name ? ` "${ep.name}"` : '';
    epLog = ` | episódio=${epLabel}${epTitle}`;
    if (!ep?.wpPid) {
      console.log(
        `${LOG_PREFIX} stream stremio=${type} | ${kindLog} | título="${itemName}" | slug=${slug}${epLog} | sem wpPid → 0 opções`,
      );
      return { streams: [] };
    }
    sources = await scraper.getTvEpisodeStreamSources(ep.wpPid);
  }

  sources = dedupeStreamSourcesByUrl(sources);
  const opts = sources.map((s, i) => `${i + 1}) ${s.title || 'Player'}`).join(' | ');
  if (!sources.length) {
    console.log(
      `${LOG_PREFIX} stream stremio=${type} | ${kindLog} | título="${itemName}" | slug=${slugForLog}${epLog} | 0 opções (Zeta/embed vazio)`,
    );
    return { streams: [] };
  }
  console.log(
    `${LOG_PREFIX} stream stremio=${type} | ${kindLog} | título="${itemName}" | slug=${slugForLog}${epLog} | ${sources.length} opção(ões): ${opts}`,
  );

  return {
    streams: sources.map((s) => ({
      id: `novelaspt-${streamIdFromUrl(s.url)}`,
      name: itemName,
      title: s.title || 'Player',
      externalUrl: s.url,
      source: 'Novelas Portuguesas',
    })),
  };
}

function parsePath(pathname) {
  const parts = pathname.replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1] && !parts[0].startsWith('catalog') && !parts[0].startsWith('meta') && !parts[0].startsWith('stream') && parts[0] !== 'configure' && parts[0] !== 'manifest.json') {
    const provider = decodeURIComponent(parts[0]);
    const apiKey = decodeURIComponent(parts[1]);
    const rest = parts.slice(2);
    return { config: { provider, apiKey }, pathRest: rest };
  }
  return { config: null, pathRest: parts };
}

/** Parse path + query a partir de req.url (API WHATWG; evita url.parse deprecado). */
function parseRequestUrl(req) {
  const host = req.headers.host || 'localhost';
  const u = new URL(req.url || '/', `http://${host}`);
  const query = Object.fromEntries(u.searchParams);
  return { pathname: u.pathname, query };
}

/**
 * Stremio pede extras do catálogo no path, não só em ?search=
 * Ex.: /catalog/movie/novelaspt_filmes/search=lulu.json
 *     /catalog/series/novelaspt_series/search=amor%20perfeito&skip=0.json
 */
function parseCatalogPathExtras(pathRest) {
  const extra = {};
  if (!pathRest || pathRest.length <= 3) return extra;
  for (let i = 3; i < pathRest.length; i++) {
    let seg = decodeURIComponent(String(pathRest[i]));
    seg = seg.replace(/\.json$/i, '');
    if (!seg) continue;
    for (const pair of seg.split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      let v = pair.slice(eq + 1);
      try {
        v = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (_) {
        /* mantém v */
      }
      if (k) extra[k] = v;
    }
  }
  return extra;
}

function normalizeForCatalogSearch(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stremio usa páginas de 100 metas; sem slice o cliente pede skip=100,200,… e nós devolvíamos sempre do início. */
const STREMIO_CATALOG_PAGE_SIZE = 100;

/** IDs no path do Stremio vêm codificados; % inválidos lançavam e o handler respondia 500 → “No metadata was found”. */
function safeDecodeStremioId(raw) {
  let s = String(raw || '');
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(s.replace(/\+/g, ' '));
      if (next === s) break;
      s = next;
    } catch (_) {
      break;
    }
  }
  return s;
}

function catalogSkipFromExtra(extra) {
  const v = extra && extra.skip;
  if (v == null) return 0;
  const n = parseInt(String(v).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function localIPv4Addresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function sendJson(res, status, bodyObj, method, headersBase = {}) {
  const body = JSON.stringify(bodyObj);
  const headers = {
    ...headersBase,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  };
  res.writeHead(status, headers);
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function sendPublicBinary(res, method, filename, contentType) {
  const filePath = path.join(__dirname, 'public', filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const body = fs.readFileSync(filePath);
  const headers = {
    ...CORS,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'Content-Length': body.length,
  };
  res.writeHead(200, headers);
  if (method === 'HEAD') res.end();
  else res.end(body);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer(async (req, res) => {
  const method = req.method || 'GET';
  const { pathname, query } = parseRequestUrl(req);

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...CORS, Allow: 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const htmlHeaders = { ...CORS, 'Content-Type': 'text/html; charset=utf-8' };
  const textHeaders = { ...CORS, 'Content-Type': 'text/plain' };

  try {
    if (pathname === '/manifest.json') {
      sendJson(res, 200, getManifest(null, manifestOriginFromRequest(req)), method, { ...CORS });
      return;
    }

    if (pathname === '/addon-logo.png') {
      sendPublicBinary(res, method, 'addon-logo.png', 'image/png');
      return;
    }

    if (pathname === '/addon-logo.svg') {
      sendPublicBinary(res, method, 'addon-logo.svg', 'image/svg+xml; charset=utf-8');
      return;
    }

    if (pathname === '/configure' || pathname === '/configure/') {
      const htmlPath = path.join(__dirname, 'public', 'configure.html');
      const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : getConfigureHtml();
      const len = Buffer.byteLength(html, 'utf8');
      res.writeHead(200, { ...htmlHeaders, 'Content-Length': len });
      if (method === 'HEAD') res.end();
      else res.end(html);
      return;
    }

    const { config, pathRest } = parsePath(pathname);

    if (pathRest[0] === 'manifest.json' && pathRest.length === 1) {
      sendJson(res, 200, getManifest(config, manifestOriginFromRequest(req)), method, { ...CORS });
      return;
    }

    if (pathRest[0] === 'catalog' && pathRest.length >= 3) {
      const type = pathRest[1];
      const id = decodeURIComponent(String(pathRest[2]).replace(/\.json$/i, ''));
      const extra = { ...query, ...parseCatalogPathExtras(pathRest) };
      const result = await handleCatalog(type, id, extra, config);
      sendJson(res, 200, result, method, { ...CORS });
      return;
    }

    if (pathRest[0] === 'meta' && pathRest.length >= 3) {
      const type = pathRest[1];
      const id = decodeURIComponent(pathRest[2].replace(/\.json$/, ''));
      const result = await handleMeta(type, id, config);
      sendJson(res, 200, result, method, { ...CORS });
      return;
    }

    if (pathRest[0] === 'stream' && pathRest.length >= 3) {
      const type = pathRest[1];
      const id = decodeURIComponent(pathRest[2].replace(/\.json$/, ''));
      const extra = { season: query.season, episode: query.episode };
      const result = await handleStream(type, id, extra, config);
      sendJson(res, 200, result, method, { ...CORS });
      return;
    }

    const msg = 'Not found';
    res.writeHead(404, { ...textHeaders, 'Content-Length': Buffer.byteLength(msg) });
    if (method === 'HEAD') res.end();
    else res.end(msg);
  } catch (err) {
    const code = err && (err.code || err.cause?.code);
    const msg = (err && err.message) || String(err);
    console.error(`${LOG_PREFIX} Erro HTTP${code ? ` [${code}]` : ''}: ${msg}`);
    sendJson(res, 500, { error: msg }, method, { ...CORS });
  }
});

function getConfigureHtml() {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Configurar Addon — Filmes, Series e Novelas Portuguesas</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 1.4rem; }
    label { display: block; margin-top: 12px; font-weight: 500; }
    select, input { width: 100%; padding: 10px; margin-top: 4px; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
    button { margin-top: 20px; padding: 12px 24px; background: #2e7d32; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; width: 100%; }
    button:hover { background: #1b5e20; }
    .hint { font-size: 0.85rem; color: #444; margin-top: 12px; line-height: 1.45; }
    .link { margin-top: 16px; word-break: break-all; font-size: 0.95rem; padding: 12px; background: #f5f5f5; border-radius: 6px; }
    a { color: #1565c0; }
    code { font-size: 0.88em; background: #eee; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Filmes, Series e Novelas Portuguesas Addon Stremio</h1>
  <p>Conteúdo de <a href="https://novelasportuguesas.com/" target="_blank" rel="noopener">novelasportuguesas.com</a>. Os vídeos abrem no browser (external player).</p>
  <p class="link"><strong>URL do manifest (copiar para o Stremio):</strong><br><code id="manifestUrl"></code></p>
  <p class="hint"><strong>Stremio Desktop no mesmo PC:</strong> usa <code>http://127.0.0.1:PORT/manifest.json</code> (substitui PORT) ou o URL acima se abriste esta página pelo servidor local. HTTP só é aceite em <code>localhost</code> / <code>127.0.0.1</code>.</p>
  <p class="hint"><strong>Stremio Web, telemóvel ou TV:</strong> o Stremio costuma exigir <strong>HTTPS</strong>. Um endereço <code>http://192.168.x.x/...</code> na rede local pode ser recusado. Solução: expor o addon com túnel HTTPS (por exemplo <a href="https://ngrok.com/" target="_blank" rel="noopener">ngrok</a> ou <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/" target="_blank" rel="noopener">Cloudflare Tunnel</a>) e colar o <code>https://…/manifest.json</code> no Stremio.</p>
  <p class="hint">No Stremio: ícone de puzzle / Addons → <em>Addon catalog</em> (ou campo para colar URL do manifest) → cola o link e instala.</p>
  <script>
    var m = location.origin + '/manifest.json';
    document.getElementById('manifestUrl').textContent = m;
  </script>
</body>
</html>`;
}

// Garantir que public/configure.html existe
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
const configurePath = path.join(publicDir, 'configure.html');
if (!fs.existsSync(configurePath)) {
  fs.writeFileSync(configurePath, getConfigureHtml(), 'utf8');
}

const HOST = '0.0.0.0';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n${LOG_PREFIX} A porta ${PORT} já está em uso (outra instância do addon ou outro programa).`);
    console.error('  • Fecha a outra janela onde correste npm start / node dist/bundle.cjs.');
    console.error('  • PowerShell — outra porta:  $env:PORT=7001; npm start');
    console.error('  • CMD — outra porta:          set PORT=7001 && npm start');
    console.error(
      `  • Ver quem usa a porta:     Get-NetTCPConnection -LocalPort ${PORT} | Select-Object OwningProcess\n`,
    );
  } else {
    console.error(`${LOG_PREFIX} Erro ao arrancar o servidor:`, err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Addon a correr em http://127.0.0.1:${PORT} (todas as interfaces: porta ${PORT})`);
  console.log(`Configuração / ajuda: http://127.0.0.1:${PORT}/configure`);
  console.log('');
  console.log(
    `${LOG_PREFIX} Registo de catálogos: REFRESH = construção desde o site (títulos, páginas de arquivo, resumos se ativos, ms). CACHE = dados em memória (TTL configurável por STREMIO_NP_CACHE_MS).`,
  );
  console.log(
    `${LOG_PREFIX} Endpoints Stremio: movie/novelaspt_filmes | series/novelaspt_series | series/novelaspt_novelas`,
  );
  console.log(
    `${LOG_PREFIX} Meta JSON: imdb_id ao cliente = ${EXPOSE_IMDB_ID_TO_CLIENT ? 'SIM (STREMIO_NP_EXPOSE_IMDB_ID=1)' : 'NÃO (recomendado: evita fusão com Cinemeta e o efeito “ano 20 / IMDb a desaparecer”). imdbRating + link IMDb mantêm-se.'}`,
  );
  console.log(
    `${LOG_PREFIX} Rede: DNS IPv4 preferencial no Node | HTTP 403/429/503 com reintentos | proxy opcional STREMIO_NP_PROXY ou HTTPS_PROXY (útil se o site bloquear datacenters).`,
  );
  console.log('');
  console.log('Stremio — instalar o addon:');
  console.log(`  • Neste PC (app Stremio Desktop): cola em "Addon catalog" → http://127.0.0.1:${PORT}/manifest.json`);
  console.log('    (usa 127.0.0.1 ou localhost; HTTP só funciona aí, não em IP da rede.)');
  const lan = localIPv4Addresses();
  if (lan.length) {
    console.log('  • Noutro dispositivo (TV, telemóvel, Stremio Web): HTTP em IP local costuma ser recusado.');
    console.log('    Usa um túnel HTTPS (ex.: ngrok, Cloudflare Tunnel) e cola o https://…/manifest.json');
    console.log(`    IP(s) na tua LAN (para referência): ${lan.join(', ')}`);
  }
  console.log('');
});
