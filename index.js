/**
 * Addon Stremio — Filmes, Series e Novelas Portuguesas (novelasportuguesas.com)
 * Reprodução: externalUrl (players iframe do site).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scraper = require('./lib/scraper');

const PORT = process.env.PORT || 7000;
const LOG_PREFIX = '[NovelasPT]';

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
    version: '1.0.4',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: [MOVIE_PREFIX, SERIES_PREFIX],
    ...(logo ? { logo } : {}),
    catalogs: [
      { type: 'movie', id: 'novelaspt_filmes', name: 'Filmes Portugueses', extra: [{ name: 'search', isRequired: false }] },
      { type: 'series', id: 'novelaspt_series', name: 'Séries Portuguesas', extra: [{ name: 'search', isRequired: false }] },
      { type: 'series', id: 'novelaspt_novelas', name: 'Novelas Portuguesas', extra: [{ name: 'search', isRequired: false }] },
    ],
    behaviorHints: base,
  };
}

function metaPreviewFromItem(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    poster: item.poster,
    posterShape: 'poster',
    description: item.description,
    releaseInfo: item.year ? String(item.year) : undefined,
    imdbId: item.imdbId,
  };
}

function metaFullFromItem(item) {
  const base = {
    id: item.id,
    type: item.type,
    name: item.name,
    posterShape: 'poster',
    ...(item.poster != null && { poster: item.poster }),
    ...(item.description != null && item.description !== '' && { description: item.description }),
    ...((item.releaseInfo != null ? item.releaseInfo : item.year != null) && { releaseInfo: String(item.releaseInfo ?? item.year) }),
    ...(item.imdbId != null && { imdbId: item.imdbId }),
    ...(item.background != null && { background: item.background }),
    ...(item.genres != null && item.genres.length > 0 && { genres: item.genres }),
    ...(item.cast != null && { cast: item.cast }),
    ...(item.director != null && { director: item.director }),
    ...(item.imdbRating != null && { imdbRating: item.imdbRating }),
    ...(item.runtime != null && { runtime: item.runtime }),
  };
  if (item.type === 'series' && item.episodes && item.episodes.length) {
    base.videos = item.episodes.map((ep) => ({
      id: `${item.id}:${ep.season}:${ep.episode}`,
      title: ep.name || `Episódio ${ep.episode}`,
      episode: ep.episode,
      season: ep.season,
    }));
  }
  return base;
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
  if (search && typeof search === 'string') {
    const q = search.toLowerCase();
    items = items.filter(i => i.name.toLowerCase().includes(q));
    console.log(
      `${LOG_PREFIX} HTTP catalog resposta: ${type}/${id} → ${items.length} metas (pesquisa "${search}" filtrou ${beforeSearch} → ${items.length})`,
    );
  } else {
    console.log(`${LOG_PREFIX} HTTP catalog resposta: ${type}/${id} → ${items.length} metas`);
  }
  return { metas: items.map(metaPreviewFromItem) };
}

function stripStreamEpisodeSuffix(seriesId) {
  const m = String(seriesId).match(/^novelaspt_series_(.+):(\d+):(\d+)$/);
  if (m) return m[1];
  return String(seriesId).replace(SERIES_PREFIX, '');
}

async function handleMeta(type, id, config) {
  const decoded = decodeURIComponent(String(id || ''));
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) {
    return { meta: null };
  }
  const slug = decoded.startsWith(MOVIE_PREFIX)
    ? decoded.replace(MOVIE_PREFIX, '')
    : stripStreamEpisodeSuffix(decoded);
  let item = null;
  if (decoded.startsWith(MOVIE_PREFIX)) {
    item = await scraper.getFilmeMeta(slug);
  } else {
    item = await scraper.getSeriesMeta(slug);
  }
  if (!item) return { meta: null };
  // Capas e descrições apenas do site (já vêm em getFilmeMeta / getSeriesMeta)
  return { meta: metaFullFromItem(item) };
}

async function handleStream(type, id, extra, _config) {
  const decoded = decodeURIComponent(String(id || ''));
  if (!decoded.startsWith(MOVIE_PREFIX) && !decoded.startsWith(SERIES_PREFIX)) {
    return { streams: [] };
  }
  const itemNameBase = 'Novelas Portuguesas';
  let itemName = itemNameBase;
  let sources = [];

  if (type === 'movie') {
    const slug = decoded.replace(MOVIE_PREFIX, '');
    const meta = await scraper.getFilmeMeta(slug);
    if (!meta?.wpPostId) return { streams: [] };
    itemName = meta.name || itemNameBase;
    sources = await scraper.getMovieStreamSources(meta.wpPostId);
  } else if (type === 'series') {
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
    const meta = await scraper.getSeriesMeta(slug);
    if (!meta) return { streams: [] };
    itemName = meta.name || itemNameBase;
    const ep = meta.episodes?.find((e) => e.season === season && e.episode === episode);
    if (!ep?.wpPid) return { streams: [] };
    sources = await scraper.getTvEpisodeStreamSources(ep.wpPid);
  }

  if (!sources.length) return { streams: [] };

  return {
    streams: sources.map((s) => ({
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
      const id = decodeURIComponent(pathRest[2].replace(/\.json$/, ''));
      const result = await handleCatalog(type, id, query, config);
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
    console.error(`${LOG_PREFIX} Erro HTTP:`, err);
    sendJson(res, 500, { error: err.message }, method, { ...CORS });
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
