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
let loginPending = false;
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
let updateRequested = false;
let signinCurrentTimer;

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

let loginMode = 'register';
let selectedNas;

function showOtp(visible) {
  const form = elements('login-form');
  $('otp-label').hidden = !visible;
  form.otp.disabled = !visible;
  form.otp.required = visible;
  if (!visible) form.otp.value = '';
}

function selectNas(profile, { mode = profile ? 'login' : 'register', focus = false } = {}) {
  loginMode = mode;
  selectedNas = profile;
  const form = elements('login-form');
  const configuring = mode === 'register' || mode === 'edit';
  const server = mode === 'server';
  form.name.value = profile?.name || '';
  form.url.value = profile?.url || '';
  form.user.value = profile?.user || '';
  form.password.value = '';
  form.pin.value = profile?.pin || '';
  form.remember.checked = !!profile?.saved;
  form.user.disabled = form.password.disabled = server;
  form.user.readOnly = mode === 'login';
  form.name.disabled = form.url.disabled = form.pin.disabled = !configuring;
  $('nas-name-label').hidden = $('address-label').hidden = $('pin-details').hidden = !configuring;
  $('pin-details').open = configuring && !!form.pin.value;
  $('remember-label').hidden = server;
  $('nas-edit').hidden = !profile;
  $('nas-edit').setAttribute('aria-label', mode === 'edit' ? '수정 취소' : 'NAS 연결 수정');
  $('nas-edit').title = $('nas-edit').getAttribute('aria-label');
  $('login-title').textContent = server ? '서버 업데이터 로그인' :
    mode === 'edit' ? 'NAS 연결 수정' : profile ? profile.name || new URL(profile.url).host : 'Synology NAS 등록';
  $('signin-intro').textContent = server ? '전용 인증 서비스 연결을 기다리고 있습니다.' :
    mode === 'register' ? '연결 이름과 DSM 주소를 등록하세요.' : '';
  $('signin-intro').hidden = !$('signin-intro').textContent;
  showOtp(false);
  drawNasProfiles();
  savedLoginHint();
  drawLoginButton();
  if (focus && !server) (configuring ? form.name : form.password).focus();
}

function drawLoginButton() {
  const button = $('login-button');
  const updating = updateRequested || state.applyingUpdate;
  button.disabled = loginPending || state.connecting || updating || loginMode === 'server';
  button.textContent = updating ? '업데이트 중…' : state.connecting ? '연결 중…' :
    loginMode === 'register' ? '등록하고 로그인' : loginMode === 'edit' ? '저장하고 로그인' : '로그인';
}

function drawNasProfiles() {
  const profiles = state.nasProfiles || [];
  const buttons = profiles.map(profile => {
    const label = profile.name || new URL(profile.url).host;
    const item = tile(label, 'dsm', () => { notice('login-error'); selectNas(profile, { focus: true }); });
    item.append(make('small', profile.user, 'work-meta'));
    item.setAttribute('aria-pressed', String(profile.id === selectedNas?.id));
    return item;
  });
  const add = tile(profiles.length ? '다른 Synology 추가' : 'Synology NAS 등록', 'add', () => {
    notice('login-error');
    selectNas(undefined, { focus: true });
  });
  add.setAttribute('aria-pressed', String(loginMode === 'register'));
  const server = tile('서버 업데이터', 'server-update', () => {
    notice('login-error');
    selectNas(undefined, { mode: 'server' });
  }, 'sync');
  server.setAttribute('aria-pressed', String(loginMode === 'server'));
  $('nas-profiles').replaceChildren(...buttons, add);
  $('signin-server').replaceChildren(server);
}

function showPage() {
  const signingIn = !state.connected && (loginPending || state.connecting);
  const loadingStatus = $('signin-loading-status');
  if (signingIn && loadingStatus.textContent !== '로그인 중…') loadingStatus.textContent = '로그인 중…';
  $('signin').hidden = state.connected;
  $('signin-update').inert = signingIn;
  $('signin-sources').inert = signingIn;
  $('nas-edit').disabled = signingIn;
  $('login-form').inert = signingIn;
  $('signin-loading').hidden = !signingIn;
  $('signin-version').hidden = state.connected || !state.versionLabel;
  $('home').hidden = !state.connected || !!browserMode || githubOpen || state.terminalOpen;
  $('github-page').hidden = !state.connected || !!browserMode || !githubOpen;
  $('browser').hidden = !state.connected || !browserMode;
}

function savedLoginHint() {
  const form = elements('login-form');
  const available = form.remember.checked && state?.nasProfiles?.some(profile =>
    profile.saved && profile.url === form.url.value && profile.user === form.user.value &&
    (profile.pin || '') === form.pin.value.trim());
  form.password.required = loginMode !== 'server' && !available;
  const usingSaved = !!available && !form.password.value;
  form.password.placeholder = usingSaved ? '••••••••••••' : '';
  form.password.toggleAttribute('data-saved', usingSaved);
  $('saved-password-hint').hidden = !usingSaved;
  if (usingSaved) form.password.setAttribute('aria-describedby', 'saved-password-hint');
  else form.password.removeAttribute('aria-describedby');
}

function showSigninCurrent() {
  clearTimeout(signinCurrentTimer);
  signinCurrentTimer = setTimeout(() => {
    signinCurrentTimer = undefined;
    drawUpdate();
  }, 5000);
  drawUpdate();
}

const updateBar = $('update-bar');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function hideLeavingUpdateBar() {
  if (updateBar.hasAttribute('data-leaving')) updateBar.hidden = true;
}
updateBar.addEventListener('animationend', event => {
  if (event.target === updateBar && event.animationName === 'update-out') hideLeavingUpdateBar();
});
reducedMotion.addEventListener('change', event => {
  if (event.matches) hideLeavingUpdateBar();
});

function drawUpdateBar(message, error, percent) {
  if (!message) {
    if (reducedMotion.matches) updateBar.hidden = true;
    else if (!updateBar.hidden) updateBar.dataset.leaving = '';
    return;
  }
  const downloading = Number.isFinite(percent);
  const status = $('update-message');
  if (status.textContent !== message) status.textContent = message;
  updateBar.classList.toggle('bad', error);
  updateBar.toggleAttribute('data-downloading', downloading);
  const progress = $('update-progress');
  const counter = $('update-percent');
  progress.hidden = counter.hidden = $('update-mark').hidden = !downloading;
  if (downloading) {
    progress.setAttribute('aria-valuenow', percent);
    progress.style.setProperty('--progress', percent / 100);
    counter.textContent = percent + '%';
  }
  updateBar.removeAttribute('data-leaving');
  updateBar.hidden = false;
}

function drawUpdate() {
  const update = state.update;
  const downloading = update?.phase === 'downloading';
  const ready = update?.phase === 'ready';
  const updating = updateRequested || state.applyingUpdate;
  const applying = ready && updating && !state.waitingForRestart;
  const tag = update?.tag || update?.version;
  const label = applying ? '업데이트 적용 중…' : downloading ? tag + ' 다운로드 중…' : ready ? '다시 시작할까요?' :
    tag ? tag + ' 다운로드' : '업데이트 다운로드';
  for (const id of ['update-now', 'signin-update-check', 'account-update-check']) {
    const button = $(id);
    const home = id === 'update-now';
    if (home) button.hidden = !tag;
    button.disabled = updating || downloading || update?.phase === 'checking' || state.connecting;
    button.title = tag ? label : '앱 업데이트 확인';
    button.setAttribute('aria-label', button.title);
    const tint = tag ? '#4ade80' : '#cbd8ef';
    const glyph = ready ? 'sync' : 'downloads';
    if (button.dataset.tint !== tint || button.dataset.glyph !== glyph) {
      button.replaceChildren(icon(glyph, tint));
      button.dataset.tint = tint;
      button.dataset.glyph = glyph;
    }
  }
  const errors = {
    connection: 'GitHub 릴리스에 연결할 수 없습니다.',
    signature: '업데이트 서명이나 릴리스 버전이 일치하지 않습니다.',
    rateLimit: 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 확인하세요.'
  };
  const messages = {
    checking: 'GitHub에서 업데이트를 확인하는 중입니다.',
    current: '이 채널에서 받을 수 있는 새 버전이 없습니다.',
    missing: 'GitHub 릴리스에 설치 파일 또는 서명 목록이 빠져 있습니다.',
    error: errors[update?.issue] || errors.connection,
    unsupported: '이 빌드는 GitHub 자동 업데이트를 지원하지 않습니다.'
  };
  const message = messages[update?.phase] || (tag ? update.phase === 'available' ? tag + ' 사용 가능' : label : '');
  const current = update?.phase === 'current';
  const error = ['missing', 'error'].includes(update?.phase);
  const percent = downloading ? update.percent ?? 0 : undefined;
  const accountMessage = current ? '' : downloading ? message + ' ' + percent + '%' : message;
  if ($('update-status').textContent !== accountMessage) notice('update-status', accountMessage, error);
  const signinNotice = !state.connected && !state.connecting && update?.phase !== 'checking' &&
    (!current || signinCurrentTimer) && !ready;
  drawUpdateBar(signinNotice || downloading ? message : '', error, percent);
  drawLoginButton();
}

function apply(next) {
  const previous = state;
  state = next;
  $('signin-version').textContent = state.versionLabel || '';
  if (state.connected) {
    clearTimeout(signinCurrentTimer);
    signinCurrentTimer = undefined;
  }
  if (!state.connected && browserMode) resetBrowser();
  showPage();
  if (previous?.terminalOpen && !state.terminalOpen && !$('home').hidden) {
    document.querySelector('.tile:has(.terminal)')?.focus();
  }
  workspaceChanged(previous);
  drawUpdate();
  if (!state.connected) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    if (!previous || previous.connected) {
      const profile = state.nasProfiles?.find(item => item.url === state.profile?.url && item.user === state.profile?.user);
      selectNas(profile);
    }
    if (state.loginError && loginMode !== 'server') {
      notice('login-error', state.loginError);
      if (/\(DSM 40[34]\)/u.test(state.loginError)) showOtp(true);
    }
    savedLoginHint();
    return;
  }
  const writes = $('account-writes');
  writes.title = state.settings.remoteWrites ? 'NAS 쓰기 끄기' : 'NAS 쓰기 허용';
  writes.setAttribute('aria-label', writes.title);
  writes.setAttribute('aria-pressed', String(state.settings.remoteWrites));
  if (browserMode) { browseButtons(); updateSelection(); }
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

function tile(label, type, action, glyph = type) {
  const item = button('', action, 'tile');
  item.title = label;
  const badge = make('span', '', 'icon ' + type);
  badge.append(icon(glyph));
  item.append(badge, make('span', label, 'tile-label'));
  return item;
}

async function activate(id) {
  try {
    if (id === 'dsm') return openBrowser('remote');
    if (id === 'downloads') return openBrowser('local');
    if (id === 'sync') return openSettings();
    if (id === 'terminal') return await api.terminal();
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

function parentOf(path) {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function browseButtons() {
  const noShare = browserPath === '/' && state.profile.provider === 'synology';
  $('up-button').disabled = browserPath === '/' || transferring;
  $('refresh-button').disabled = loadingFolder || transferring;
  $('upload-button').hidden = browserMode !== 'remote' || !state.settings.remoteWrites;
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
  if (action.dataset.glyph === glyph && action.firstChild) {
    action.lastElementChild.textContent = label;
    return;
  }
  action.dataset.glyph = glyph;
  action.replaceChildren(icon(glyph, action.classList.contains('danger') ? '#ff9c9e' : '#ecedef'), make('span', label));
}

function updateSelection() {
  const files = selectedFiles();
  const single = files.length === 1;
  $('selection-bar').hidden = browserMode === 'picker' || !browserMode;
  $('selection-count').textContent = files.length.toLocaleString('ko-KR') + '개 선택';
  $('open-selection').disabled = !single || transferring || loadingFolder;
  const folder = single && files[0].directory;
  setSelectionIcon($('open-selection'), folder ? '폴더 열기' : '미리보기', folder ? 'files' : 'eye');
  $('download-selection').hidden = browserMode !== 'remote';
  $('delete-selection').hidden = browserMode === 'remote' && (!state.settings.remoteWrites ||
    browserPath === '/' && state.profile.provider === 'synology');
  const remote = browserMode === 'remote';
  $('mkdir-button').hidden = !remote;
  $('mkdir-button').disabled = !state.settings.remoteWrites || browserPath === '/' || transferring || loadingFolder;
  for (const id of ['download-selection', 'delete-selection']) $(id).disabled = !files.length || transferring || loadingFolder;
  $('clear-selection').disabled = !browserEntries.length || transferring || loadingFolder;
  setSelectionIcon($('clear-selection'), files.length && files.length === browserEntries.length ? '선택 해제' : '전체 선택', 'clear');
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
  const actions = [...$('selection-bar').querySelectorAll('button[data-glyph]')].filter(action => !action.hidden && !action.disabled);
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
    $('transfer-indicator').hidden = true;
    if (state.connected) browseButtons();
  }
}

function openEditor() {
  $('editor-description').textContent = state.settings.integrityKey
    ? '서명 검증이 설정된 NAS 폴더에서는 서명 목록을 갱신해야 다른 PC에도 적용됩니다.'
    : '';
  elements('editor-form').github.value = state.settings.layout.links.github || '';
  notice('editor-error');
  $('editor').showModal();
}

document.body.dataset.platform = api.platform;
$('sync-now').append(icon('sync', '#cbd8ef'));
$('nas-edit').append(icon('pencil', '#cbd8ef'));
$('update-now').append(icon('downloads', '#4ade80'));
$('update-mark').append(icon('downloads'));
$('edit-button').append(icon('pencil', '#cbd8ef'));
$('account-button').append(icon('account', '#cbd8ef'));
for (const [id, glyph] of [['account-writes', 'pencil'], ['account-switch', 'switch'],
  ['logout-button', 'logout'], ['account-settings', 'sync']]) {
  $(id).append(icon(glyph, id === 'account-settings' ? '#fff' : '#cbd8ef'));
}
for (const action of $('selection-bar').querySelectorAll('button[data-glyph]')) {
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
for (const field of [login.url, login.user, login.pin, login.password]) field.addEventListener('input', savedLoginHint);
login.remember.addEventListener('change', savedLoginHint);
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || state.connected || $('login-form').inert || $('login-button').disabled) return;
  const form = elements('login-form');
  let focus;
  notice('login-error');
  loginPending = true;
  showPage();
  drawLoginButton();
  try {
    const request = api.login({
      url: form.url.value, user: form.user.value, pin: form.pin.value,
      name: form.name.value, editId: loginMode === 'edit' ? selectedNas.id : undefined,
      password: form.password.value, otp: form.otp.value, remember: form.remember.checked
    });
    form.password.value = '';
    form.otp.value = '';
    apply(await request);
  } catch (error) {
    notice('login-error', error.message);
    if (/\(DSM 40[34]\)/u.test(error.message)) {
      showOtp(true);
      focus = form.otp;
    } else focus = form.password;
  } finally {
    loginPending = false;
    showPage();
    savedLoginHint();
    drawLoginButton();
    if (!$('signin').hidden) focus?.focus();
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
$('account-writes').addEventListener('click', busy($('account-writes'), async () => {
  notice('account-error');
  apply(await api.remoteWrites(!state.settings.remoteWrites));
}, error => notice('account-error', error.message, true)));
$('account-switch').addEventListener('click', busy($('account-switch'), () => api.switchNas(),
  error => notice('account-error', error.message, true)));
$('account-settings').addEventListener('click', () => {
  $('account').close();
  openSettings();
});
$('logout-button').addEventListener('click', busy($('logout-button'), async () => {
  await api.logout();
}, error => notice('account-error', error.message, true)));
async function requestUpdate() {
  if (!state || updateRequested || state.applyingUpdate || state.connecting) return;
  updateRequested = true;
  if (!state.connected) notice('login-error');
  drawUpdate();
  try {
    await api.installUpdate();
  } catch (error) {
    if (!state.connected) notice('login-error', error.message);
    else if ($('account').open) notice('account-error', error.message, true);
    else toast(error.message);
  } finally {
    updateRequested = false;
    drawUpdate();
  }
}
$('update-now').addEventListener('click', requestUpdate);
const signinUpdateButton = $('signin-update-check');
signinUpdateButton.addEventListener('pointerenter', () => {
  if (!signinUpdateButton.disabled && state?.update?.phase === 'current') showSigninCurrent();
});
for (const id of ['signin-update-check', 'account-update-check']) {
  $(id).addEventListener('click', async () => {
    if (!state || $(id).disabled) return;
    if (['available', 'ready'].includes(state.update?.phase)) return requestUpdate();
    try {
      const checked = await api.checkUpdate();
      if (id === 'signin-update-check' && !state.connected && !state.connecting &&
          checked.update?.phase === 'current' && state.update?.phase === 'current') {
        showSigninCurrent();
      }
    } catch (error) {
      notice(id === 'signin-update-check' ? 'login-error' : 'account-error', error.message, true);
    }
  });
}
$('nas-edit').addEventListener('click', () => {
  notice('login-error');
  selectNas(selectedNas, { mode: loginMode === 'edit' ? 'login' : 'edit', focus: true });
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
$('browser-results').addEventListener('click', event => {
  if (!transferring && selected.size && !event.target.closest('.file-card, tr, button')) clearSelection();
});
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
$('clear-selection').addEventListener('click', () => {
  if (selected.size === browserEntries.length) return clearSelection();
  selected = new Set(browserEntries.map(entry => entry.path));
  updateSelection();
});
$('mkdir-button').addEventListener('click', () => {
  $('mkdir-form').reset();
  notice('mkdir-error');
  $('mkdir-dialog').showModal();
});
$('mkdir-form').addEventListener('submit', event => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    if (await api.mkdir(browserPath, elements('mkdir-form').name.value)) {
      $('mkdir-dialog').close();
      void loadFolder(browserPath);
    }
  }, error => notice('mkdir-error', error.message, true))();
});
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

$('transfer-button').append(icon('up', '#ecedef'));
api.onTransfer(info => {
  if (!transferring || browserMode !== 'remote') return;
  $('transfer-indicator').hidden = false;
  const button = $('transfer-button');
  if (button.dataset.direction !== info.direction) {
    button.replaceChildren(icon(info.direction === 'upload' ? 'up' : 'downloads', '#ecedef'));
    button.dataset.direction = info.direction;
  }
  $('transfer-title').textContent = info.direction === 'upload' ? '파일 업로드 중' : '파일 다운로드 중';
  $('transfer-name').textContent = info.name;
  const meter = $('transfer-progress');
  const percent = info.total === null ? null : info.total === 0 ? 100 : Math.min(100, Math.round(info.bytes / info.total * 100));
  button.style.setProperty('--transfer-progress', (percent ?? 0) + '%');
  if (percent === null) meter.removeAttribute('value');
  else meter.value = percent;
  $('transfer-details').textContent = (percent === null ? bytes(info.bytes) : percent + '%') + ' · ' + bytes(info.rate) + '/s';
});

initWorkspace();
api.onState(apply);
api.state().then(apply).catch(error => {
  if (state) return;
  $('signin-loading').hidden = true;
  $('login-form').inert = false;
  $('login-button').disabled = true;
  notice('login-error', error.message);
});
