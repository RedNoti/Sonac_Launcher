'use strict';

const api = window.launcher;
const $ = id => document.getElementById(id);
const elements = (id) => $(id).elements;
const groups = [
  { id: 'synology', title: 'SYNOLOGY', tiles: [['dsm', '파일 스테이션']] },
  { id: 'files', title: '파일 관리', tiles: [['downloads', '다운로드'], ['sync', '백업 · 동기화']] },
  { id: 'git', title: 'GIT', tiles: [['github', 'GitHub'], ['terminal', '터미널']] }
];
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let state;
let tileSignature = '';
let toastTimer;
let browserPath = '/';
let browserMode = null;
let browserTrigger;
let pickerDialog = 'settings-dialog';
let browserFolders = {};
let browserView = 'grid';
let browserEntries = [];
let selected = new Set();
let selectionAnchor = null;
let previewJob;
let menuTrigger;
let browseGeneration = 0;
let transferring = false;
let loadingFolder = false;
let filledSavedPassword = false;
let updateRequested = false;

function make(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, callback, className) {
  const node = make('button', text, className);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

function notice(id, message = '', error = false) {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle('bad', error);
}

function toast(message) {
  notice('toast', message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => notice('toast'), 4200);
}

function busy(node, action, report = error => toast(error.message)) {
  return async () => {
    if (node.disabled) return;
    node.disabled = true;
    try {
      await action();
    } catch (error) {
      report(error);
    } finally {
      node.disabled = false;
    }
  };
}

function setProvider() {
  const form = elements('login-form');
  const dsm = form.provider.value === 'synology';
  $('address-label').firstChild.nodeValue = dsm ? 'DSM HTTPS 주소 ' : 'WebDAV HTTPS 주소 ';
  form.url.placeholder = dsm ? 'https://nas.example.com:5001' : 'https://cloud.example.com/remote.php/dav/files/사용자/';
  $('otp-details').hidden = !dsm;
}

function showPage() {
  $('signin').hidden = state.connected;
  $('home').hidden = !state.connected || !!browserMode || githubOpen;
  $('github-page').hidden = !state.connected || !!browserMode || !githubOpen;
  $('browser').hidden = !state.connected || !browserMode;
}

function clearSavedPassword() {
  if (filledSavedPassword) elements('login-form').password.value = '';
  filledSavedPassword = false;
}

async function fillSavedPassword() {
  const form = elements('login-form');
  const { profile } = state;
  const canFill = () => state.hasRememberedLogin && !state.connected && !state.connecting &&
    form.remember.checked && !form.password.value && profile &&
    profile.provider === form.provider.value && profile.url === form.url.value && profile.user === form.user.value;
  if (!canFill()) return;
  const password = await api.savedPassword(profile).catch(() => '');
  if (password && canFill()) {
    form.password.value = password;
    filledSavedPassword = true;
  }
}

function drawUpdate() {
  const update = state.update;
  const action = $('update-now');
  const downloading = update?.phase === 'downloading';
  const ready = update?.phase === 'ready';
  action.hidden = !update?.version;
  action.disabled = updateRequested || downloading;
  action.title = downloading ? update.version + ' 업데이트 다운로드 중…' :
    ready ? update.version + ' 업데이트 적용 및 다시 시작' :
      update?.version ? update.version + ' 업데이트 다운로드 및 적용' : '업데이트 다운로드 및 적용';
  action.setAttribute('aria-label', action.title);
  notice('update-status', update?.phase === 'error' ? '업데이트 목록을 확인할 수 없습니다.' : '', true);
}

function apply(next) {
  const previous = state;
  state = next;
  if (!state.connected && browserMode) resetBrowser();
  showPage();
  workspaceChanged(previous);
  drawUpdate();
  if (state.update?.phase === 'downloading' && previous?.update?.phase !== 'downloading') {
    toast(state.update.version + ' 업데이트를 다운로드하는 중입니다.');
  }
  if (!state.connected) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    if (!previous || previous.connected) {
      const form = elements('login-form');
      form.provider.value = state.profile?.provider || 'synology';
      form.url.value = state.profile?.url || '';
      form.user.value = state.profile?.user || '';
      form.password.value = '';
      form.otp.value = '';
      form.remember.checked = state.hasRememberedLogin;
      filledSavedPassword = false;
      setProvider();
    }
    $('login-button').disabled = state.connecting;
    $('login-button').textContent = state.connecting ? '연결 중…' : '로그인';
    if (state.loginError) notice('login-error', state.loginError);
    if (!previous || previous.connected || previous.connecting) void fillSavedPassword();
    return;
  }
  clearSavedPassword();
  const signature = state.profile.provider;
  if (signature !== tileSignature) {
    drawTiles();
    tileSignature = signature;
  }
  const { settings, sync } = state;
  const last = sync || settings.last;
  const configured = !!settings.local && !!settings.remote;
  $('sync-now').disabled = !!(sync?.running || sync?.checking);
  const status = !configured ? '폴더 지정 필요' : sync?.running ? '동기화 중' : sync?.checking ? '확인 중' :
    last?.errors ? '동기화 오류' : last?.pending ? '업데이트 있음' : last?.checkedAt ? '완료' : '확인 중';
  $('sync-status').textContent = status;
  $('sync-status').title = last?.errors ? last.message : last?.checkedAt ? shortDate.format(last.checkedAt) : '';
  $('sync-dot').className = 'dot' + (sync?.running || sync?.checking ? ' active' :
    last?.errors || last?.pending ? ' warn' : last?.checkedAt ? ' good' : '');
}

function tile(label, type, action) {
  const item = button('', action, 'tile');
  item.title = label;
  const badge = make('span', '', 'icon ' + type);
  badge.append(icon(type));
  item.append(badge, make('span', label, 'tile-label'));
  return item;
}

async function activate(id) {
  try {
    if (id === 'dsm') return openBrowser('remote');
    if (id === 'downloads') return openBrowser('local');
    if (id === 'sync') return openSettings();
    if (id === 'terminal') return await showTerminal();
    if (id === 'github') return openGithub();
  } catch (error) {
    toast(error.message);
  }
}

function drawTiles() {
  const container = $('groups');
  container.replaceChildren();
  for (const group of groups) {
    const panel = make('section', '', 'panel');
    const webdav = state.profile.provider === 'webdav';
    const heading = make('h2', group.id === 'synology' && webdav ? '저장소' : group.title);
    heading.id = 'group-' + group.id;
    panel.setAttribute('aria-labelledby', heading.id);
    const grid = make('div', '', 'tiles');
    for (const [id, label] of group.tiles) {
      grid.append(tile(id === 'dsm' && webdav ? '클라우드 파일' : label, id, () => activate(id)));
    }
    panel.append(heading, grid);
    container.append(panel);
  }
}

function openSettings() {
  const { settings } = state;
  const form = elements('settings-form');
  form.remote.value = settings.remote;
  form.local.value = settings.local;
  form.interval.value = String(settings.interval);
  form.automatic.checked = settings.automatic;
  form.launchAtLogin.checked = state.launchAtLogin;
  notice('settings-error');
  $('settings-dialog').showModal();
}

async function showTerminal() {
  const dialog = $('terminal-dialog');
  notice('terminal-status', '터미널을 연결하는 중…');
  dialog.showModal();
  const { openTerminal } = await import('./terminal-ui.mjs');
  if (!dialog.open) return;
  try {
    await openTerminal(api, dialog, $('terminal-body'), message => notice('terminal-status', message));
    if ($('terminal-status').textContent === '터미널을 연결하는 중…') notice('terminal-status');
  } catch (error) {
    if (dialog.open) notice('terminal-status', error.message, true);
  }
}

function parentOf(path) {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function browseButtons() {
  const noShare = browserPath === '/' && state.profile.provider === 'synology';
  $('up-button').disabled = browserPath === '/' || transferring;
  $('refresh-button').disabled = loadingFolder || transferring;
  $('upload-button').hidden = browserMode !== 'remote';
  $('upload-button').disabled = noShare || loadingFolder || transferring;
  $('pick-button').hidden = browserMode !== 'picker';
  $('pick-button').disabled = noShare || loadingFolder || transferring;
  $('browser-remote').disabled = transferring;
  $('browser-local').disabled = transferring;
  updateSelection();
}

function breadcrumb() {
  const crumbs = $('breadcrumbs');
  crumbs.replaceChildren();
  const rootName = browserMode === 'local' ? '다운로드' : state.profile.provider === 'synology' ? '공유 폴더' : '클라우드';
  crumbs.append(button(rootName, () => loadFolder('/')));
  let folder = '';
  for (const name of browserPath.split('/').slice(1).filter(Boolean)) {
    folder += '/' + name;
    const target = folder;
    crumbs.append(make('span', '/'), button(name, () => loadFolder(target)));
  }
  crumbs.lastChild.setAttribute('aria-current', 'location');
  crumbs.scrollLeft = crumbs.scrollWidth;
}

function bytes(size) {
  if (!Number.isFinite(size)) return '–';
  if (size < 1024) return size + ' B';
  const unit = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return (size / 1024 ** unit).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}

function selectedFiles() {
  return browserEntries.filter(file => selected.has(file.path));
}

function setSelectionIcon(action, label, glyph) {
  action.title = label;
  action.setAttribute('aria-label', label);
  if (action.dataset.glyph === glyph && action.firstChild) return;
  action.dataset.glyph = glyph;
  action.replaceChildren(icon(glyph, action.classList.contains('danger') ? '#ffb2ab' : '#a9c6f8'));
}

function updateSelection() {
  const files = selectedFiles();
  const single = files.length === 1;
  $('selection-bar').hidden = !files.length || browserMode === 'picker' || !browserMode;
  $('selection-count').textContent = files.length.toLocaleString('ko-KR') + '개 선택';
  $('open-selection').hidden = !single;
  const folder = single && files[0].directory;
  setSelectionIcon($('open-selection'), folder ? '폴더 열기' : '미리보기', folder ? 'files' : 'eye');
  $('download-selection').hidden = browserMode !== 'remote';
  $('delete-selection').hidden = browserMode === 'remote' && browserPath === '/' && state.profile.provider === 'synology';
  for (const id of ['open-selection', 'download-selection', 'delete-selection']) $(id).disabled = transferring || loadingFolder;
  for (const item of $('browser-results').querySelectorAll('[data-file-path]')) {
    const active = selected.has(item.dataset.filePath);
    item.setAttribute('aria-pressed', String(active));
    item.closest('.file-card, tr').classList.toggle('selected', active);
  }
}

function clearSelection() {
  selected.clear();
  selectionAnchor = null;
  updateSelection();
}

function chooseFile(file, event) {
  if (transferring) return;
  if (browserMode === 'picker') {
    if (file.directory) void loadFolder(file.path);
    return;
  }
  if (event.shiftKey && selectionAnchor) {
    const first = browserEntries.findIndex(entry => entry.path === selectionAnchor);
    const last = browserEntries.indexOf(file);
    selected = new Set(browserEntries.slice(Math.min(first, last), Math.max(first, last) + 1).map(entry => entry.path));
  } else {
    if (event.metaKey || event.ctrlKey) {
      if (selected.has(file.path)) selected.delete(file.path);
      else selected.add(file.path);
    } else {
      selected = new Set([file.path]);
    }
    selectionAnchor = file.path;
  }
  updateSelection();
}

function closeFileMenu(restoreFocus = false) {
  const menu = $('file-actions-menu');
  if (menu.hidden) return;
  const trigger = menuTrigger;
  menuTrigger = null;
  menu.hidden = true;
  menu.replaceChildren();
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openFileMenu(trigger, x, y) {
  if (!browserMode || browserMode === 'picker' || transferring || loadingFolder) return;
  const file = browserEntries.find(entry => entry.path === trigger.dataset.filePath);
  if (!file) return;
  closeFileMenu();
  if (!selected.has(file.path)) chooseFile(file, {});
  const menu = $('file-actions-menu');
  const actions = [...$('selection-bar').querySelectorAll('button')].filter(action => !action.hidden && !action.disabled);
  for (const action of actions) {
    const danger = action.classList.contains('danger');
    const item = button('', () => {
      closeFileMenu(true);
      action.click();
    }, danger ? 'danger' : '');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.append(icon(action.dataset.glyph, danger ? '#ffb2ab' : '#a9c6f8'), make('span', action.getAttribute('aria-label')));
    menu.append(item);
  }
  menuTrigger = trigger;
  menu.hidden = false;
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.firstElementChild?.focus({ preventScroll: true });
}

async function openEntry(file) {
  if (!file || transferring || loadingFolder) return;
  if (file.directory) return loadFolder(file.path);
  if (previewJob || browserMode === 'picker') return;
  const job = { id: crypto.randomUUID(), controller: new AbortController() };
  previewJob = job;
  $('preview-title').textContent = file.name;
  $('preview-body').replaceChildren();
  $('preview-controls').replaceChildren();
  notice('preview-status', '미리보기를 준비하는 중…');
  $('preview-dialog').showModal();
  $('preview-title').focus({ preventScroll: true });
  const signal = job.controller.signal;
  try {
    const preview = await api.preview(job.id, browserMode, browserPath, file.path);
    if (signal.aborted) {
      void api.closePreview(job.id).catch(() => {});
      return;
    }
    const { renderPreview } = await import('./preview-ui.mjs');
    signal.throwIfAborted();
    notice('preview-status');
    await renderPreview(preview, file.name, $('preview-body'), $('preview-controls'),
      message => notice('preview-status', message, true), signal);
  } catch (error) {
    if (!signal.aborted) notice('preview-status', error.message, true);
  }
}

function fileIcon(file) {
  if (file.directory) return 'files';
  const extension = file.name.split('.').at(-1).toLowerCase();
  if (/^(?:png|jpe?g|gif|webp|bmp|avif|ico|heic|tiff?)$/u.test(extension)) return 'image';
  if (/^(?:mp3|wav|flac|m4a|aac|ogg|oga|opus)$/u.test(extension)) return 'audio';
  if (/^(?:mp4|m4v|webm|mov|mkv)$/u.test(extension)) return 'video';
  return 'file';
}

function fileLabel(file, className) {
  const label = button('', event => chooseFile(file, event), className);
  label.title = file.name;
  if (browserMode !== 'picker') {
    label.dataset.filePath = file.path;
    label.addEventListener('dblclick', event => {
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey) void openEntry(file);
    });
    label.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void openEntry(file);
      }
    });
  }
  label.append(icon(fileIcon(file), '#a9c6f8'), make('span', file.name));
  return label;
}

function fileRow(file) {
  const row = make('tr');
  const nameCell = make('td');
  nameCell.append(fileLabel(file, 'file-name'));
  row.append(nameCell, make('td', file.directory ? '–' : bytes(file.size)),
    make('td', file.modified ? shortDate.format(file.modified) : '–'));
  row.addEventListener('click', event => {
    if (!event.target.closest('button')) chooseFile(file, event);
  });
  row.addEventListener('dblclick', event => {
    if (!event.target.closest('button') && !event.metaKey && !event.ctrlKey && !event.shiftKey) void openEntry(file);
  });
  return row;
}

function fileCard(file) {
  const card = make('li', '', 'file-card');
  card.append(fileLabel(file, 'file-card-item'));
  return card;
}

function renderFiles() {
  closeFileMenu();
  const grid = browserView === 'grid';
  $('file-table').hidden = grid;
  $('file-grid').hidden = !grid;
  $('file-list').replaceChildren();
  $('file-grid').replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const file of browserEntries) fragment.append(grid ? fileCard(file) : fileRow(file));
  $(grid ? 'file-grid' : 'file-list').append(fragment);
  updateSelection();
}

function drawFiles(list) {
  browserEntries = list.filter(file => browserMode === 'local' ||
    (file.name !== 'sonac-launcher.config.json' && (browserMode !== 'picker' || file.directory)));
  browserEntries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  $('browser-count').textContent = browserEntries.length.toLocaleString('ko-KR') + '개 항목';
  const empty = browserMode === 'picker' ? '하위 폴더가 없습니다.' : '폴더가 비어 있습니다.';
  notice('browser-empty', browserEntries.length ? '' : empty);
  renderFiles();
}

async function loadFolder(path) {
  if (transferring || !browserMode || !state.connected) return;
  const generation = ++browseGeneration;
  const focusPath = $('browser-results').contains(document.activeElement) || $('breadcrumbs').contains(document.activeElement);
  browserPath = path;
  browserFolders[browserMode] = path;
  loadingFolder = true;
  selected.clear();
  selectionAnchor = null;
  breadcrumb();
  if (focusPath) $('breadcrumbs').lastElementChild.focus();
  browseButtons();
  notice('browser-status');
  $('browser-results').setAttribute('aria-busy', 'true');
  $('browser-results').scrollTop = 0;
  $('browser-count').textContent = '';
  browserEntries = [];
  notice('browser-empty', '폴더를 불러오는 중…');
  renderFiles();
  try {
    if (browserMode === 'local') {
      const { root, entries } = await api.listLocal(path);
      if (generation !== browseGeneration) return;
      $('browser-label').textContent = root;
      drawFiles(entries);
    } else {
      const entries = await api.list(path);
      if (generation === browseGeneration) drawFiles(entries);
    }
  } catch (error) {
    if (generation !== browseGeneration) return;
    notice('browser-empty', '파일 목록을 열 수 없습니다.');
    notice('browser-status', error.message, true);
  } finally {
    if (generation === browseGeneration && state.connected) {
      loadingFolder = false;
      $('browser-results').removeAttribute('aria-busy');
      browseButtons();
    }
  }
}

function openBrowser(mode, path = browserFolders[mode] || (mode === 'remote' && state.settings.remote) || '/',
  fromDialog = 'settings-dialog') {
  if (transferring) return toast('파일 전송이 끝난 뒤 다시 열어 주세요.');
  if (!browserMode) browserTrigger = document.activeElement;
  if (mode === 'picker') {
    pickerDialog = fromDialog;
    $(pickerDialog).close();
  }
  browserMode = mode;
  const remoteTitle = state.profile.provider === 'synology' ? '파일 스테이션' : '클라우드 파일';
  $('browser-title').textContent = { local: '다운로드', picker: '동기화 폴더 선택', remote: remoteTitle }[mode];
  $('browser-label').textContent = mode === 'local' ? '' : new URL(state.profile.url).host;
  $('browser-home-label').textContent = mode === 'picker' ? '설정으로 돌아가기' : '홈';
  $('browser-remote-label').textContent = remoteTitle;
  $('browser-remote').hidden = mode === 'picker';
  $('browser-local').hidden = mode === 'picker';
  for (const location of ['remote', 'local']) {
    const item = $('browser-' + location);
    if (mode === location) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  showPage();
  $('browser-title').focus();
  void loadFolder(path);
}

function resetBrowser() {
  closeFileMenu();
  browseGeneration++;
  browserMode = null;
  browserTrigger = null;
  browserFolders = {};
  browserEntries = [];
  selected.clear();
  selectionAnchor = null;
}

function leaveBrowser() {
  const picker = browserMode === 'picker';
  const trigger = browserTrigger;
  resetBrowser();
  showPage();
  if (picker) $(pickerDialog).showModal();
  if (trigger?.isConnected) trigger.focus();
}

async function transfer(action, progress = '파일 전송 중…') {
  if (transferring || loadingFolder) return;
  transferring = true;
  browseButtons();
  notice('browser-status', progress);
  try {
    await action();
    if ($('browser-status').textContent === progress) notice('browser-status');
  } catch (error) {
    if (browserMode) notice('browser-status', error.message, true);
    else toast(error.message);
  } finally {
    transferring = false;
    if (state.connected) browseButtons();
  }
}

function openEditor() {
  $('editor-description').textContent = state.settings.remote
    ? '같은 클라우드 폴더를 사용하는 PC에 GitHub 주소가 동기화됩니다.'
    : '';
  elements('editor-form').github.value = state.settings.layout.links.github || '';
  notice('editor-error');
  $('editor').showModal();
}

document.body.dataset.platform = api.platform;
$('sync-now').append(icon('sync', '#cbd8ef'));
$('update-now').append(icon('downloads', '#4ade80'));
$('edit-button').append(icon('pencil', '#cbd8ef'));
$('account-button').append(icon('account', '#cbd8ef'));
for (const action of $('selection-bar').querySelectorAll('button')) {
  setSelectionIcon(action, action.getAttribute('aria-label'), action.dataset.glyph);
}
for (const [id, glyph] of [['browser-home', 'home'], ['browser-remote', 'dsm'], ['browser-local', 'downloads'],
  ['up-button', 'up'], ['refresh-button', 'sync'], ['grid-view', 'grid'], ['list-view', 'list']]) {
  $(id).prepend(icon(glyph, '#a9c6f8'));
}
for (const item of document.querySelectorAll('[data-close]')) {
  item.addEventListener('click', () => $(item.dataset.close).close());
}
const login = elements('login-form');
login.provider.addEventListener('change', () => {
  clearSavedPassword();
  setProvider();
});
login.url.addEventListener('input', clearSavedPassword);
login.user.addEventListener('input', clearSavedPassword);
login.password.addEventListener('input', () => { filledSavedPassword = false; });
login.remember.addEventListener('change', () => {
  if (login.remember.checked && state) void fillSavedPassword();
  else clearSavedPassword();
});
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = elements('login-form');
  notice('login-error');
  try {
    apply(await api.login({
      provider: form.provider.value, url: form.url.value, user: form.user.value,
      password: form.password.value, otp: form.provider.value === 'synology' ? form.otp.value : '', remember: form.remember.checked
    }));
    form.password.value = '';
    form.otp.value = '';
  } catch (error) {
    notice('login-error', error.message);
    if (/\(DSM 40[34]\)/u.test(error.message)) {
      $('otp-details').open = true;
      form.otp.focus();
    }
  }
});
$('sync-now').addEventListener('click', async () => {
  if (!state.settings.remote || !state.settings.local) return openSettings();
  try { await api.sync(); } catch (error) { toast(error.message); }
});
$('edit-button').addEventListener('click', () => openEditor());
$('account-button').addEventListener('click', () => {
  $('account-server').textContent = state.profile.url;
  $('account-user').textContent = state.profile.user;
  $('account-device').textContent = state.device;
  notice('account-error');
  $('account').showModal();
});
$('account-settings').addEventListener('click', () => {
  $('account').close();
  openSettings();
});
$('logout-button').addEventListener('click', busy($('logout-button'), async () => {
  await api.logout();
}, error => notice('account-error', error.message, true)));
$('update-now').addEventListener('click', async () => {
  if (updateRequested) return;
  updateRequested = true;
  drawUpdate();
  try {
    await api.installUpdate();
  } catch (error) {
    toast(error.message);
  } finally {
    updateRequested = false;
    drawUpdate();
  }
});

$('pick-remote').addEventListener('click', () => openBrowser('picker', elements('settings-form').remote.value || '/'));
$('pick-local').addEventListener('click', busy($('pick-local'), async () => {
  const path = await api.chooseLocal();
  if (path) elements('settings-form').local.value = path;
}, error => notice('settings-error', error.message, true)));
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    notice('settings-error');
    const form = elements('settings-form');
    if (!form.remote.value || !form.local.value) throw new Error('클라우드 폴더와 이 PC의 폴더를 선택하세요.');
    apply(await api.settings({
      remote: form.remote.value, local: form.local.value, interval: form.interval.value,
      automatic: form.automatic.checked, launchAtLogin: form.launchAtLogin.checked
    }));
    $('settings-dialog').close();
    toast('동기화 설정을 저장했습니다.');
  }, error => notice('settings-error', error.message, true))();
});
$('browser-home').addEventListener('click', leaveBrowser);
$('browser-remote').addEventListener('click', () => { if (browserMode !== 'remote') openBrowser('remote'); });
$('browser-local').addEventListener('click', () => { if (browserMode !== 'local') openBrowser('local'); });
$('browser-results').addEventListener('contextmenu', event => {
  const trigger = event.target.closest('[data-file-path]') ||
    event.target.closest('tr, .file-card')?.querySelector('[data-file-path]');
  if (!trigger) return;
  event.preventDefault();
  openFileMenu(trigger, event.clientX, event.clientY);
});
document.addEventListener('pointerdown', event => {
  if (!$('file-actions-menu').contains(event.target)) closeFileMenu();
});
$('browser-results').addEventListener('scroll', () => closeFileMenu());
window.addEventListener('resize', () => closeFileMenu());
$('file-actions-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    closeFileMenu(true);
    return;
  }
  const items = [...$('file-actions-menu').children];
  const index = items.indexOf(document.activeElement);
  let target;
  if (event.key === 'ArrowDown') target = (index + 1) % items.length;
  else if (event.key === 'ArrowUp') target = (index + items.length - 1) % items.length;
  else if (event.key === 'Home') target = 0;
  else if (event.key === 'End') target = items.length - 1;
  if (target === undefined) return;
  event.preventDefault();
  items[target]?.focus();
});
for (const view of ['grid', 'list']) {
  $(view + '-view').addEventListener('click', () => {
    if (browserView === view) return;
    browserView = view;
    $('grid-view').setAttribute('aria-pressed', String(view === 'grid'));
    $('list-view').setAttribute('aria-pressed', String(view === 'list'));
    $('browser-results').scrollTop = 0;
    renderFiles();
  });
}
$('preview-dialog').addEventListener('close', () => {
  const job = previewJob;
  previewJob = null;
  job?.controller.abort();
  if (job) void api.closePreview(job.id).catch(() => {});
  $('preview-body').replaceChildren();
  $('preview-controls').replaceChildren();
});
$('clear-selection').addEventListener('click', clearSelection);
$('open-selection').addEventListener('click', () => { void openEntry(selectedFiles()[0]); });
$('download-selection').addEventListener('click', () => {
  const items = selectedFiles().map(file => file.path);
  void transfer(async () => {
    const result = await api.download(browserPath, items);
    if (!result) return;
    const message = `다운로드 ${result.downloaded}개` +
      (result.skipped ? ` · 기존 파일 ${result.skipped}개` : '') +
      (result.errors ? ` · 실패 ${result.errors}개 · ${result.message}` : '');
    if (browserMode) notice('browser-status', message, !!result.errors);
    else toast(message);
  });
});
$('delete-selection').addEventListener('click', () => {
  const mode = browserMode;
  const folder = browserPath;
  const items = selectedFiles().map(file => file.path);
  let result;
  void transfer(async () => { result = await api.delete(mode, folder, items); }, '삭제 중…').then(async () => {
    if (!result) return;
    const message = `삭제 완료 ${result.deleted}개` +
      (result.errors.length ? ` · 실패 ${result.errors.length}개 · ${result.errors[0]}` : '');
    if (browserMode === mode && browserPath === folder) {
      const pending = loadFolder(folder);
      const generation = browseGeneration;
      await pending;
      if (generation === browseGeneration) notice('browser-status', message, !!result.errors.length);
    } else {
      toast(message);
    }
  });
});
document.addEventListener('keydown', event => {
  if (!browserMode || event.defaultPrevented) return;
  const control = event.target instanceof Element
    ? event.target.closest('button, input, select, textarea, audio, video, [contenteditable]') : null;
  const space = event.key === ' ' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
  if ($('preview-dialog').open) {
    if (space && !control) {
      event.preventDefault();
      if (!event.repeat) $('preview-dialog').close();
    }
    return;
  }
  if (document.querySelector('dialog[open]') || !$('file-actions-menu').hidden) return;
  if (control?.matches('[data-file-path]') && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
    event.preventDefault();
    const bounds = control.getBoundingClientRect();
    openFileMenu(control, bounds.left + 12, bounds.bottom);
    return;
  }
  if (space && browserMode !== 'picker' && selected.size && (!control || control.matches('[data-file-path]'))) {
    event.preventDefault();
    const files = selectedFiles();
    if (!event.repeat && files.length === 1 && !files[0].directory) void openEntry(files[0]);
    return;
  }
  if (event.key === 'Escape' && browserMode === 'picker') {
    event.preventDefault();
    leaveBrowser();
  } else if (browserMode !== 'picker' && event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    selected = new Set(browserEntries.map(entry => entry.path));
    updateSelection();
  } else if (event.key === 'Escape' && selected.size) {
    event.preventDefault();
    clearSelection();
  } else if (event.key === 'Delete' && selected.size && !$('delete-selection').hidden && !$('delete-selection').disabled) {
    event.preventDefault();
    $('delete-selection').click();
  }
});
$('up-button').addEventListener('click', () => loadFolder(parentOf(browserPath)));
$('refresh-button').addEventListener('click', () => loadFolder(browserPath));
$('pick-button').addEventListener('click', () => {
  elements(pickerDialog === 'area-dialog' ? 'area-form' : 'settings-form').remote.value = browserPath;
  leaveBrowser();
});
$('upload-button').addEventListener('click', () => {
  let result;
  const folder = browserPath;
  void transfer(async () => { result = await api.upload(folder); }).then(async () => {
    if (result && browserMode === 'remote' && browserPath === folder) {
      const pending = loadFolder(folder);
      const generation = browseGeneration;
      await pending;
      if (generation !== browseGeneration) return;
      const message = `업로드 완료 ${result.uploaded}개` +
        (result.errors.length ? ` · 실패 ${result.errors.length}개 · ${result.errors[0]}` : '');
      notice('browser-status', message, !!result.errors.length);
    } else if (result) {
      toast(result.errors.length ? result.errors[0] : `${result.uploaded}개 파일을 업로드했습니다.`);
    }
  });
});
$('editor-form').addEventListener('submit', event => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    notice('editor-error');
    const { links, shortcuts } = state.settings.layout;
    apply(await api.layout({
      version: 1, links: { ...links, github: elements('editor-form').github.value.trim() }, shortcuts
    }));
    $('editor').close();
    toast('런처 구성을 저장했습니다.');
  }, error => notice('editor-error', error.message, true))();
});

initWorkspace();
api.onState(apply);
api.state().then(apply).catch(error => notice('login-error', error.message));
