const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'dist');
const outFile = path.join(outDir, 'bundle.cjs');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
if (!fs.existsSync(path.join(outDir, 'public'))) fs.mkdirSync(path.join(outDir, 'public'), { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(__dirname, 'index.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['node18'],
    outfile: outFile,
    sourcemap: false,
  })
  .then(() => {
    const srcPublic = path.join(__dirname, 'public');
    const dstPublic = path.join(outDir, 'public');
    if (fs.existsSync(srcPublic)) {
      for (const name of fs.readdirSync(srcPublic)) {
        const src = path.join(srcPublic, name);
        const dst = path.join(dstPublic, name);
        if (fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
      }
    }
    console.log(`Build complete: ${outFile}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
