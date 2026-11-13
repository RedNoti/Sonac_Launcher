import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const url = value => fileURLToPath(new URL(value, import.meta.url));
const stage = '../.tauri-preview-ui/';
await mkdir(url(stage), { recursive: true });
for (const file of ['app.js', 'workspace-ui.js', 'icons.js', 'style.css', 'app.png', 'brand-dark.png', 'brand-light.png']) {
  await cp(url('../src/ui/' + file), url(stage + file));
}
await cp(url('../tauri-preview/bridge.js'), url(stage + 'bridge.js'));
const page = (await readFile(url('../src/ui/index.html'), 'utf8'))
  .replace(/  <meta http-equiv="Content-Security-Policy"[^\n]+\n/u, '')
  .replace('  <script defer src="icons.js">', '  <script defer src="bridge.js"></script>\n  <script defer src="icons.js">');
await writeFile(url(stage + 'index.html'), page);
