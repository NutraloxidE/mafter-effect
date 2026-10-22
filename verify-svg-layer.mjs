import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-accelerated-video-encode'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
const outputDir = await mkdtemp(path.join(tmpdir(), 'mafter-svg-layer-'));
page.on('console', msg => { if (msg.type() === 'error' || msg.text().startsWith('SVG VERIFY')) console.log(msg.text()); });
page.on('pageerror', error => console.log(error.message));
try {
  await page.goto(process.env.MAFTER_TEST_URL || 'http://localhost:5187');
  await page.waitForFunction(() => window.__mafterEditorStore?.getState().project);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#f02040"/><circle cx="40" cy="40" r="20" fill="#20c0ff"/></svg>';
  await page.locator('input[accept="image/*,.svg"]').setInputFiles({ name: 'vector.SVG', mimeType: 'application/octet-stream', buffer: Buffer.from(svg) });
  await page.waitForFunction(() => window.__mafterEditorStore.getState().project.assets.some(a => /\.SVG$/.test(a.path)));
  const result = await page.evaluate(async () => {
    const store = window.__mafterEditorStore;
    let s = store.getState();
    const asset = s.project.assets.find(a => /\.SVG$/.test(a.path));
    const comp = s.project.compositions.find(c => c.id === s.currentCompId);
    const obj = comp.objects.find(o => o.components.some(c => c.props.asset === asset.id));
    if (!obj) throw new Error('UI did not create an SVG image layer');
    const { probeImageFile, ImageAssetCache } = await import('/src/runtime/imageAssetCache.ts');
    const viewBox = await probeImageFile(new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><rect width="240" height="120" fill="red"/></svg>'], 'viewbox.svg'));
    const { setKeyframe } = await import('/src/editor/store.ts');
    const position = setKeyframe(setKeyframe(obj.transform.position, 0, { x: 20, y: 20, z: 0 }), 2, { x: 80, y: 40, z: 0 });
    s.updateObject(obj.id, { transform: { ...obj.transform, position } });
    s = store.getState();
    const before = s.project;
    const after = structuredClone(before);
    const c = after.compositions.find(c => c.id === comp.id);
    c.width = 320; c.height = 180; c.duration = 3; c.background = '#000000';
    s.applyCommand({ label: 'SVG verification composition', before, after });
    await store.getState().saveToFs();
    await store.getState().loadFromFs();
    s = store.getState();
    const project = s.project;
    const fs = s.getFs();
    const { exportProjectZip, importZip } = await import('/src/fs/zip.ts');
    const { MemoryFs } = await import('/src/fs/MemoryFs.ts');
    const zip = await exportProjectZip(fs, project);
    const copy = new MemoryFs();
    await importZip(copy, zip);
    const original = await fs.readText(asset.path);
    if (await copy.readText(asset.path) !== original) throw new Error('SVG zip round trip changed bytes');
    const { DomRenderer } = await import('/src/runtime/DomRenderer.ts');
    const { resolve } = await import('/src/runtime/resolve.ts');
    const cache = new ImageAssetCache();
    await cache.loadFromProject(project, fs, { proxyMaxDim: 16 });
    if (!cache.getUrl(asset.id).startsWith('data:image/svg+xml')) throw new Error('SVG was rasterized');
    const container = document.createElement('div');
    container.id = 'svg-verification';
    container.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:999999;background:black';
    document.body.append(container);
    const renderer = new DomRenderer();
    const tl = project.compositions.find(c => c.id === comp.id);
    renderer.setImageCache(cache);
    renderer.mount(container, tl);
    renderer.renderFrame(resolve(tl, 0), 0);
    await Promise.all([...container.querySelectorAll('img')].map(i => i.decode()));
    window.svgVerification = { renderer, project, fs, comp: tl, resolve };
    return { meta: asset.meta, viewBox, layerId: obj.id, size: cache.getSize(asset.id) };
  });
  assert.deepEqual(result.meta, { width: 160, height: 80, mime: 'image/svg+xml' });
  assert(result.viewBox.width > 0 && result.viewBox.width / result.viewBox.height === 2);
  await page.locator('#svg-verification').screenshot({ path: path.join(outputDir, 'preview-0.png') });
  const frames = [];
  for (const frame of [0, 2]) {
    frames.push(await page.evaluate(async frame => {
      const v = window.svgVerification;
      v.renderer.renderFrame(v.resolve(v.comp, frame), frame);
      await new Promise(requestAnimationFrame);
      const el = document.querySelector(`#svg-verification [data-object-id]`);
      return { frame, transform: el.style.transform };
    }, frame));
  }
  assert.notEqual(frames[0].transform, frames[1].transform);
  await page.locator('#svg-verification').screenshot({ path: path.join(outputDir, 'preview-2.png') });
  const exported = await page.evaluate(async () => {
    const { exportComposition } = await import('/src/runtime/exporter.ts');
    const { exportBundle } = await import('/src/runtime/bundleExporter.ts');
    const v = window.svgVerification;
    const outputs = [];
    for (const format of ['png-seq', 'mp4', 'webm', 'html-bundle']) {
      console.log('SVG VERIFY ' + format);
      const config = { range: [0, 3], fps: 30, scale: 1, alpha: false, format, encodeLatencyMode: 'realtime' };
      const result = format === 'html-bundle'
        ? await exportBundle(v.project, v.comp.id, v.fs, config, p => console.log('SVG VERIFY ' + p.message))
        : await exportComposition(v.project, v.comp.id, v.fs, config, p => console.log('SVG VERIFY ' + p.message));
      if (result.format !== format) throw new Error(`${format}: unexpected fallback ${result.fallbackReason}`);
      outputs.push({ format, bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) });
    }
    return outputs;
  });
  for (const out of exported) await writeFile(path.join(outputDir, `${out.format}.${out.format === 'mp4' || out.format === 'webm' ? out.format : 'zip'}`), Buffer.from(out.bytes));
  const pngZip = await JSZip.loadAsync(exported.find(o => o.format === 'png-seq').bytes);
  const pngs = Object.keys(pngZip.files).filter(p => p.endsWith('.png')).sort();
  assert.equal(pngs.length, 3);
  const compare = async (a, b) => page.evaluate(async ([a, b]) => {
    const decode = async base64 => {
      const img = new Image(); img.src = 'data:image/png;base64,' + base64; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height).data;
    };
    const x = await decode(a), y = await decode(b);
    if (x.length !== y.length) throw new Error('Different image dimensions');
    let sum = 0, ink = 0;
    for (let i = 0; i < x.length; i++) { sum += Math.abs(x[i] - y[i]); if (i % 4 !== 3 && x[i] > 30) ink++; }
    return { meanAbsDiff: sum / x.length, ink };
  }, [a, b]);
  const parity = [];
  for (const frame of [0, 2]) {
    const preview = (await readFile(path.join(outputDir, `preview-${frame}.png`))).toString('base64');
    const png = await pngZip.file(pngs[frame]).async('base64');
    const diff = await compare(preview, png);
    assert(diff.ink > 1000 && diff.meanAbsDiff < 1, JSON.stringify(diff));
    parity.push({ frame, ...diff });
  }
  const bundle = await JSZip.loadAsync(exported.find(o => o.format === 'html-bundle').bytes);
  await page.route('**/__svg-bundle/**', async route => {
    const file = new URL(route.request().url()).pathname.split('/__svg-bundle/')[1];
    const entry = bundle.file(file);
    if (!entry) return route.fulfill({ status: 404, body: '' });
    let body = await entry.async('nodebuffer');
    if (file === 'index.html') body = Buffer.from(body.toString().replace(/"range":\[0,3\]/, '"range":[2,3]'));
    await route.fulfill({ body, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.SVG') ? 'image/svg+xml' : 'application/octet-stream' });
  });
  await page.setViewportSize({ width: 320, height: 180 });
  await page.goto(new URL('/__svg-bundle/index.html', process.env.MAFTER_TEST_URL || 'http://localhost:5187').href);
  await page.waitForFunction(() => [...document.images].some(i => i.complete && i.naturalWidth === 160));
  await page.locator('#mafter-stage').screenshot({ path: path.join(outputDir, 'bundle-2.png') });
  const bundleDiff = await compare((await readFile(path.join(outputDir, 'preview-2.png'))).toString('base64'), (await readFile(path.join(outputDir, 'bundle-2.png'))).toString('base64'));
  assert(bundleDiff.ink > 1000 && bundleDiff.meanAbsDiff < 1, JSON.stringify(bundleDiff));
  console.log(JSON.stringify({ outputDir, parity, bundleDiff }));
  console.log(JSON.stringify({ result, frames, outputs: exported.map(o => ({ format: o.format, bytes: o.bytes.length })) }, null, 2));
} finally {
  await browser.close();
}
