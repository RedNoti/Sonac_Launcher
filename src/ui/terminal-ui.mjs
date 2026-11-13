import { Terminal } from './vendor/xterm.mjs';
import { FitAddon } from './vendor/fit.mjs';

const api = window.terminal;
const body = document.querySelector('#terminal-body');
const status = document.querySelector('#terminal-status');
const commandsToggle = document.querySelector('#terminal-commands-toggle');
const commandsPanel = document.querySelector('#terminal-commands');
const filter = document.querySelector('#terminal-command-filter');
const list = document.querySelector('#terminal-command-list');
const add = document.querySelector('#terminal-command-add');
const editor = document.querySelector('#terminal-command-editor');
const form = document.querySelector('#terminal-command-form');
const remove = document.querySelector('#terminal-command-remove');
const save = form.querySelector('[type=submit]');
const close = document.querySelector('#terminal-command-close');
const listError = document.querySelector('#terminal-commands-error');
const editorError = document.querySelector('#terminal-command-error');
let commands = [];
let editing;
let saving = false;
let shellReady = false;

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function drawCommands(category = filter.value) {
  const categories = [...new Set(commands.map(item => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  filter.replaceChildren(new Option('전체 분류', ''), ...categories.map(name => new Option(name, name)));
  if (commands.some(item => !item.category)) filter.add(new Option('미분류', '\u0000'));
  filter.value = [...filter.options].some(option => option.value === category) ? category : '';
  filter.hidden = !commands.length;
  document.querySelector('#terminal-command-categories').replaceChildren(...categories.map(name => new Option(name)));
  list.replaceChildren(...commands.filter(item => !filter.value || (item.category || '\u0000') === filter.value).map(item => {
    const chip = document.createElement('div');
    chip.className = 'terminal-command';
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.textContent = item.name;
    insert.title = item.command;
    insert.disabled = !shellReady;
    insert.addEventListener('click', () => {
      commandsPanel.hidePopover();
      terminal.focus();
      terminal.paste(item.command);
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = item.name + ' 편집';
    edit.setAttribute('aria-label', edit.title);
    edit.append(icon('pencil', '#a9b9d3'));
    edit.addEventListener('click', () => openEditor(item));
    chip.append(insert, edit);
    return chip;
  }));
}

function openEditor(item) {
  editing = item;
  document.querySelector('#terminal-command-title').textContent = item ? '명령어 편집' : '명령어 추가';
  form.elements.name.value = item?.name ?? '';
  form.elements.category.value = item?.category ?? (filter.value === '\u0000' ? '' : filter.value);
  form.elements.command.value = item?.command ?? '';
  remove.hidden = !item;
  showError(editorError);
  commandsPanel.hidePopover();
  editor.showModal();
}

async function changeCommands(action, category) {
  if (saving) return;
  saving = save.disabled = remove.disabled = close.disabled = true;
  showError(editorError);
  try {
    commands = await action();
    drawCommands(category);
    editor.close();
  } catch (error) {
    showError(editorError, error.message);
  } finally {
    saving = save.disabled = remove.disabled = close.disabled = false;
  }
}

add.addEventListener('click', () => openEditor());
filter.addEventListener('change', () => drawCommands());
close.addEventListener('click', () => editor.close());
editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
editor.addEventListener('close', () => {
  commandsPanel.showPopover({ source: commandsToggle });
  add.focus();
});
form.addEventListener('submit', event => {
  event.preventDefault();
  const { name, category, command } = Object.fromEntries(new FormData(form));
  void changeCommands(() => api.saveCommand({ id: editing?.id, name, category, command }),
    category.trim().normalize('NFC') || '\u0000');
});
remove.addEventListener('click', () => void changeCommands(() => api.removeCommand(editing.id)));

function report(message) {
  status.textContent = message;
  status.hidden = false;
}

document.querySelector('#terminal-home').addEventListener('click', () => {
  void api.home().catch(error => report(error.message));
});

const terminal = new Terminal({
  fontFamily: 'Menlo, Consolas, monospace', fontSize: 14, cursorBlink: true,
  theme: { background: '#101115', foreground: '#e7ecf4', cursor: '#a9c6f8' }
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(body);
fit.fit();
api.onData(message => {
  if (typeof message.data === 'string') terminal.write(message.data);
  else {
    shellReady = false;
    drawCommands();
    report('터미널이 종료됐습니다. (' + message.exitCode + ')');
  }
});
terminal.onData(data => { void api.write(data).catch(() => {}); });
terminal.onResize(({ cols, rows }) => { void api.resize(cols, rows).catch(() => {}); });
new ResizeObserver(() => fit.fit()).observe(body);
void api.commands().then(items => {
  commands = items;
  add.disabled = false;
  drawCommands();
}).catch(error => showError(listError, error.message));
try {
  shellReady = true;
  await api.start(terminal.cols, terminal.rows);
  drawCommands();
  terminal.focus();
} catch (error) {
  shellReady = false;
  drawCommands();
  report(error.message);
}
