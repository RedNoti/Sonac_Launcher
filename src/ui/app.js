'use strict';

const api = window.launcher;
const $ = id => document.getElementById(id);
const elements = (id) => $(id).elements;
const groups = [
  { id: 'synology', title: 'SYNOLOGY', tiles: [['dsm', 'DSM'], ['drive', 'Drive'], ['photos', 'Photos'], ['containers', '컨테이너']] },
  { id: 'files', title: '파일 관리', tiles: [['files', 'File Station'], ['downloads', '다운로드'], ['sync', '백업 · 동기화']] },
  { id: 'git', title: 'GIT', tiles: [['github', 'GitHub'], ['nas-git', 'NAS Git'], ['terminal', '터미널']] }
];
const builtIns = [
  ['dsm', 'DSM'], ['drive', 'Drive'], ['photos', 'Photos'], ['containers', '컨테이너'], ['github', 'GitHub'], ['nas-git', 'NAS Git']
];
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let state;
let tileSignature = '';
let toastTimer;
let browserPath = '/';
let pickerMode = false;
let browseGeneration = 0;
let transferring = false;
let loadingFolder = false;

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

function apply(next) {
  const previous = state;
  state = next;
  $('home').hidden = !state.connected;
  $('signin').hidden = state.connected;
  if (!state.connected) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    if (!previous || previous.connected) {
      const form = elements('login-form');
      form.provider.value = state.profile?.provider || 'synology';
      form.url.value = state.profile?.url || '';
      form.user.value = state.profile?.user || '';
      form.password.value = '';
      form.otp.value = '';
      setProvider();
    }
    $('login-button').disabled = state.connecting;
    $('login-button').textContent = state.connecting ? '연결 중…' : '로그인';
    if (state.loginError) notice('login-error', state.loginError);
    return;
  }
  const signature = JSON.stringify([state.profile, state.settings.layout]);
  if (signature !== tileSignature) {
    drawTiles();
    tileSignature = signature;
  }
  const { settings, sync, device } = state;
  const last = sync || settings.last;
  const configured = !!settings.local && !!settings.remote;
  $('sync-now').disabled = !!sync?.running;
  $('sync-now').textContent = sync?.running ? '동기화 중…' : '지금 동기화';
  $('sync-dot').className = 'dot' + (sync?.running ? ' active' : last?.errors ? ' warn' : last?.checkedAt ? ' good' : '');
  $('sync-status').textContent = device + ' · ' + (
    sync?.running ? '확인 중' : last?.checkedAt ? shortDate.format(last.checkedAt) :
      configured ? (last?.errors ? '확인 실패' : '확인 대기 중') : '동기화 설정 필요'
  );
  const summary = last ? `받은 파일 ${last.downloaded}개 · 기존 파일 ${last.skipped}개` : '';
  notice('sync-extra', last?.errors ? `확인 실패 ${last.errors}건 · ${last.message}` : summary);
}

function tile(label, type, action) {
  const item = button('', action, 'tile');
  item.title = label;
  const badge = make('span', '', 'icon ' + type);
  badge.append(icon(type, type === 'add' ? '#a7b0bf' : '#fff'));
  item.append(badge, make('span', label, 'tile-label'));
  return item;
}

async function activate(id) {
  try {
    if (id === 'files') return openBrowser(false, state.settings.remote || '/');
    if (id === 'downloads') return await api.openFolder();
    if (id === 'sync') return openSettings();
    if (id === 'terminal') return await api.terminal();
    const url = state.settings.layout.links[id] || defaultLink(id);
    if (url) await api.openLink(url);
    else openEditor({ focus: id });
  } catch (error) {
    toast(error.message);
  }
}

function defaultLink(id) {
  if (id === 'github') return 'https://github.com/';
  if (id === 'dsm' && state.profile.provider === 'synology') return state.profile.url;
  return '';
}

function drawTiles() {
  const container = $('groups');
  container.replaceChildren();
  for (const group of groups) {
    const panel = make('section', '', 'panel');
    const heading = make('h2', group.title);
    heading.id = 'group-' + group.id;
    panel.setAttribute('aria-labelledby', heading.id);
    const grid = make('div', '', 'tiles');
    for (const [id, label] of group.tiles) {
      grid.append(tile(id === 'files' && state.profile.provider === 'webdav' ? '클라우드 파일' : label, id, () => activate(id)));
    }
    for (const item of state.settings.layout.shortcuts.filter(item => item.group === group.id)) {
      grid.append(tile(item.name, 'link', async () => {
        try { await api.openLink(item.url); } catch (error) { toast(error.message); }
      }));
    }
    if (group.id !== 'synology' || state.settings.layout.shortcuts.some(item => item.group === 'synology')) {
      grid.append(tile('추가', 'add', () => openEditor({ add: group.id })));
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
  $('upload-button').hidden = pickerMode;
  $('upload-button').disabled = noShare || loadingFolder || transferring;
  $('pick-button').hidden = !pickerMode;
  $('pick-button').disabled = noShare || loadingFolder || transferring;
}

function breadcrumb() {
  const crumbs = $('breadcrumbs');
  crumbs.replaceChildren();
  const rootName = state.profile.provider === 'synology' ? '공유 폴더' : '클라우드';
  crumbs.append(button(rootName, () => loadFolder('/')));
  let folder = '';
  for (const name of browserPath.split('/').slice(1).filter(Boolean)) {
    folder += '/' + name;
    const target = folder;
    crumbs.append(make('span', '/'), button(name, () => loadFolder(target)));
  }
  crumbs.lastChild.setAttribute('aria-current', 'location');
}

function emptyRow(label) {
  const tr = make('tr');
  const cell = make('td', label, 'empty');
  cell.colSpan = 4;
  tr.append(cell);
  $('file-list').replaceChildren(tr);
}

function bytes(size) {
  if (!Number.isFinite(size)) return '–';
  if (size < 1024) return size + ' B';
  const unit = Math.min(4, Math.floor(Math.log(size) / Math.log(1024)));
  return (size / 1024 ** unit).toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
}

function drawFiles(list) {
  $('file-list').replaceChildren();
  const rows = list.filter(file => file.name !== 'sonac-launcher.config.json' && (!pickerMode || file.directory));
  rows.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  if (!rows.length) return emptyRow(pickerMode ? '하위 폴더가 없습니다.' : '폴더가 비어 있습니다.');
  for (const file of rows) {
    const row = make('tr');
    const nameCell = make('td');
    const label = file.directory
      ? button('', () => loadFolder(file.path), 'file-name')
      : make('span', '', 'file-name');
    label.append(icon(file.directory ? 'files' : 'file', '#a9c6f8'), make('span', file.name));
    nameCell.append(label);
    const action = make('td');
    if (!file.directory) {
      const save = button('다운로드', () => transfer(async () => {
        if (await api.download(file)) notice('browser-status', file.name + ' 다운로드 완료');
      }));
      save.setAttribute('aria-label', file.name + ' 다운로드');
      action.append(save);
    }
    row.append(nameCell, make('td', file.directory ? '–' : bytes(file.size)),
      make('td', file.modified ? shortDate.format(file.modified) : '–'), action);
    $('file-list').append(row);
  }
}

async function loadFolder(path) {
  if (transferring || !state.connected) return;
  const generation = ++browseGeneration;
  browserPath = path;
  loadingFolder = true;
  breadcrumb();
  browseButtons();
  notice('browser-status');
  emptyRow('폴더를 불러오는 중…');
  try {
    const list = await api.list(path);
    if (generation === browseGeneration) drawFiles(list);
  } catch (error) {
    if (generation !== browseGeneration) return;
    emptyRow('파일 목록을 열 수 없습니다.');
    notice('browser-status', error.message, true);
  } finally {
    if (generation === browseGeneration && state.connected) {
      loadingFolder = false;
      browseButtons();
    }
  }
}

function openBrowser(selecting, path) {
  if (transferring) return toast('파일 전송이 끝난 뒤 다시 열어 주세요.');
  pickerMode = selecting;
  $('browser-title').textContent = selecting ? '동기화 폴더 선택' : state.profile.provider === 'synology' ? 'File Station' : '클라우드 파일';
  $('browser-label').textContent = new URL(state.profile.url).host;
  $('browser').showModal();
  void loadFolder(path);
}

async function transfer(action) {
  if (transferring || loadingFolder) return;
  transferring = true;
  browseButtons();
  notice('browser-status', '파일 전송 중…');
  try {
    await action();
    if ($('browser-status').textContent === '파일 전송 중…') notice('browser-status');
  } catch (error) {
    notice('browser-status', error.message, true);
  } finally {
    transferring = false;
    if (state.connected) browseButtons();
  }
}

function urlInput(value, name, placeholder = 'https://') {
  const input = make('input');
  input.type = 'url';
  input.value = value;
  input.placeholder = placeholder;
  input.name = name;
  input.spellcheck = false;
  return input;
}

function shortcutRow(item = { id: crypto.randomUUID(), group: 'files', name: '', url: '' }) {
  const row = make('div', '', 'shortcut-row');
  row.dataset.id = item.id;
  const group = make('select');
  group.setAttribute('aria-label', '바로가기 그룹');
  for (const { id, title } of groups) group.append(new Option(title, id, false, id === item.group));
  const name = make('input');
  name.placeholder = '이름';
  name.required = true;
  name.maxLength = 40;
  name.value = item.name;
  name.setAttribute('aria-label', '바로가기 이름');
  const link = urlInput(item.url, 'url');
  link.required = true;
  link.setAttribute('aria-label', '바로가기 주소');
  row.append(group, name, link, button('삭제', () => row.remove()));
  $('custom-links').append(row);
  return name;
}

function addShortcut(group) {
  if ($('custom-links').children.length >= 30) {
    notice('editor-error', '바로가기는 30개까지 추가할 수 있습니다.', true);
    return;
  }
  shortcutRow({ id: crypto.randomUUID(), group, name: '', url: '' }).focus();
}

function openEditor({ focus, add } = {}) {
  $('editor-description').textContent = state.settings.remote
    ? '같은 클라우드 폴더를 사용하는 PC에 바로가기가 동기화됩니다.'
    : '동기화 폴더를 연결하면 바로가기를 여러 PC에서 사용할 수 있습니다.';
  $('built-in-links').replaceChildren();
  $('custom-links').replaceChildren();
  for (const [id, label] of builtIns) {
    const wrapper = make('label', label);
    wrapper.append(urlInput(state.settings.layout.links[id] || '', id, defaultLink(id) || 'https://'));
    $('built-in-links').append(wrapper);
  }
  for (const item of state.settings.layout.shortcuts) shortcutRow(item);
  notice('editor-error');
  $('editor').showModal();
  if (focus) elements('editor-form')[focus].focus();
  if (add) addShortcut(add);
}

document.body.dataset.platform = api.platform;
$('sync-icon').append(icon('sync'));
$('account-button').append(icon('account', '#cbd8ef'));
for (const item of document.querySelectorAll('[data-close]')) {
  item.addEventListener('click', () => $(item.dataset.close).close());
}
elements('login-form').provider.addEventListener('change', setProvider);
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

$('pick-remote').addEventListener('click', () => openBrowser(true, elements('settings-form').remote.value || '/'));
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
$('browser').addEventListener('close', () => { browseGeneration++; });
$('up-button').addEventListener('click', () => loadFolder(parentOf(browserPath)));
$('refresh-button').addEventListener('click', () => loadFolder(browserPath));
$('pick-button').addEventListener('click', () => {
  elements('settings-form').remote.value = browserPath;
  $('browser').close();
});
$('upload-button').addEventListener('click', () => {
  let result;
  const folder = browserPath;
  void transfer(async () => { result = await api.upload(folder); }).then(async () => {
    if (result && $('browser').open && browserPath === folder) {
      await loadFolder(folder);
      const message = `업로드 완료 ${result.uploaded}개` +
        (result.errors.length ? ` · 실패 ${result.errors.length}개 · ${result.errors[0]}` : '');
      notice('browser-status', message, !!result.errors.length);
    } else if (result) {
      toast(result.errors.length ? result.errors[0] : `${result.uploaded}개 파일을 업로드했습니다.`);
    }
  });
});
$('add-shortcut').addEventListener('click', () => addShortcut('files'));
$('editor-form').addEventListener('submit', event => {
  event.preventDefault();
  void busy(event.submitter, async () => {
    notice('editor-error');
    const links = Object.fromEntries(builtIns.map(([id]) => [id, elements('editor-form')[id].value.trim()]));
    const shortcuts = [...$('custom-links').children].map(row => {
      const [group, name, url] = row.querySelectorAll('select,input');
      return { id: row.dataset.id, group: group.value, name: name.value.trim(), url: url.value.trim() };
    });
    apply(await api.layout({ version: 1, links, shortcuts }));
    $('editor').close();
    toast('런처 구성을 저장했습니다.');
  }, error => notice('editor-error', error.message, true))();
});

api.onState(apply);
api.state().then(apply).catch(error => notice('login-error', error.message));
