/**
 * Auditoria: cada filme / série / novela — meta carrega? há opções de stream?
 * Uso: node scripts/verify-all-streams.js
 * (Catálogo em modo rápido: sem ir a cada página de detalhe na grelha.)
 */

process.env.STREMIO_NP_CATALOG_SYNOPSIS = '0';
process.env.STREMIO_NP_CATALOG_RELEASE = '0';

const fs = require('fs');
const path = require('path');
const scraper = require('../lib/scraper');

const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY) || 8;
const OUT_JSON = path.join(__dirname, '..', 'verify-streams-report.json');

async function poolMap(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function checkMovie(row) {
  const { slug, name, id } = row;
  const meta = await scraper.getFilmeMeta(slug);
  if (!meta) {
    return { kind: 'movie', id, slug, name, okMeta: false, streams: 0, err: 'sem meta' };
  }
  const wp = meta.wpPostId;
  if (!wp) {
    return { kind: 'movie', id, slug, name: meta.name || name, okMeta: true, streams: 0, err: 'sem wpPostId' };
  }
  const sources = await scraper.getMovieStreamSources(wp);
  return {
    kind: 'movie',
    id,
    slug,
    name: meta.name || name,
    okMeta: true,
    streams: sources.length,
    err: sources.length ? null : '0 streams zeta',
  };
}

async function checkSeriesRow(row, label) {
  const { slug, name, id } = row;
  const meta = await scraper.getSeriesMeta(slug);
  if (!meta) {
    return {
      kind: label,
      id,
      slug,
      name,
      okMeta: false,
      episodesTotal: 0,
      episodesChecked: 0,
      episodesWithStreams: 0,
      episodesNoStreams: [],
      err: 'sem meta',
    };
  }
  const eps = (meta.episodes || []).filter((e) => e && e.wpPid);
  if (!eps.length) {
    return {
      kind: label,
      id,
      slug,
      name: meta.name || name,
      okMeta: true,
      episodesTotal: 0,
      episodesChecked: 0,
      episodesWithStreams: 0,
      episodesNoStreams: [],
      err: 'sem episódios com wpPid',
    };
  }

  const sorted = [...eps].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const epConcurrency = Math.min(6, CONCURRENCY);
  const epResults = await poolMap(sorted, epConcurrency, async (ep) => {
    const src = await scraper.getTvEpisodeStreamSources(ep.wpPid);
    return { ep, n: src.length };
  });
  const episodesNoStreams = [];
  let withStreams = 0;
  for (const { ep, n } of epResults) {
    if (n) withStreams++;
    else
      episodesNoStreams.push({
        season: ep.season,
        episode: ep.episode,
        wpPid: ep.wpPid,
      });
  }

  return {
    kind: label,
    id,
    slug,
    name: meta.name || name,
    okMeta: true,
    episodesTotal: sorted.length,
    episodesChecked: sorted.length,
    episodesWithStreams: withStreams,
    episodesNoStreams,
    err:
      withStreams === 0
        ? 'nenhum episódio com stream'
        : episodesNoStreams.length
          ? `${episodesNoStreams.length} ep(s) sem stream`
          : null,
  };
}

function summarize(results, title, mode) {
  const bad = results.filter((r) => {
    if (!r.okMeta) return true;
    if (mode === 'movie') return (r.streams || 0) === 0;
    return (r.episodesWithStreams || 0) === 0;
  });
  const ok = results.length - bad.length;
  console.log(`\n=== ${title} ===`);
  console.log(`Total: ${results.length} | OK (meta + ≥1 stream): ${ok} | falha: ${bad.length}`);
  for (const r of bad.slice(0, 40)) {
    const detail =
      mode === 'movie'
        ? r.err || `streams=${r.streams}`
        : r.err || `eps com stream=${r.episodesWithStreams}/${r.episodesChecked}`;
    console.log(`  ✗ ${r.name} | slug=${r.slug} | ${detail}`);
  }
  if (bad.length > 40) console.log(`  … mais ${bad.length - 40} entradas (ver ${OUT_JSON})`);

  const warnings =
    mode === 'series' || mode === 'novela'
      ? results.filter(
          (r) => r.okMeta && r.episodesWithStreams > 0 && r.episodesNoStreams && r.episodesNoStreams.length,
        )
      : [];
  if (warnings.length) {
    console.log(`  ⚠ ${warnings.length} título(s) com alguns episódios sem stream (meta OK)`);
  }

  return { total: results.length, ok, bad: bad.length, badRows: bad };
}

async function main() {
  console.log('A carregar catálogos (grelha rápida)…');
  const [filmes, series, novelas] = await Promise.all([
    scraper.getFilmes(),
    scraper.getSeriesPortuguesas(),
    scraper.getNovelasPortuguesas(),
  ]);
  console.log(`Filmes: ${filmes.length} | Séries PT: ${series.length} | Novelas: ${novelas.length}`);

  console.log(`\nA verificar filmes (concorrência ${CONCURRENCY})…`);
  const rFilmes = await poolMap(filmes, CONCURRENCY, checkMovie);

  console.log(`A verificar séries (concorrência ${CONCURRENCY})…`);
  const rSeries = await poolMap(series, CONCURRENCY, (row) => checkSeriesRow(row, 'series'));

  console.log(`A verificar novelas (concorrência ${CONCURRENCY})…`);
  const rNovelas = await poolMap(novelas, CONCURRENCY, (row) => checkSeriesRow(row, 'novela'));

  const s1 = summarize(rFilmes, 'FILMES', 'movie');
  const s2 = summarize(rSeries, 'SÉRIES PORTUGUESAS', 'series');
  const s3 = summarize(rNovelas, 'NOVELAS', 'novela');

  const report = {
    generatedAt: new Date().toISOString(),
    concurrency: CONCURRENCY,
    summary: {
      filmes: { total: s1.total, ok: s1.ok, bad: s1.bad },
      series: { total: s2.total, ok: s2.ok, bad: s2.bad },
      novelas: { total: s3.total, ok: s3.ok, bad: s3.bad },
    },
    failures: {
      filmes: s1.badRows,
      series: s2.badRows,
      novelas: s3.badRows,
    },
    /* relatório completo opcional — pode ser grande */
    all: {
      filmes: rFilmes,
      series: rSeries,
      novelas: rNovelas,
    },
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nRelatório completo: ${OUT_JSON}`);
  const exitBad = s1.bad + s2.bad + s3.bad;
  process.exit(exitBad > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
