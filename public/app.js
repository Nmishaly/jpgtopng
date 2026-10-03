import { convertJpegToPng } from './convert.js';
import { buildZipParts } from './zip.js';

const MAX_FILES = 300;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const JPEG_EXT = /\.(jpe?g|jfif)$/i;

const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('file-input');
const fileList = $('file-list');
const summary = $('summary');
const progressBar = $('progress-bar');
const progress = progressBar.parentElement;
const statusText = $('status-text');
const zipButton = $('download-zip');
const clearButton = $('clear');

$('limits-hint').textContent =
  `עד ${MAX_FILES} קבצים, עד ${MAX_FILE_SIZE / 1024 / 1024}MB לקובץ`;

/** @type {Map<number, {id:number,file:File,outName:string,status:string,blob?:Blob,crc?:number,url?:string,li:HTMLLIElement}>} */
const items = new Map();
const queue = [];
const usedNames = new Set();
let nextId = 1;

// ---------- Conversion engine: worker pool, main-thread fallback ----------

const poolSize = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 4));
const pending = new Map(); // id -> {resolve, reject}
let workers = [];
const idle = [];

function workerSupported() {
  try {
    const c = new OffscreenCanvas(1, 1);
    return !!c.getContext('2d') && typeof c.convertToBlob === 'function';
  } catch {
    return false;
  }
}

if (workerSupported()) {
  try {
    workers = Array.from({ length: poolSize }, () => {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        const p = pending.get(data.id);
        pending.delete(data.id);
        idle.push(w);
        if (p) data.ok ? p.resolve(data) : p.reject(new Error(data.error));
        pump();
      };
      w.onerror = (e) => {
        e.preventDefault();
        fallBackToMainThread();
      };
      return w;
    });
    idle.push(...workers);
  } catch {
    workers = [];
  }
}

let mainThreadSlots = workers.length ? 0 : 2;

function fallBackToMainThread() {
  // A worker failed (e.g. no module-worker support): finish on the main thread.
  if (!workers.length) return;
  for (const w of workers) w.terminate();
  workers = [];
  idle.length = 0;
  mainThreadSlots = 2;
  const stranded = [...pending];
  pending.clear();
  for (const [id, p] of stranded) {
    const item = items.get(id);
    if (!item) continue;
    mainThreadSlots--;
    runOnMainThread(item.file).then(p.resolve, p.reject);
  }
  pump();
}

async function runOnMainThread(file) {
  try {
    return await convertJpegToPng(file);
  } finally {
    mainThreadSlots++;
    pump();
  }
}

function convert(item) {
  if (workers.length && idle.length) {
    const w = idle.pop();
    return new Promise((resolve, reject) => {
      pending.set(item.id, { resolve, reject });
      w.postMessage({ id: item.id, file: item.file });
    });
  }
  mainThreadSlots--;
  return runOnMainThread(item.file);
}

function hasCapacity() {
  return workers.length ? idle.length > 0 : mainThreadSlots > 0;
}

function pump() {
  while (queue.length && hasCapacity()) {
    const item = queue.shift();
    if (!items.has(item.id)) continue; // cleared meanwhile
    setStatus(item, 'working', 'ממיר…');
    convert(item).then(
      (res) => {
        if (!items.has(item.id)) return;
        item.blob = res.blob;
        item.crc = res.crc;
        item.url = URL.createObjectURL(res.blob);
        item.meta.textContent = `${res.width}×${res.height} · ${formatSize(res.blob.size)}`;
        setStatus(item, 'done', 'הושלם');
        const a = document.createElement('a');
        a.href = item.url;
        a.download = item.outName;
        a.textContent = 'הורדה';
        item.li.append(a);
        update();
      },
      (err) => {
        if (!items.has(item.id)) return;
        setStatus(item, 'error', err.message || 'שגיאה');
        update();
      },
    );
  }
  update();
}

// ---------- File intake ----------

function uniqueName(base) {
  let name = `${base}.png`;
  for (let i = 1; usedNames.has(name.toLowerCase()); i++) name = `${base} (${i}).png`;
  usedNames.add(name.toLowerCase());
  return name;
}

function addFiles(fileArray) {
  let rejected = 0;
  for (const file of fileArray) {
    if (items.size >= MAX_FILES) {
      rejected++;
      continue;
    }
    const looksJpeg = file.type === 'image/jpeg' || JPEG_EXT.test(file.name);
    const base = file.name.replace(/\.[^.]*$/, '') || 'image';
    const item = { id: nextId++, file, outName: uniqueName(base), status: 'queued' };
    item.li = renderItem(item);
    items.set(item.id, item);
    if (!looksJpeg) setStatus(item, 'error', 'לא קובץ JPG');
    else if (file.size > MAX_FILE_SIZE) setStatus(item, 'error', 'הקובץ גדול מדי');
    else queue.push(item);
  }
  if (rejected) alert(`ניתן להמיר עד ${MAX_FILES} קבצים בכל פעם. ${rejected} קבצים לא נוספו.`);
  pump();
}

function renderItem(item) {
  const li = document.createElement('li');
  const info = document.createElement('div');
  info.className = 'name';
  const name = document.createElement('bdi');
  name.textContent = item.file.name;
  item.meta = document.createElement('div');
  item.meta.className = 'meta';
  item.meta.textContent = formatSize(item.file.size);
  info.append(name, item.meta);
  item.state = document.createElement('span');
  item.state.className = 'state';
  li.append(info, item.state);
  fileList.append(li);
  setStatus(item, 'queued', 'בתור');
  return li;
}

function setStatus(item, status, label) {
  item.status = status;
  (item.li || item.state.parentElement).className = status;
  item.state.textContent = label;
}

// ---------- Summary / download ----------

function update() {
  const all = [...items.values()];
  const done = all.filter((i) => i.status === 'done').length;
  const failed = all.filter((i) => i.status === 'error').length;
  const finished = done + failed;
  summary.hidden = all.length === 0;
  const pct = all.length ? Math.round((finished / all.length) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(pct));
  let text = `${done} מתוך ${all.length} קבצים הומרו`;
  if (failed) text += ` · ${failed} נכשלו`;
  if (finished < all.length) text += ' · ממיר…';
  statusText.textContent = text;
  zipButton.disabled = done === 0 || finished < all.length;
}

zipButton.addEventListener('click', () => {
  const entries = [...items.values()]
    .filter((i) => i.status === 'done')
    .map((i) => ({ name: i.outName, data: i.blob, size: i.blob.size, crc: i.crc }));
  try {
    const zip = new Blob(buildZipParts(entries), { type: 'application/zip' });
    triggerDownload(zip, 'converted-png.zip');
  } catch (err) {
    alert(err.message);
  }
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

clearButton.addEventListener('click', () => {
  for (const item of items.values()) if (item.url) URL.revokeObjectURL(item.url);
  items.clear();
  queue.length = 0;
  usedNames.clear();
  fileList.replaceChildren();
  fileInput.value = '';
  update();
});

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- Input wiring ----------

fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('dragover'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
