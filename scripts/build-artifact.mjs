// Builds the claude.ai artifact version of the site into dist/artifact/.
// The artifact host supplies its own <html>/<head> wrapper and CSP, so the
// page is the <body> content with the title and stylesheet inlined at the top.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';

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
// Every module the page loads, plus the HEIC decoder. The offline service
// worker and web-app manifest are left out: artifact pages cannot use them.
const files = readdirSync(src).filter((f) => f.endsWith('.js') && f !== 'sw.js');
mkdirSync(new URL('vendor/libheif/', out), { recursive: true });
for (const dir of ['libheif', 'fflate']) {
  mkdirSync(new URL(`vendor/${dir}/`, out), { recursive: true });
  for (const f of readdirSync(new URL(`vendor/${dir}/`, src))) files.push(`vendor/${dir}/${f}`);
}
for (const f of files) copyFileSync(new URL(f, src), new URL(f, out));
writeFileSync(new URL('files.json', out), JSON.stringify(files, null, 2));
console.log('Built', new URL('index.html', out).pathname);
