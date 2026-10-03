import { convertImage, detectFormat } from './convert.js';
import { buildZipParts } from './zip.js';
import { webpLosslessSupported } from './webp.js';

const MAX_FILES = 300;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
// Past this much converted data held in memory, suggest saving to a folder.
const MEMORY_WARNING_BYTES = 1.5 * 1024 ** 3;
const IMAGE_EXT = /\.(jpe?g|jfif|heic|heif)$/i;

const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('file-input');
const folderInput = $('folder-input');
const fileList = $('file-list');
const summary = $('summary');
const progressBar = $('progress-bar');
const progress = progressBar.parentElement;
const statusText = $('status-text');
const sizeText = $('size-text');
const zipButton = $('download-zip');
const saveFolderButton = $('save-folder');
const stopButton = $('stop');
const clearButton = $('clear');
const folderText = $('folder-text');
const messageBox = $('message');
const keepMetadata = $('keep-metadata');
const formatSelect = $('format');

$('limits-hint').textContent =
  `עד ${MAX_FILES} קבצים, עד ${MAX_FILE_SIZE / 1024 / 1024}MB לקובץ`;

/**
 * @typedef {{id:number, file:File, outBase:string, outName?:string, status:string,
 *   options:object, blob?:Blob, crc?:number, thumbUrl?:string, savedToFolder?:boolean,
 *   li:HTMLLIElement, meta:HTMLElement, state:HTMLElement, thumb:HTMLElement, actions:HTMLElement}} Item
 */
/** @type {Map<number, Item>} */
const items = new Map();
const queue = [];
const usedNames = new Set();
let nextId = 1;
let folderHandle = null;

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
    runOnMainThread(item).then(p.resolve, p.reject);
  }
  pump();
}

async function runOnMainThread(item) {
  try {
    return await convertImage(item.file, item.options);
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
      w.postMessage({ id: item.id, file: item.file, options: item.options });
    });
  }
  mainThreadSlots--;
  return runOnMainThread(item);
}

function hasCapacity() {
  return workers.length ? idle.length > 0 : mainThreadSlots > 0;
}

function pump() {
  while (queue.length && hasCapacity()) {
    const item = queue.shift();
    if (!items.has(item.id)) continue; // removed meanwhile
    setStatus(item, 'working', 'ממיר…');
    convert(item).then(
      (res) => onConverted(item, res),
      (err) => {
        if (!items.has(item.id)) return;
        setStatus(item, 'error', err.message || 'שגיאה');
        update();
      },
    );
  }
  update();
}

async function onConverted(item, res) {
  if (!items.has(item.id)) return;
  item.outName = uniqueName(item.outBase, res.extension);
  item.blob = res.blob;
  item.crc = res.crc;
  if (res.thumb) {
    item.thumbUrl = URL.createObjectURL(res.thumb);
    const img = document.createElement('img');
    img.src = item.thumbUrl;
    img.alt = '';
    item.thumb.replaceChildren(img);
  }
  const gamut = res.wideGamut ? ' · צבע רחב P3' : '';
  item.meta.textContent =
    `${res.width}×${res.height} · ${formatSize(item.file.size)} ← ${formatSize(res.blob.size)}${gamut}`;
  setStatus(item, 'done', 'הושלם');

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'link';
  download.textContent = 'הורדה';
  download.addEventListener('click', () => saveFile(item.blob, item.outName));
  item.actions.prepend(download);

  if (folderHandle) await writeToFolder(item);
  update();
}

// ---------- File intake ----------

function uniqueName(base, ext) {
  let name = `${base}.${ext}`;
  for (let i = 1; usedNames.has(name.toLowerCase()); i++) name = `${base} (${i}).${ext}`;
  usedNames.add(name.toLowerCase());
  return name;
}

/**
 * @param {File[]} fileArray
 * @param {{fromFolder?: boolean}} [opts] files from a folder that are not
 *   images are skipped silently (and counted) instead of listed as errors.
 */
async function addFiles(fileArray, { fromFolder = false } = {}) {
  let rejected = 0;
  let skipped = 0;
  const options = { keepMetadata: keepMetadata.checked, format: formatSelect.value };
  for (const file of fileArray) {
    const looksImage = /^image\/(jpeg|heic|heif)$/.test(file.type) || IMAGE_EXT.test(file.name);
    if (fromFolder && !looksImage) {
      skipped++;
      continue;
    }
    if (items.size >= MAX_FILES) {
      rejected++;
      continue;
    }
    const base = (file.name || 'image').replace(/\.[^.]*$/, '') || 'image';
    const item = { id: nextId++, file, outBase: base, status: 'queued', options };
    renderItem(item);
    items.set(item.id, item);
    if (file.size > MAX_FILE_SIZE) setStatus(item, 'error', 'הקובץ גדול מדי');
    else if (!looksImage && !(await detectFormat(file))) setStatus(item, 'error', 'לא קובץ JPG');
    else queue.push(item);
  }
  const notes = [];
  if (rejected) notes.push(`ניתן להמיר עד ${MAX_FILES} קבצים בכל פעם. ${files(rejected)} לא נוספו.`);
  if (skipped) notes.push(`${skipped === 1 ? 'קובץ אחד שאינו תמונת JPG דולג' : `${skipped} קבצים שאינם תמונות JPG דולגו`}.`);
  if (notes.length) showMessage(notes.join(' '));
  pump();
}

function renderItem(item) {
  const li = document.createElement('li');
  item.thumb = document.createElement('div');
  item.thumb.className = 'thumb';
  const info = document.createElement('div');
  info.className = 'name';
  const name = document.createElement('bdi');
  name.textContent = item.file.name || 'תמונה מודבקת';
  item.meta = document.createElement('div');
  item.meta.className = 'meta';
  item.meta.textContent = formatSize(item.file.size);
  info.append(name, item.meta);
  item.state = document.createElement('span');
  item.state.className = 'state';
  item.actions = document.createElement('div');
  item.actions.className = 'item-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', `הסרת ${item.file.name || 'הקובץ'}`);
  remove.addEventListener('click', () => removeItem(item));
  item.actions.append(remove);
  li.append(item.thumb, info, item.state, item.actions);
  item.li = li;
  fileList.append(li);
  setStatus(item, 'queued', 'בתור');
}

function setStatus(item, status, label) {
  item.status = status;
  item.li.className = status;
  item.state.textContent = label;
}

function releaseItem(item) {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.outName) usedNames.delete(item.outName.toLowerCase());
  item.blob = undefined;
}

function removeItem(item) {
  releaseItem(item);
  items.delete(item.id);
  item.li.remove();
  update();
}

// ---------- Summary ----------

function update() {
  const all = [...items.values()];
  const done = all.filter((i) => i.status === 'done');
  const failed = all.filter((i) => i.status === 'error').length;
  const finished = done.length + failed;
  const busy = finished < all.length;
  summary.hidden = all.length === 0;
  const pct = all.length ? Math.round((finished / all.length) * 100) : 0;
  progressBar.style.width = `${pct}%`;
  progress.setAttribute('aria-valuenow', String(pct));

  let text = `${done.length} מתוך ${all.length} קבצים הומרו`;
  if (failed) text += ` · ${failed} נכשלו`;
  if (busy) text += ' · ממיר…';
  statusText.textContent = text;

  const inBytes = done.reduce((n, i) => n + i.file.size, 0);
  const outBytes = done.reduce((n, i) => n + (i.blob?.size ?? 0), 0);
  sizeText.textContent = done.length
    ? `גודל מקורי ${formatSize(inBytes)} ← לאחר ההמרה ${formatSize(outBytes)}`
    : '';

  zipButton.disabled = done.length === 0 || busy || !!folderHandle;
  stopButton.hidden = !busy;
  saveFolderButton.hidden = !('showDirectoryPicker' in window) || !!folderHandle;

  const inMemory = done.filter((i) => i.blob).reduce((n, i) => n + i.blob.size, 0);
  if (inMemory > MEMORY_WARNING_BYTES && !folderHandle && !memoryWarned) {
    memoryWarned = true;
    showMessage(
      'נצברו בזיכרון יותר מ-1.5GB של קבצים מומרים, והדפדפן עלול להאט או להיסגר. ' +
        ('showDirectoryPicker' in window
          ? 'מומלץ ללחוץ על "שמירה ישירה לתיקייה".'
          : 'מומלץ להוריד את הקבצים כ-ZIP, ללחוץ על "ניקוי" ולהמשיך בקבוצה הבאה.'),
      { sticky: true },
    );
  }
}
let memoryWarned = false;

// ---------- Saving ----------

zipButton.addEventListener('click', () => {
  const entries = [...items.values()]
    .filter((i) => i.status === 'done' && i.blob)
    .map((i) => ({ name: i.outName, data: i.blob, size: i.blob.size, crc: i.crc }));
  const zip = new Blob(buildZipParts(entries), { type: 'application/zip' });
  saveFile(zip, 'converted-images.zip');
});

// Saving straight into a folder the user picks (Chrome/Edge): each converted
// file is written to disk and dropped from memory, so batch size is limited
// only by disk space.
saveFolderButton.addEventListener('click', async () => {
  try {
    folderHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'jpgtopng' });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    saveFolderButton.remove();
    showMessage('הדפדפן לא מאפשר כאן שמירה לתיקייה. השתמשו בהורדת ZIP.');
    return;
  }
  folderText.hidden = false;
  folderText.textContent = `הקבצים נשמרים ישירות לתיקייה "${folderHandle.name}".`;
  messageBox.hidden = true;
  for (const item of items.values()) {
    if (item.status === 'done' && item.blob) await writeToFolder(item);
  }
  update();
});

async function writeToFolder(item) {
  let name = item.outName;
  // Never overwrite a file that is already in the folder.
  for (let i = 1; await fileExists(folderHandle, name); i++) {
    name = item.outName.replace(/(\.\w+)$/, ` (${i})$1`);
  }
  try {
    const handle = await folderHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(item.blob);
    await writable.close();
    item.blob = undefined; // free the memory; the file is on disk now
    item.savedToFolder = true;
    item.actions.querySelector('.link')?.remove();
    setStatus(item, 'done', 'נשמר בתיקייה');
  } catch {
    showMessage(`שמירת ${name} בתיקייה נכשלה. בדקו שיש מקום פנוי והרשאת כתיבה.`);
  }
}

async function fileExists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

// When the page runs inside a claude.ai artifact, plain download links are
// blocked by the sandbox; the platform's `downloads` capability is used
// instead. Anywhere else, a regular <a download> is used.
const downloadsReady = window.claude?.use
  ? window.claude.use('downloads').catch(() => null)
  : Promise.resolve(null);

async function saveFile(blob, filename) {
  if (!blob) return;
  const downloads = await downloadsReady;
  if (!downloads) {
    linkDownload(blob, filename);
    return;
  }
  try {
    await downloads.save({ filename, data: blob });
  } catch (err) {
    if (err?.code === 'declined') return;
    if (err?.code === 'rate_limited') showMessage('חלון הורדה כבר פתוח. אשרו או סגרו אותו ונסו שוב.');
    else showMessage('ההורדה נכשלה. נסו שוב.');
  }
}

function linkDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let messageTimer;
function showMessage(text, { sticky = false } = {}) {
  messageBox.textContent = text;
  messageBox.hidden = false;
  clearTimeout(messageTimer);
  if (!sticky) messageTimer = setTimeout(() => (messageBox.hidden = true), 10_000);
}

stopButton.addEventListener('click', () => {
  // Files already being converted finish; everything still queued is removed.
  for (const item of queue.splice(0)) removeItem(item);
  update();
});

clearButton.addEventListener('click', () => {
  for (const item of items.values()) releaseItem(item);
  items.clear();
  queue.length = 0;
  usedNames.clear();
  fileList.replaceChildren();
  fileInput.value = '';
  folderInput.value = '';
  messageBox.hidden = true;
  memoryWarned = false;
  update();
});

function formatSize(bytes) {
  let text;
  if (bytes < 1024) text = `${bytes} B`;
  else if (bytes < 1024 * 1024) text = `${(bytes / 1024).toFixed(1)} KB`;
  else if (bytes < 1024 ** 3) text = `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  else text = `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `\u2066${text}\u2069`; // isolate as left-to-right inside Hebrew text
}

const files = (n) => (n === 1 ? 'קובץ אחד' : `${n} קבצים`);

// ---------- Input wiring: picker, folder, drag & drop, paste ----------

fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});
$('pick-folder').addEventListener('click', () => folderInput.click());
folderInput.addEventListener('change', () => {
  addFiles([...folderInput.files], { fromFolder: true });
  folderInput.value = '';
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
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  const entries = [...e.dataTransfer.items]
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.some((en) => en.isDirectory)) {
    const files = [];
    for (const en of entries) await collectFiles(en, files);
    addFiles(files, { fromFolder: true });
  } else {
    addFiles([...e.dataTransfer.files]);
  }
});

/** Recursively collect files from a dropped folder. */
async function collectFiles(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((res, rej) => entry.file(res, rej)));
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    // readEntries returns results in batches; call until it returns none.
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await collectFiles(child, out);
  }
}

window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  // Pasted images often have a generic name ("image.jpg"); give each a unique one.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  addFiles(files.map((f, i) => new File([f], `pasted-${stamp}-${i + 1}.jpg`, { type: f.type })));
});

// Prevent the browser from opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// Offer lossless WebP only where the browser's encoder is verifiably lossless.
webpLosslessSupported().then((ok) => {
  $('format-field').hidden = !ok;
});

update();

// Offline support (not inside claude.ai, where service workers are unavailable).
if ('serviceWorker' in navigator && !window.claude && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
