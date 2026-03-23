/**

 * Bundle da aplicação num único ficheiro com esbuild.

 * Reduz a necessidade de node_modules em produção (0 ficheiros após build).

 */



const esbuild = require('esbuild');

const fs = require('fs');

const path = require('path');



const outDir = path.join(__dirname, 'dist');

const outFile = path.join(outDir, 'bundle.cjs');

const publicSrc = path.join(__dirname, 'public');



if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });



// Polyfill File (e Blob) para Node 18 - undici espera global File

const node18Shim = `

(function(){

  if (typeof globalThis.Blob === 'undefined') globalThis.Blob = require('buffer').Blob;

  if (typeof globalThis.File === 'undefined') {

    var Blob = globalThis.Blob;

    function File(bits, name, opts) {

      if (!(this instanceof File)) return new File(bits, name, opts);

      Blob.call(this, bits, opts || {});

      this.name = name || '';

      this.lastModified = (opts && opts.lastModified) || Date.now();

    }

    File.prototype = Object.create(Blob.prototype);

    File.prototype.constructor = File;

    globalThis.File = File;

  }

})();

`;



/**

 * Stremio espera logo em PNG (URL); reduzimos para 256×256 para carregar rápido.

 */

async function optimizeAddonLogoPng(dir) {

  const logoPath = path.join(dir, 'addon-logo.png');

  if (!fs.existsSync(logoPath)) return;

  let sharp;

  try {

    sharp = require('sharp');

  } catch (_) {

    console.warn('sharp não disponível — addon-logo.png não foi otimizado.');

    return;

  }

  const buf = await sharp(logoPath)

    .resize(256, 256, { fit: 'cover' })

    .png({ compressionLevel: 9, effort: 10 })

    .toBuffer();

  fs.writeFileSync(logoPath, buf);

  console.log('Logo PNG:', buf.length, 'bytes →', path.relative(__dirname, logoPath));

}



esbuild.buildSync({

  entryPoints: [path.join(__dirname, 'index.js')],

  bundle: true,

  platform: 'node',

  target: 'node18',

  outfile: outFile,

  format: 'cjs',

  minify: false,

  sourcemap: false,

  external: [],

  banner: { js: node18Shim },

});



(async () => {

  await optimizeAddonLogoPng(publicSrc);



  const publicDest = path.join(outDir, 'public');

  if (fs.existsSync(publicSrc)) {

    if (!fs.existsSync(publicDest)) fs.mkdirSync(publicDest, { recursive: true });

    const files = fs.readdirSync(publicSrc);

    for (const f of files) {

      const src = path.join(publicSrc, f);

      const dest = path.join(publicDest, f);

      if (fs.statSync(src).isFile()) fs.copyFileSync(src, dest);

    }

  }



  const removeNodeModules =

    process.env.REMOVE_NODE_MODULES === '1' || process.argv.includes('--remove-node-modules');

  if (removeNodeModules && fs.existsSync(path.join(__dirname, 'node_modules'))) {

    fs.rmSync(path.join(__dirname, 'node_modules'), { recursive: true, force: true });

    console.log('node_modules removido (produção).');

  }



  console.log('Build concluído:', outFile);

})().catch((e) => {

  console.error(e);

  process.exit(1);

});


