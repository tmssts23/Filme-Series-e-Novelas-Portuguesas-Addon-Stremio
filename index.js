const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const scraper = require('./lib/scraper');

const PORT = Number(process.env.PORT) || 7000;
const HOST = '0.0.0.0';
const LOG_PREFIX = '[NovelasPT]';

const MOVIE_PREFIX = 'novelaspt_movie_';
const SERIES_PREFIX = 'novelaspt_series_';
const ADDON_NAME = 'Filmes, Series e Novelas Portuguesas Addon Stremio';
const VERSION = '2.0.0';
const CATALOG_PAGE_SIZE = 100;
const GENRE_OPTIONS = [
  'None',
  'Ação',
  'Aventura',
  'Comédia',
  'Drama',
  'Romance',
  'Suspense',
  'Terror',
  'Crime',
  'Documentário',
  'Animação',
  'Família',
  'Fantasia',
  'História',
  'Música',
  'Mistério',
  'Guerra',
  'Western',
  'Biografia',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function manifestOriginFromRequest(req) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const protoRaw = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = protoRaw === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

function getManifest(originBase) {
  const base = { configurable: false, configurationRequired: false };
  const logo = originBase ? `${originBase.replace(/\/$/, '')}/addon-logo.png` : undefined;
  return {
    id: 'pt.filmes-series-portuguesas',
    version: VERSION,
    name: ADDON_NAME,
    description: 'Filmes, series e novelas portuguesas com streams externos.',
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
          { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
          { name: 'skip', isRequired: false },
        ],
      },
      {
        type: 'series',
        id: 'novelaspt_series',
        name: 'Series Portuguesas',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
          { name: 'skip', isRequired: false },
        ],
      },
      {
        type: 'series',
        id: 'novelaspt_novelas',
        name: 'Novelas Portuguesas',
        extra: [
          { name: 'search', isRequired: false },
          { name: 'genre', isRequired: false, options: GENRE_OPTIONS },
          { name: 'skip', isRequired: false },
        ],
      },
    ],
    behaviorHints: base,
  };
}

function safeDecode(raw) {
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

function normalizeSearch(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePath(pathname) {
  return String(pathname || '')
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean);
}

function parseReqUrl(req) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `http://${host}`);
  return { pathname: url.pathname, query: Object.fromEntries(url.searchParams.entries()) };
}

function parseCatalogExtras(pathParts) {
  const out = {};
  if (pathParts.length <= 3) return out;
  for (let i = 3; i < pathParts.length; i++) {
    const seg = decodeURIComponent(pathParts[i]).replace(/\.json$/i, '');
    for (const pair of seg.split('&')) {
      const k = pair.split('=')[0];
      const v = pair.includes('=') ? pair.slice(pair.indexOf('=') + 1) : '';
      if (k) out[k] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
  }
  return out;
}

function sendJson(res, method, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS,
    ...extra,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  if (method === 'HEAD') return res.end();
  res.end(body);
}

function sendText(res, method, status, text) {
  const body = String(text || '');
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  if (method === 'HEAD') return res.end();
  res.end(body);
}

function seriesBaseId(decodedSeriesId) {
  const m = String(decodedSeriesId).match(/^novelaspt_series_(.+):\d+:\d+$/);
  return m ? `${SERIES_PREFIX}${m[1]}` : String(decodedSeriesId);
}

function releaseInfoFromItem(item) {
  const ri = String(item.releaseInfo || '').trim();
  const broadcaster = String(item.runtime || '').trim();
  const rating = String(item.imdbRating || '').trim();
  const broadcasterPart = broadcaster ? broadcaster : '';
  const ratingPart = rating ? `IMDb ${rating}` : '';
  const appendParts = (base) => {
    const parts = [String(base || '').trim(), broadcasterPart, ratingPart].filter(Boolean);
    return parts.length ? parts.join(' | ') : undefined;
  };
  if (ri && !/^\d{1,3}$/.test(ri)) return appendParts(ri);
  const y = Number(item.year);
  if (Number.isFinite(y) && y >= 1870 && y <= 2100) return appendParts(String(y));
  if (broadcasterPart || ratingPart) return [broadcasterPart, ratingPart].filter(Boolean).join(' | ');
  return undefined;
}

function metaPreview(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    posterShape: 'poster',
    ...(item.description ? { description: item.description } : {}),
    ...(releaseInfoFromItem(item) ? { releaseInfo: releaseInfoFromItem(item) } : {}),
    ...(Array.isArray(item.genres) && item.genres.length ? { genres: item.genres } : { genres: ['None'] }),
  };
}

function fullMeta(item, responseId, forceType) {
  const id = responseId || item.id;
  const type = forceType || item.type;
  const out = {
    id,
    type,
    name: item.name || 'Sem titulo',
    posterShape: 'poster',
    ...(item.poster ? { poster: item.poster } : {}),
    ...(item.background ? { background: item.background } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(releaseInfoFromItem(item) ? { releaseInfo: releaseInfoFromItem(item) } : {}),
    ...(item.runtime ? { runtime: item.runtime } : {}),
    ...(Array.isArray(item.genres) && item.genres.length ? { genres: item.genres } : { genres: ['None'] }),
    ...(item.imdbRating ? { imdbRating: String(item.imdbRating) } : {}),
    ...(item.trailerYtId
      ? {
          /* Trailer button no Stremio (ao lado de Add to library). */
          trailer: { ytId: item.trailerYtId },
          trailers: [{ source: item.trailerYtId, type: 'Trailer' }],
        }
      : {}),
  };

  if (type === 'movie') {
    const y = Number(item.year);
    const safeY = Number.isFinite(y) && y >= 1870 && y <= 2100 ? y : 2020;
    out.videos = [{ id, title: out.name, released: `${safeY}-06-15T12:00:00.000Z` }];
  } else {
    const eps = Array.isArray(item.episodes) && item.episodes.length ? item.episodes : [{ season: 1, episode: 1, name: 'A sincronizar...' }];
    const y = Number(item.year);
    const safeY = Number.isFinite(y) && y >= 1870 && y <= 2100 ? y : 2020;
    out.videos = eps.map((ep, i) => {
      const s = Math.max(1, Number(ep.season) || 1);
      const e = Math.max(1, Number(ep.episode) || 1);
      const m = 1 + ((i + s * 31 + e) % 12);
      const d = 1 + (i % 28);
      return {
        id: `${id}:${s}:${e}`,
        title: ep.name || `Episodio ${e}`,
        season: s,
        episode: e,
        released: `${safeY}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00.000Z`,
      };
    });
  }
  return out;
}

function streamIdFromUrl(u) {
  return crypto.createHash('sha256').update(String(u || '')).digest('hex').slice(0, 24);
}

async function handleCatalog(type, id, extra) {
  let items = [];
  if (type === 'movie' && id === 'novelaspt_filmes') items = await scraper.getFilmes();
  else if (type === 'series' && id === 'novelaspt_series') items = await scraper.getSeriesPortuguesas();
  else if (type === 'series' && id === 'novelaspt_novelas') items = await scraper.getNovelasPortuguesas();

  const genreRaw = String(extra.genre || '').trim();
  if (genreRaw) {
    const wanted = normalizeSearch(genreRaw);
    if (wanted !== 'none') {
      const byGenre = await scraper.getItemsByGenreLabel(genreRaw);
      const allowedIds = new Set(
        byGenre
          .filter((x) => x.type === type)
          .map((x) => x.id),
      );
      items = items
        .filter((it) => allowedIds.has(it.id))
        .map((it) => ({ ...it, genres: [genreRaw] }));
      // Para o catálogo de novelas, restringe à lista de novelas.
      if (type === 'series' && id === 'novelaspt_novelas') {
        const novelasSet = new Set((await scraper.getNovelasPortuguesas()).map((x) => x.id));
        items = items.filter((it) => novelasSet.has(it.id));
      }
    } else {
      // "None": sem género mapeado no site.
      const knownLabels = GENRE_OPTIONS.filter((g) => normalizeSearch(g) !== 'none');
      const byKnown = await scraper.getCoveredIdsForGenres(knownLabels);
      if (byKnown.size > 0) items = items.filter((it) => !byKnown.has(it.id));
      items = items.map((it) => ({ ...it, genres: ['None'] }));
    }
  }

  const search = String(extra.search || '').trim();
  if (search) {
    const q = normalizeSearch(search);
    items = items.filter((it) => {
      const n = normalizeSearch(it.name || '');
      const s = normalizeSearch(String(it.slug || '').replace(/-/g, ' '));
      return n.includes(q) || s.includes(q);
    });
  }

  const skip = Math.max(0, Number.parseInt(String(extra.skip || '0'), 10) || 0);
  const page = items.slice(skip, skip + CATALOG_PAGE_SIZE);
  return { metas: page.map(metaPreview) };
}

async function handleMeta(type, id) {
  const decoded = safeDecode(id);
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) return { meta: null };

  if (decoded.startsWith(MOVIE_PREFIX)) {
    const slug = decoded.slice(MOVIE_PREFIX.length);
    let item = await scraper.getFilmeMeta(slug);
    if (!item) item = scraper.shellMovieMetaFromStremioId(decoded);
    if (!item) return { meta: null };
    return { meta: fullMeta(item, decoded, 'movie') };
  }

  const base = seriesBaseId(decoded);
  const slug = base.slice(SERIES_PREFIX.length);
  let item = await scraper.getSeriesMeta(slug);
  if (!item) item = scraper.shellSeriesMetaFromStremioId(base);
  if (!item) return { meta: null };
  return { meta: fullMeta(item, base, 'series') };
}

async function handleStream(type, id, extra) {
  const decoded = safeDecode(id);
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) return { streams: [] };

  if (type === 'movie' && decoded.startsWith(MOVIE_PREFIX)) {
    const slug = decoded.slice(MOVIE_PREFIX.length);
    const meta = await scraper.getFilmeMeta(slug);
    if (!meta || !meta.wpPostId) return { streams: [] };
    const src = await scraper.getMovieStreamSources(meta.wpPostId);
    return {
      streams: src.map((s) => ({
        id: `novelaspt-${streamIdFromUrl(s.url)}`,
        name: meta.name || 'NovelasPT',
        title: s.title || 'Player',
        externalUrl: s.url,
      })),
    };
  }

  if (type !== 'series') return { streams: [] };
  let slug;
  let season;
  let episode;
  const m = decoded.match(/^novelaspt_series_(.+):(\d+):(\d+)$/);
  if (m) {
    slug = m[1];
    season = Math.max(1, parseInt(m[2], 10) || 1);
    episode = Math.max(1, parseInt(m[3], 10) || 1);
  } else {
    slug = decoded.slice(SERIES_PREFIX.length);
    season = Math.max(1, parseInt(String(extra.season || '1'), 10) || 1);
    episode = Math.max(1, parseInt(String(extra.episode || '1'), 10) || 1);
  }
  const meta = await scraper.getSeriesMeta(slug);
  if (!meta || !Array.isArray(meta.episodes)) return { streams: [] };
  const ep = meta.episodes.find((x) => Number(x.season) === season && Number(x.episode) === episode);
  if (!ep || !ep.wpPid) return { streams: [] };
  const src = await scraper.getTvEpisodeStreamSources(ep.wpPid);
  return {
    streams: src.map((s) => ({
      id: `novelaspt-${streamIdFromUrl(s.url)}`,
      name: meta.name || 'NovelasPT',
      title: s.title || 'Player',
      externalUrl: s.url,
    })),
  };
}

function sendPublic(res, method, filename, contentType) {
  const p = path.join(__dirname, 'public', filename);
  if (!fs.existsSync(p)) return sendText(res, method, 404, 'Not found');
  const body = fs.readFileSync(p);
  res.writeHead(200, {
    ...CORS,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'Content-Length': body.length,
  });
  if (method === 'HEAD') return res.end();
  res.end(body);
}

async function requestHandler(req, res) {
  const method = req.method || 'GET';
  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (method !== 'GET' && method !== 'HEAD') return sendText(res, method, 405, 'Method Not Allowed');

  const { pathname, query } = parseReqUrl(req);
  const parts = parsePath(pathname);
  try {
    if (pathname === '/manifest.json') {
      return sendJson(res, method, 200, getManifest(manifestOriginFromRequest(req)));
    }
    if (pathname === '/addon-logo.png') return sendPublic(res, method, 'addon-logo.png', 'image/png');
    if (pathname === '/addon-logo.svg') return sendPublic(res, method, 'addon-logo.svg', 'image/svg+xml; charset=utf-8');
    if (pathname === '/configure' || pathname === '/configure/') return sendPublic(res, method, 'configure.html', 'text/html; charset=utf-8');

    if (parts[0] === 'catalog' && parts.length >= 3) {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2]).replace(/\.json$/i, ''));
      const extra = { ...query, ...parseCatalogExtras(parts) };
      const out = await handleCatalog(type, id, extra);
      return sendJson(res, method, 200, out);
    }
    if (parts[0] === 'meta' && parts.length >= 3) {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2]).replace(/\.json$/i, ''));
      const out = await handleMeta(type, id);
      return sendJson(res, method, 200, out);
    }
    if (parts[0] === 'stream' && parts.length >= 3) {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2]).replace(/\.json$/i, ''));
      const out = await handleStream(type, id, { season: query.season, episode: query.episode });
      return sendJson(res, method, 200, out);
    }
    return sendText(res, method, 404, 'Not found');
  } catch (err) {
    const msg = (err && err.message) || String(err);
    console.error(`${LOG_PREFIX} HTTP error: ${msg}`);
    return sendJson(res, method, 500, { error: msg });
  }
}

const server = http.createServer(requestHandler);

server.on('error', (err) => {
  console.error(`${LOG_PREFIX} Server error: ${err.message}`);
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`${LOG_PREFIX} Addon running on http://127.0.0.1:${PORT}`);
    console.log(`${LOG_PREFIX} Manifest: http://127.0.0.1:${PORT}/manifest.json`);
  });
}

module.exports = { requestHandler };
