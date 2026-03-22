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
 * Busca meta por IMDb ID no Cinemeta.
 * @param {string} type - 'movie' ou 'series'
 * @param {string} imdbId - ex: 'tt0068646'
 * @returns {Promise<{ poster?: string, description?: string, name?: string }|null>}
 */
async function getMetaByImdbId(type, imdbId) {
  if (!imdbId || typeof imdbId !== 'string') return null;
  const cleanId = imdbId.trim().toLowerCase();
  if (!cleanId.startsWith('tt')) return null;

  try {
    const res = await client.get(`/meta/${type}/${cleanId}.json`);
    if (res.status !== 200 || !res.data?.meta) return null;
    const meta = res.data.meta;
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
      imdbRating: meta.imdbRating || undefined,
    };
  } catch (err) {
    return null;
  }
}

module.exports = { getMetaByImdbId };
