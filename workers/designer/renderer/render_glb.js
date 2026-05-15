// Render a GLB via headless Chromium + three.js: one textured hero shot
// plus several untextured "clay" angles.
//
// Usage: node render_glb.js <glb_path> <out_dir> <prefix>
// Writes <out_dir>/<prefix>-tex-0.png  (textured, front)
//    and <out_dir>/<prefix>-clay-0.png .. -clay-3.png  (untextured angles)
//
// three.js is served locally from this package's node_modules — the
// renderer has no CDN dependency at render time.
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// yaw (around the model) + slight downward pitch.
const TEX_ANGLES = [[0, 14]];                                  // hero, textured
const CLAY_ANGLES = [[55, 14], [-55, 14], [145, 14], [180, 14]]; // 3/4s, sides, back

const THREE_DIR = path.join(__dirname, 'node_modules', 'three');

const MIME = {
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.html': 'text/html', '.json': 'application/json',
};

async function main() {
  const [glbPath, outDir, prefix] = process.argv.slice(2);
  if (!glbPath || !outDir || !prefix) {
    console.error('usage: node render_glb.js <glb> <out_dir> <prefix>');
    process.exit(2);
  }
  const html = fs.readFileSync(path.join(__dirname, 'render.html'));
  const glb = fs.readFileSync(glbPath);

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/model.glb')) {
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
      res.end(glb);
      return;
    }
    if (url.startsWith('/three/')) {
      // Serve three.js (build + addons) straight out of node_modules. The
      // path is sanitized to stay inside THREE_DIR.
      const rel = path.normalize(url.slice('/three/'.length));
      const file = path.join(THREE_DIR, rel);
      if (!file.startsWith(THREE_DIR) || !fs.existsSync(file)) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
           '--enable-unsafe-swiftshader', '--enable-webgl',
           '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.error('[page]', m.type(), m.text()));
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('requestfailed', (r) => console.error('[reqfail]', r.url(), r.failure() && r.failure().errorText));
    await page.goto(
      `http://localhost:${port}/render.html?glb=http://localhost:${port}/model.glb`,
      { waitUntil: 'load' });
    await page.waitForFunction('window.__ready===true || window.__error', { timeout: 90000 });
    const err = await page.evaluate('window.__error || null');
    if (err) throw new Error('GLB load failed: ' + err);

    const shoot = async (kind, angles) => {
      let i = 0;
      for (const [yaw, pitch] of angles) {
        const data = await page.evaluate((y, p) => window.shoot(y, p), yaw, pitch);
        const b64 = data.replace(/^data:image\/png;base64,/, '');
        fs.writeFileSync(path.join(outDir, `${prefix}-${kind}-${i}.png`),
                         Buffer.from(b64, 'base64'));
        i++;
      }
      return i;
    };

    const nt = await shoot('tex', TEX_ANGLES);     // textured hero first
    await page.evaluate('window.setClay(true)');   // strip textures
    const nc = await shoot('clay', CLAY_ANGLES);   // untextured angles
    console.log(`OK: ${nt} textured + ${nc} clay renders -> ${outDir}/${prefix}-*.png`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error('RENDER FAIL:', e.message); process.exit(1); });
