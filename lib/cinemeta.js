/**
 * Obtém poster e descrição do Cinemeta (metadados do Stremio, baseados em IMDb/TMDB/etc.)
 * Uso: enriquecer meta quando temos imdbId.
 */

const axios = require('axios');

const CINEMETA_URL = 'https://v3-cinemeta.strem.io';
const client = axios.create({
  baseURL: CINEMETA_URL,
  timeout: 8000,
  validateStatus: () => true,
});

/**
 * Trailers no formato Stremio: source = ID do vídeo YouTube.
 * @param {object} meta - resposta raw do Cinemeta
 * @returns {Array<{ source: string, type: string }>|undefined}
 */
function trailersFromCinemetaMeta(meta) {
  const streams = meta.trailerStreams;
  if (Array.isArray(streams) && streams.length) {
    return streams
      .map((t) => {
        const id = (t.ytId || t.source || '').trim();
        return id ? { source: id, type: 'Trailer' } : null;
      })
      .filter(Boolean);
  }
  const tr = meta.trailers;
  if (!Array.isArray(tr) || !tr.length) return undefined;
  return tr
    .map((t) => {
      const id = typeof t.source === 'string' ? t.source.trim() : '';
      return id ? { source: id, type: t.type === 'Clip' ? 'Clip' : 'Trailer' } : null;
    })
    .filter(Boolean);
}

/**
 * Busca meta por IMDb ID no Cinemeta.
 * @param {string} type - 'movie' ou 'series'
 * @param {string} imdbId - ex: 'tt0068646'
 */
async function getMetaByImdbId(type, imdbId) {
  if (!imdbId || typeof imdbId !== 'string') return null;
  const cleanId = imdbId.trim().toLowerCase();
  if (!cleanId.startsWith('tt')) return null;

  try {
    const res = await client.get(`/meta/${type}/${cleanId}.json`);
    if (res.status !== 200 || !res.data?.meta) return null;
    const meta = res.data.meta;
    const trailers = trailersFromCinemetaMeta(meta);
    return {
      poster: meta.poster || undefined,
      description: meta.description || meta.overview || undefined,
      name: meta.name || undefined,
      background: meta.background || undefined,
      releaseInfo: meta.releaseInfo || undefined,
      released: meta.released || undefined,
      runtime: meta.runtime || undefined,
      genres: meta.genres || undefined,
      cast: meta.cast || undefined,
      director: meta.director || undefined,
      imdbRating: meta.imdbRating != null ? String(meta.imdbRating) : undefined,
      trailers: trailers?.length ? trailers : undefined,
    };
  } catch (err) {
    return null;
  }
}

function normalizeTitleKey(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const CINEMETA_SEARCH_DISABLED = process.env.STREMIO_NP_CINEMETA_SEARCH === '0';

function parseMetaReleaseYear(m) {
  if (m.releaseInfo != null && String(m.releaseInfo).trim() !== '') {
    const n = parseInt(String(m.releaseInfo).trim(), 10);
    if (Number.isFinite(n) && n >= 1870 && n <= 2100) return n;
  }
  if (m.year != null) {
    const n = parseInt(String(m.year), 10);
    if (Number.isFinite(n) && n >= 1870 && n <= 2100) return n;
  }
  return null;
}

/**
 * Quando o site não tem tt na página: pesquisa no Cinemeta.
 * Com `hintYear` (ano do site), escolhe o tt cujo ano no Cinemeta está mais perto (evita
 * "Lulu" 1980 quando o filme português é 2024/2025).
 */
async function findImdbIdByTitle(type, title, hintYear) {
  if (CINEMETA_SEARCH_DISABLED || !title || typeof title !== 'string') return null;
  const t = title.trim();
  if (t.length < 2) return null;
  const want = normalizeTitleKey(t);
  if (!want) return null;

  try {
    const q = encodeURIComponent(t);
    const res = await client.get(`/catalog/${type}/top/search=${q}.json`);
    if (res.status !== 200 || !Array.isArray(res.data?.metas)) return null;
    const metas = res.data.metas;
    const candidates = [];
    for (let i = 0; i < Math.min(metas.length, 40); i++) {
      const m = metas[i];
      const id = m.id || m.imdb_id;
      if (!id || typeof id !== 'string' || !id.startsWith('tt')) continue;
      if (normalizeTitleKey(m.name || '') !== want) continue;
      candidates.push({ id: id.toLowerCase(), year: parseMetaReleaseYear(m) });
    }
    if (!candidates.length) return null;

    const y =
      hintYear != null && Number.isFinite(Number(hintYear)) ? parseInt(String(hintYear), 10) : null;
    if (y != null) {
      const withYear = candidates.filter((c) => c.year != null);
      if (withYear.length) {
        withYear.sort((a, b) => Math.abs(a.year - y) - Math.abs(b.year - y));
        const best = withYear[0];
        if (Math.abs(best.year - y) <= 5) return best.id;
        return null;
      }
    }

    return candidates[0].id;
  } catch (_) {
    return null;
  }
}

module.exports = { getMetaByImdbId, findImdbIdByTitle, normalizeTitleKey };
