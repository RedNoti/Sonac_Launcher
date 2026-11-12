import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/fit.mjs';

export async function openTerminal(api, dialog, body, status) {
  const id = crypto.randomUUID();
  const terminal = new Terminal({
    fontFamily: 'Menlo, Consolas, monospace', fontSize: 14, cursorBlink: true, convertEol: false,
    theme: { background: '#101115', foreground: '#e7ecf4', cursor: '#a9c6f8' }
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(body);
  fit.fit();
  const unsubscribe = api.onTerminal(message => {
    if (message.id !== id) return;
    if (typeof message.data === 'string') terminal.write(message.data);
    else status('터미널이 종료됐습니다. (' + message.exitCode + ')');
  });
  terminal.onData(data => { void api.terminalWrite(id, data).catch(() => {}); });
  terminal.onResize(({ cols, rows }) => { void api.terminalResize(id, cols, rows).catch(() => {}); });
  const observer = new ResizeObserver(() => fit.fit());
  observer.observe(body);
  dialog.addEventListener('close', () => {
    observer.disconnect();
    unsubscribe();
    terminal.dispose();
    body.replaceChildren();
    void api.terminalClose(id).catch(() => {});
  }, { once: true });
  await api.terminal(id, terminal.cols, terminal.rows);
  if (dialog.open) terminal.focus();
  else await api.terminalClose(id);
}
