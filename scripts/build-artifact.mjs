// Builds the claude.ai artifact version of the site into dist/artifact/.
// The artifact host supplies its own <html>/<head> wrapper and CSP, so the
// page is the <body> content with the title and stylesheet inlined at the top.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const src = new URL('../public/', import.meta.url);
const out = new URL('../dist/artifact/', import.meta.url);
mkdirSync(out, { recursive: true });

const html = readFileSync(new URL('index.html', src), 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1].trim();
const css = readFileSync(new URL('style.css', src), 'utf8');

// The skeleton's <html> has no dir/lang, so set them on the page root here.
const page = `${title}
<style>
${css}</style>
<script>document.documentElement.lang = 'he'; document.documentElement.dir = 'rtl';</script>
${body}
`;
writeFileSync(new URL('index.html', out), page);
for (const f of ['app.js', 'convert.js', 'worker.js', 'zip.js']) {
  copyFileSync(new URL(f, src), new URL(f, out));
}
console.log('Built', new URL('index.html', out).pathname);
