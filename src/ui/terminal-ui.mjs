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
const tabList = document.querySelector('#terminal-tabs');
const addTab = document.querySelector('#terminal-tab-add');
const tabs = new Map();
const tabLimit = 8;
const connectionColors = ['#2f66d8', '#6d38db', '#a5561d', '#1f8a5b', '#b04a1e', '#1b3f5e'];
let commands = [];
let editing;
let saving = false;
let commandCategory = '';
let activeTab;
let nextTabId = 1;

function showError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function drawCommands(category = commandCategory) {
  const categories = [...new Set(commands.map(item => item.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const options = [['', '전체'], ...categories.map(name => [name, name])];
  if (commands.some(item => !item.category)) options.push(['\u0000', '미분류']);
  commandCategory = options.some(([value]) => value === category) ? category : '';
  filter.replaceChildren(...options.map(([value, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(value === commandCategory));
    chip.addEventListener('click', () => {
      drawCommands(value);
      filter.querySelector('[aria-pressed="true"]').focus();
    });
    return chip;
  }));
  filter.hidden = !commands.length;
  document.querySelector('#terminal-command-categories').replaceChildren(...categories.map(name => new Option(name)));
  const visible = commands.filter(item => !commandCategory || (item.category || '\u0000') === commandCategory);
  visible.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  list.replaceChildren(...visible.map((item, index) => {
    const row = document.createElement('div');
    row.className = 'terminal-command';
    row.style.setProperty('--row-delay', 80 + Math.min(index, 10) * 40 + 'ms');
    const insert = document.createElement('button');
    insert.type = 'button';
    const avatar = document.createElement('span');
    avatar.className = 'terminal-command-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = Array.from(item.name)[0].toLocaleUpperCase('ko');
    avatar.style.backgroundColor = connectionColors[commands.indexOf(item) % connectionColors.length];
    const details = document.createElement('span');
    details.className = 'terminal-command-details';
    const name = document.createElement('span');
    name.className = 'terminal-command-name';
    name.textContent = item.name;
    const categoryLabel = document.createElement('small');
    categoryLabel.className = 'terminal-command-category';
    const kind = /^(?:ssh|ssh\.exe)\s/iu.test(item.command.trimStart()) ? 'SSH' : '명령어';
    categoryLabel.textContent = item.category ? item.category + ' · ' + kind : kind;
    details.append(name, categoryLabel);
    insert.append(avatar, details);
    insert.title = item.command;
    insert.disabled = !activeTab?.ready;
    insert.addEventListener('click', () => {
      commandsPanel.hidePopover();
      activeTab.terminal.focus();
      activeTab.terminal.paste(item.command);
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.title = item.name + ' 편집';
    edit.setAttribute('aria-label', edit.title);
    edit.append(icon('pencil', '#a9b9d3'));
    edit.addEventListener('click', () => openEditor(item));
    const arrow = document.createElement('span');
    arrow.className = 'terminal-chevron terminal-command-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    row.append(insert, edit, arrow);
    return row;
  }));
}

function openEditor(item) {
  editing = item;
  document.querySelector('#terminal-command-title').textContent = item ? '명령어 편집' : '명령어 추가';
  form.elements.name.value = item?.name ?? '';
  form.elements.category.value = item?.category ?? (commandCategory === '\u0000' ? '' : commandCategory);
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

document.querySelector('#terminal-home').addEventListener('click', () => {
  void api.home().catch(error => showError(status, error.message));
});

function activateTab(tab, focusTab = false) {
  if (activeTab) {
    activeTab.pane.hidden = true;
    activeTab.button.setAttribute('aria-selected', 'false');
    activeTab.button.tabIndex = -1;
  }
  activeTab = tab;
  tab.pane.hidden = false;
  tab.button.setAttribute('aria-selected', 'true');
  tab.button.tabIndex = 0;
  tab.button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  showError(status, tab.error);
  tab.fit.fit();
  drawCommands();
  if (focusTab) tab.button.focus();
  else tab.terminal.focus();
}

async function removeTab(tab) {
  const order = [...tabs.values()];
  const index = order.indexOf(tab);
  tabs.delete(tab.id);
  if (activeTab === tab) activateTab(order[index - 1] ?? order[index + 1]);
  tab.terminal.dispose();
  tab.pane.remove();
  tab.button.parentElement.remove();
  addTab.disabled = false;
  await api.closeTab(tab.id).catch(error => showError(status, error.message));
}

async function openTab() {
  if (tabs.size >= tabLimit) return;
  const id = nextTabId++;
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';
  pane.id = 'terminal-pane-' + id;
  pane.setAttribute('role', 'tabpanel');
  pane.setAttribute('aria-labelledby', 'terminal-tab-' + id);
  pane.hidden = true;
  const frame = document.createElement('div');
  frame.className = 'terminal-tab';
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'terminal-tab-' + id;
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', pane.id);
  button.textContent = '창 ' + id;
  frame.append(button);
  if (id !== 1) {
    const closeTab = document.createElement('button');
    closeTab.type = 'button';
    closeTab.className = 'terminal-tab-close';
    closeTab.textContent = '×';
    closeTab.setAttribute('aria-label', button.textContent + ' 닫기');
    frame.append(closeTab);
    closeTab.addEventListener('click', () => void removeTab(tab));
  }
  const terminal = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "D2Coding", monospace',
    fontSize: 15, lineHeight: 1.65, cursorBlink: true,
    theme: { background: '#090b0f', foreground: '#f2f4f8', cursor: '#8ab4ff' }
  });
  const fit = new FitAddon();
  const tab = { id, pane, button, terminal, fit, ready: false };
  tabs.set(id, tab);
  addTab.disabled = tabs.size >= tabLimit;
  body.append(pane);
  tabList.append(frame);
  button.addEventListener('click', () => activateTab(tab));
  terminal.loadAddon(fit);
  terminal.open(pane);
  terminal.onData(data => { if (tab.ready) void api.write(id, data).catch(() => {}); });
  terminal.onResize(({ cols, rows }) => { if (tab.ready) void api.resize(id, cols, rows).catch(() => {}); });
  activateTab(tab);
  try {
    const { cols, rows } = terminal;
    await api.start(id, cols, rows);
    if (!tabs.has(id) || tab.error) return;
    tab.ready = true;
    if (cols !== terminal.cols || rows !== terminal.rows) void api.resize(id, terminal.cols, terminal.rows).catch(() => {});
    if (activeTab === tab) drawCommands();
  } catch (error) {
    tab.error = error.message;
    if (tabs.has(id) && activeTab === tab) showError(status, tab.error);
  }
}

addTab.addEventListener('click', () => void openTab());
tabList.addEventListener('keydown', event => {
  if (event.target.getAttribute('role') !== 'tab') return;
  const order = [...tabs.values()];
  const index = order.indexOf(activeTab);
  const targets = { ArrowLeft: (index + order.length - 1) % order.length,
    ArrowRight: (index + 1) % order.length, Home: 0, End: order.length - 1 };
  if (!Object.hasOwn(targets, event.key)) return;
  event.preventDefault();
  activateTab(order[targets[event.key]], true);
});
api.onData(({ id, data, exitCode }) => {
  const tab = tabs.get(id);
  if (!tab) return;
  if (typeof data === 'string') {
    tab.terminal.write(data);
    return;
  }
  tab.ready = false;
  tab.error = '터미널이 종료됐습니다. (' + exitCode + ')';
  tab.button.dataset.ended = '';
  if (activeTab === tab) {
    drawCommands();
    showError(status, tab.error);
  }
});
new ResizeObserver(() => activeTab?.fit.fit()).observe(body);
void api.commands().then(items => {
  commands = items;
  add.disabled = false;
  drawCommands();
}).catch(error => showError(listError, error.message));
void openTab();
