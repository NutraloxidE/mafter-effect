import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(process.env.MAFTER_TEST_URL || 'http://localhost:5188');
  await page.waitForFunction(() => window.__mafterEditorStore?.getState().project);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff3366'; ctx.fillRect(0, 0, 64, 32);
    const png = await new Promise(r => canvas.toBlob(r));
    const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    const recorded = new Promise(r => { recorder.onstop = () => r(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start(); await new Promise(r => setTimeout(r, 350)); recorder.stop();
    const video = await recorded;
    const wav = new ArrayBuffer(44 + 1600); const d = new DataView(wav);
    const text = (offset, s) => [...s].forEach((c, i) => d.setUint8(offset + i, c.charCodeAt(0)));
    text(0, 'RIFF'); d.setUint32(4, 1636, true); text(8, 'WAVE'); text(12, 'fmt ');
    d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
    d.setUint32(24, 8000, true); d.setUint32(28, 16000, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
    text(36, 'data'); d.setUint32(40, 1600, true);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#33aaff"/></svg>';
    window.resourceDropFixtures = [
      new File(['unsupported'], 'notes.txt', { type: 'text/plain' }),
      new File([svg], 'art.SVG', { type: 'application/octet-stream' }),
      new File([png], 'photo.png', { type: 'image/png' }),
      new File([video], 'clip.webm', { type: 'video/webm' }),
      new File([wav], 'sound.wav', { type: 'audio/wav' }),
    ];
    window.resourceDrop = files => {
      const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
      const zone = document.querySelector('[data-resource-drop-zone]');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        const e = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
        zone.dispatchEvent(e);
        if (!e.defaultPrevented) throw new Error(type + ' did not prevent browser navigation');
      }
    };
    const dt = new DataTransfer(); dt.items.add(window.resourceDropFixtures[1]);
    const zone = document.querySelector('[data-resource-drop-zone]');
    zone.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.getByText('画像・SVG・動画・音声をドロップして追加', { exact: true }).waitFor();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(window.resourceDropFixtures[1]);
    document.querySelector('[data-resource-drop-zone]').dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
  });
  await page.getByText('画像・SVG・動画・音声をドロップして追加', { exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.resourceDrop(window.resourceDropFixtures);
    window.resourceDrop([new File([window.resourceDropFixtures[1]], 'queued.svg', { type: 'image/svg+xml' })]);
  });
  await page.waitForFunction(() => window.__mafterEditorStore.getState().project.assets.length === 5);
  await page.getByText('リソースを読み込み中…', { exact: true }).waitFor({ state: 'detached' });
  const imported = await page.evaluate(async () => {
    const s = window.__mafterEditorStore.getState();
    const comp = s.project.compositions.find(c => c.id === s.currentCompId);
    await s.saveToFs(); await window.__mafterEditorStore.getState().loadFromFs();
    return { kinds: s.project.assets.map(a => a.kind), layers: comp.objects.map(o => o.name), svg: s.project.assets.find(a => a.path.endsWith('.SVG')).meta };
  });
  assert.deepEqual(imported.layers, ['art', 'photo', 'clip', 'sound', 'queued']);
  assert.deepEqual(imported.kinds.sort(), ['audio', 'image', 'image', 'image', 'video']);
  assert.deepEqual(imported.svg, { width: 120, height: 60, mime: 'image/svg+xml' });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-object-id] img')].some(i => i.complete && i.naturalWidth === 120));
  await page.evaluate(() => window.resourceDrop([window.resourceDropFixtures[0]]));
  await page.getByRole('alert').filter({ hasText: 'notes.txt' }).waitFor();
  await page.evaluate(() => {
    const store = window.__mafterEditorStore;
    const original = store.getState().importAudioAsset;
    store.setState({ importAudioAsset: async () => { throw new Error('Simulated read failure'); } });
    window.restoreResourceImport = () => store.setState({ importAudioAsset: original });
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => window.resourceDrop([window.resourceDropFixtures[4], window.resourceDropFixtures[1]]));
  await page.getByRole('alert').filter({ hasText: 'Simulated read failure' }).waitFor();
  await page.evaluate(() => window.restoreResourceImport());
  await page.waitForFunction(() => window.__mafterEditorStore.getState().project.assets.length === 6);
  await page.locator('input[accept="image/*,.svg"]').setInputFiles([
    { name: 'picker.svg', mimeType: '', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>') },
    { name: 'picker2.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>') },
  ]);
  await page.waitForFunction(() => window.__mafterEditorStore.getState().project.assets.length === 8);
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('application/x-mafter-item', JSON.stringify({ kind: 'image-asset', id: 'internal' }));
    const e = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector('[data-resource-drop-zone]').dispatchEvent(e);
    if (e.defaultPrevented) throw new Error('External file import intercepted internal drag');
  });
  const binId = await page.evaluate(() => window.__mafterEditorStore.getState().createBin(null, 'Drop regression bin'));
  await page.getByText('Drop regression bin', { exact: true }).waitFor();
  await page.getByText('Drop regression bin', { exact: true }).locator('..').evaluate((row) => {
    const asset = window.__mafterEditorStore.getState().project.assets[0];
    const dt = new DataTransfer();
    dt.setData('application/x-mafter-project-tree', JSON.stringify({ entries: [{ kind: 'asset', id: asset.id }] }));
    row.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    row.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(id => window.__mafterEditorStore.getState().project.assets[0].binId === id, binId);
  const outputDir = await mkdtemp(path.join(tmpdir(), 'mafter-resource-drop-'));
  await page.screenshot({ path: path.join(outputDir, 'project.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'PASS', imported, totalAssets: 8, outputDir }));
} finally {
  await browser.close();
}
