'use strict';

const { app, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, nativeImage, net, powerMonitor, protocol, safeStorage, session, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { storage, endpoint, remotePath, openAsBlob, networkFailure } = require('./storage');
const { certificatePin } = require('./transport');
const { profileBinding, wrapped, seal, unseal } = require('./credentials');
const { LAYOUT_FILE, cleanLayout, pullFiles, scanMissing, downloadFile, downloadSelection, guardedFolder } = require('./sync');
const { origin, createPreview, clearPreview, serve } = require('./preview');
const { createUpdater } = require('./updater');
const { manifestName } = require('./nas-integrity');
const github = require('./github');
const { fileName, syncExternal } = require('./areas');

const { productName, version, releaseVersion = version, updatePublicKey, updateRepository, updateChannel } = require('../package.json');
protocol.registerSchemesAsPrivileged([{
  scheme: 'sonac', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
app.setName(productName);
app.setAppUserModelId('kr.sonac.launcher');
if (tls.getCACertificates && tls.setDefaultCACertificates) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

const page = origin + '/index.html';
const terminalPage = 'sonac://terminal/terminal.html';
const promptPage = 'sonac://prompt/prompt.html';
const iconPath = path.join(__dirname, 'ui', 'app.png');
const defaultLayout = { version: 1, links: {}, shortcuts: [] };
const sessionErrors = new Set([106, 107, 119]);
const updateBlockingHandlers = new Set(['login', 'logout', 'settings', 'upload', 'download', 'delete',
  'githubConnect', 'githubDisconnect', 'githubTrack', 'areaGroupSave', 'areaGroupRemove',
  'areaSave', 'areaRemove', 'areaRun', 'remoteWrites', 'switchNas', 'mkdir',
  'terminalCommandSave', 'terminalCommandRemove']);
const pendingOperations = new Set();
const areaJobs = new Map();
const folderSyncJobs = new Map();
const device = computerName();
let window;
let tray;
let db;
let writeQueue = Promise.resolve();
let current = null;
let connecting = false;
let loginController;
let restoringLogin = false;
let loginError = '';
let syncJob = null;
let layoutJob = null;
let configuring = false;
let timer;
let areaTimer;
let networkTimer;
let networkOnline;
let networkRetryAt = Infinity;
let networkRetryDelay = 3000;
let recoveringNetwork = false;
let restorePending = false;
let menuBarItem;
let quitting = false;
let pickedFolder = '';
let updater;
let update = null;
let applyingUpdate = false;
let waitingForRestart = false;
let restartForUpdate = false;
let terminalSession;
let terminalView;
let activePrompt;

function computerName() {
  if (process.platform === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000
      }).trim();
      if (name) return name;
    } catch {
      // The network hostname is also available on systems without a computer name.
    }
  }
  return os.hostname().replace(/\.local$/u, '');
}

function accountKey(profile) {
  const { provider, url, user } = profile;
  return createHash('sha256').update(JSON.stringify({ provider, url, user })).digest('hex');
}

function workspace(connection = current) {
  const key = accountKey(connection.profile);
  db.workspaces[key] ??= { remote: '', local: '', interval: 5, automatic: true, layout: defaultLayout, last: null };
  const settings = db.workspaces[key];
  settings.areas ??= [];
  if (!settings.syncGroups) {
    settings.syncGroups = [];
    const groups = new Map();
    for (const area of settings.areas) {
      if (!['nas', 'github'].includes(area.source)) continue;
      const key = area.name.normalize('NFC').toLowerCase();
      if (!groups.has(key)) {
        const group = { id: randomUUID(), name: area.name };
        groups.set(key, group);
        settings.syncGroups.push(group);
      }
      area.groupId = groups.get(key).id;
    }
  }
  return settings;
}

async function readDB() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (parsed.version === 1 && parsed.workspaces && typeof parsed.workspaces === 'object') {
      if (!Array.isArray(parsed.connections)) parsed.connections = parsed.profile?.provider === 'synology' ?
        [{ profile: parsed.profile, remembered: parsed.remembered }] : [];
      delete parsed.remembered;
      if (parsed.profile?.provider !== 'synology') parsed.profile = null;
      return parsed;
    }
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  return { version: 1, profile: null, connections: [], launchAtLogin: false, workspaces: {} };
}

function savedConnection(profile) {
  return profile && db.connections.find(record => accountKey(record.profile) === accountKey(profile));
}

function persist() {
  const filename = path.join(app.getPath('userData'), 'settings.json');
  const temp = filename + '.' + randomUUID() + '.tmp';
  const data = JSON.stringify(db);
  const save = async () => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    try {
      await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true });
    }
  };
  writeQueue = writeQueue.catch(() => {}).then(save);
  return writeQueue;
}

function status() {
  const { github: account, ...settings } = current ? workspace() : {};
  return {
    versionLabel: (app.isPackaged ? updateChannel ?? 'R' : '') + releaseVersion,
    profile: current?.profile || db?.profile,
    connected: !!current,
    connecting: connecting || restoringLogin,
    restoringLogin,
    applyingUpdate,
    waitingForRestart,
    terminalOpen: !!terminalView,
    nasProfiles: db?.connections.map(({ profile, remembered }) => ({
      ...profile, id: accountKey(profile), saved: wrapped(remembered)
    })) || [],
    loginError,
    device,
    launchAtLogin: !!db?.launchAtLogin,
    settings: current ? { ...settings, remoteWrites: current.remoteWrites } : null,
    github: wrapped(account?.token) ? { login: account.login, tracked: account.tracked } : null,
    runningAreas: [...areaJobs.keys()],
    sync: current?.sync || null,
    update
  };
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('launcher:state', status());
}

function secureSession(partition, host) {
  const isolated = session.fromPartition(partition);
  isolated.protocol.handle('sonac', request => serve(request, host));
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({ cancel: !(url.protocol === 'sonac:' && url.host === host) &&
      url.protocol !== 'blob:' && url.protocol !== 'data:' });
  });
}

function secureWindow(view) {
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const event of ['will-frame-navigate', 'will-navigate', 'will-redirect', 'will-attach-webview']) {
    view.webContents.on(event, attempt => attempt.preventDefault());
  }
}

function showWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1280, height: 800, minWidth: 460, minHeight: 550, show: false,
    backgroundColor: '#101115', title: productName, icon: iconPath, autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: 'launcher', devTools: !app.isPackaged
    }
  });
  secureWindow(window);
  window.once('ready-to-show', () => window?.show());
  window.on('resize', layoutPages);
  window.webContents.on('render-process-gone', () => {
    closePrompt();
    closeTerminal();
  });
  window.on('close', event => {
    closePrompt();
    closeTerminal();
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    window = undefined;
    void clearPreview();
    closePrompt();
    closeTerminal();
  });
  window.loadURL(page);
}

function installTray() {
  const settings = current && workspace();
  const shouldKeepRunning = settings && ((settings.automatic && settings.local && settings.remote) ||
    settings.areas.some(isAutomaticSyncArea));
  const mac = process.platform === 'darwin';
  if (!shouldKeepRunning || (mac && db.hideMenuBarIcon)) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (tray) return;
  const trayImage = process.platform === 'darwin' ? path.join(__dirname, 'ui', 'tray.png') : iconPath;
  const icon = nativeImage.createFromPath(trayImage).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(productName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'sonac launcher 열기', click: showWindow },
    { label: '지금 동기화', click: () => { void runSync(true); void runAutomaticAreas(); } },
    ...(mac ? [{ label: '메뉴 막대 아이콘 숨기기', click: () => void setMenuBarIcon(false) }] : []),
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
  if (process.platform === 'win32') tray.on('double-click', showWindow);
}

async function setMenuBarIcon(visible) {
  db.hideMenuBarIcon = !visible;
  menuBarItem.checked = visible;
  installTray();
  try {
    await persist();
  } catch (error) {
    await showError('메뉴 막대 설정 저장 실패', displayError(error));
  }
}

function retryNetworkSoon(delay) {
  networkRetryAt = Math.min(networkRetryAt, Date.now() + delay);
}

function retryNetworkAfter(error) {
  if (!networkFailure(error)) return;
  if (!Number.isFinite(networkRetryAt)) {
    retryNetworkSoon(networkRetryDelay);
    networkRetryDelay = Math.min(networkRetryDelay * 2, 60000);
  }
}

async function monitorNetwork() {
  const online = net.isOnline();
  if (online && networkOnline === false) retryNetworkSoon(0);
  networkOnline = online;
  if (!online || recoveringNetwork || applyingUpdate || connecting || restoringLogin || quitting ||
      (!current && !restorePending) || Date.now() < networkRetryAt) return;
  networkRetryAt = Infinity;
  recoveringNetwork = true;
  const connection = current;
  try {
    if (!connection) {
      await restore();
      return;
    }
    await operate(connection, (store, signal) => store.list('/', signal));
    networkRetryDelay = 3000;
    await Promise.allSettled([syncJob, connection.automaticAreasJob]);
    if (connection === current && !applyingUpdate && !quitting) {
      scheduleSync(true);
      scheduleAreas(true);
    }
  } catch (error) {
    if (connection === current) retryNetworkAfter(error);
  } finally {
    recoveringNetwork = false;
  }
}

function scheduleSync(immediate = false) {
  clearTimeout(timer);
  if (!current) return;
  const settings = workspace();
  if (!settings.remote || !settings.local) return;
  timer = setTimeout(() => { void runSync(); }, immediate ? 150 : settings.interval * 60 * 1000);
}

async function connect(profile, secret, otp, remember, { restoring = false, edited } = {}) {
  if (applyingUpdate) throw new Error('업데이트가 끝난 뒤 로그인하세요.');
  if (connecting || current || quitting) throw new Error('이미 로그인 중이거나 앱을 종료하는 중입니다.');
  connecting = true;
  const controller = loginController = new AbortController();
  loginError = '';
  publish();
  const store = storage(profile);
  let remembered = null;
  try {
    const renewed = await store.connect(secret, otp, remember, controller.signal);
    if (remember) remembered = await seal(safeStorage, profileBinding(profile), renewed);
    controller.signal.throwIfAborted();
    db.profile = profile;
    db.autoLoginPaused = false;
    const saved = edited || savedConnection(profile);
    if (saved) Object.assign(saved, { profile, remembered });
    else db.connections.push({ profile, remembered });
    current = { profile, store, secret: renewed, remember, remoteWrites: true, abort: new AbortController(), sync: null,
      reconnect: null, pickedAreaFolders: new Set() };
    restorePending = false;
    networkRetryDelay = 3000;
    networkRetryAt = Infinity;
    workspace();
    await persist();
    installTray();
    scheduleSync(true);
    scheduleAreas(true);
  } catch (error) {
    current = null;
    await store.logout();
    await store.dispatcher?.destroy().catch(() => {});
    if (restoring) loginError = error.message;
    throw error;
  } finally {
    loginController = undefined;
    connecting = false;
    publish();
  }
}

async function rememberedSecret(profile) {
  const secret = await unseal(safeStorage, savedConnection(profile)?.remembered, profileBinding(profile));
  if (typeof secret?.password !== 'string' || !secret.password) throw new Error('다시 로그인하세요.');
  return secret;
}

async function restore() {
  const saved = savedConnection(db.profile);
  if (db.autoLoginPaused || !saved?.remembered) return;
  restoringLogin = true;
  publish();
  try {
    if (!wrapped(saved.remembered)) {
      saved.remembered = null;
      await persist();
      throw new Error('저장된 로그인 보호 방식이 바뀌었습니다. 비밀번호를 다시 입력하세요.');
    }
    const secret = await rememberedSecret(db.profile);
    await connect(db.profile, secret, '', true, { restoring: true });
  } catch (error) {
    if (error.dsmCode === 400) {
      saved.remembered = null;
      await persist();
    }
    restorePending = wrapped(saved.remembered) && networkFailure(error);
    if (restorePending) retryNetworkAfter(error);
    loginError ||= error.message || '저장된 로그인을 복원할 수 없습니다.';
  } finally {
    restoringLogin = false;
    publish();
  }
}

function needConnection() {
  if (!current) throw new Error('저장소에 다시 로그인하세요.');
  return current;
}

function requireRemoteWrites(connection) {
  connection.abort.signal.throwIfAborted();
  if (!connection.remoteWrites) throw new Error('계정 메뉴에서 NAS 쓰기를 먼저 허용하세요.');
}

function transferReporter(connection, direction) {
  let previousName;
  let started;
  let lastSent;
  return (name, bytes, total) => {
    if (current !== connection || !window || window.isDestroyed()) return;
    const now = performance.now();
    if (name !== previousName || bytes === 0) {
      previousName = name;
      started = now;
      lastSent = -Infinity;
    }
    if (now - lastSent < 120 && bytes !== total) return;
    lastSent = now;
    window.webContents.send('launcher:transfer', { name, direction, bytes, total,
      rate: bytes / Math.max(0.05, (now - started) / 1000) });
  };
}

async function confirmChange(connection, { title, message, detail, action }) {
  connection.abort.signal.throwIfAborted();
  const accepted = await showPrompt({ title, message, detail, action, danger: action === '삭제', confirm: true });
  connection.abort.signal.throwIfAborted();
  return accepted;
}

async function logout({ forget = false, pauseAutoLogin = false } = {}) {
  const connection = current;
  if (!connection) return;
  current = null;
  restorePending = false;
  networkRetryAt = Infinity;
  if (pauseAutoLogin) db.autoLoginPaused = true;
  if (forget) {
    const saved = savedConnection(connection.profile);
    if (saved) saved.remembered = null;
  }
  connection.abort.abort(new Error('로그아웃했습니다.'));
  void clearPreview();
  closePrompt();
  closeTerminal();
  clearTimeout(timer);
  clearTimeout(areaTimer);
  pickedFolder = '';
  installTray();
  publish();
  try {
    await persist();
  } finally {
    await connection.store.logout();
    await connection.store.dispatcher?.destroy().catch(() => {});
  }
}

async function operate(connection, action) {
  const signal = connection.abort.signal;
  try {
    try {
      return await action(connection.store, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!sessionErrors.has(error.dsmCode)) throw error;
    }
    await renewSession(connection, signal);
    signal.throwIfAborted();
    return await action(connection.store, signal);
  } catch (error) {
    if (!signal.aborted && connection === current) retryNetworkAfter(error);
    throw error;
  }
}

async function renewSession(connection, signal) {
  connection.reconnect ??= connection.store
    .connect(connection.secret, '', connection.remember, signal)
    .then(secret => { connection.secret = secret; })
    .finally(() => { connection.reconnect = null; });
  try {
    await connection.reconnect;
  } catch (error) {
    if ([400, 403, 404].includes(error.dsmCode) && current === connection) {
      await logout({ forget: error.dsmCode === 400 });
      loginError = error.message;
      publish();
    }
    throw error;
  }
}

function runSync(manual = false) {
  if (syncJob) return syncJob;
  if (!current || !workspace().remote || !workspace().local) return Promise.resolve(null);
  if (layoutJob || configuring) {
    scheduleSync();
    return Promise.resolve(null);
  }
  clearTimeout(timer);
  const connection = current;
  const settings = workspace(connection);
  connection.sync = { checking: !manual, running: manual, downloaded: 0, skipped: 0, errors: 0, message: '' };
  publish();
  syncJob = syncInFolder(settings.local, async () => {
    try {
      connection.abort.signal.throwIfAborted();
      let counts;
      const files = [];
      let fileCount = 0;
      const file = name => {
        fileCount++;
        if (files.length < 300) files.push(name);
      };
      if (!manual) {
        const scan = await operate(connection, (store, signal) => {
          files.length = 0;
          fileCount = 0;
          return scanMissing(store, settings, signal, file);
        });
        if (current !== connection) return null;
        if (!scan.pending || !settings.automatic) counts = scan;
        else {
          connection.sync = scan;
          publish();
        }
      }
      if (!counts) {
        connection.sync = { ...connection.sync, pending: false, checking: false, running: true };
        publish();
        counts = await operate(connection, (store, signal) => {
          files.length = 0;
          fileCount = 0;
          return pullFiles(store, settings, { signal, progress() {}, file, layout(value) { settings.layout = value; } });
        });
      }
      if (current !== connection) return null;
      const result = { ...counts, checkedAt: Date.now(), running: false,
        files: counts.pending ? settings.last?.files || [] : files.sort(),
        fileCount: counts.pending ? settings.last?.fileCount || 0 : fileCount };
      settings.last = result;
      connection.sync = result;
      await persist();
      return result;
    } catch (error) {
      if (current !== connection) return null;
      connection.sync = { ...connection.sync, checking: false, running: false, errors: 1, message: displayError(error) };
      return connection.sync;
    } finally {
      syncJob = null;
      publish();
      scheduleSync();
    }
  });
  return syncJob;
}

function displayError(error) {
  if (typeof error?.code === 'string' && /^E[A-Z_]+$/u.test(error.code)) {
    return `파일 또는 시스템에 접근할 수 없습니다. (${error.code})`;
  }
  return error?.message || '작업을 완료할 수 없습니다.';
}

function areaById(connection, id) {
  const area = workspace(connection).areas.find(item => item.id === id);
  if (!area) throw new Error('동기화 영역을 찾을 수 없습니다.');
  return area;
}

function groupById(settings, id) {
  const group = settings.syncGroups.find(item => item.id === id);
  if (!group) throw new Error('동기화 영역을 찾을 수 없습니다.');
  return group;
}

function folderKey(value) {
  const resolved = path.resolve(value).normalize('NFC');
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function separateFolder({ local, source }, others) {
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  const target = folderKey(local);
  if (others.some(other => {
    if (!other.local) return false;
    const existing = folderKey(other.local);
    if (target === existing && source === 'nas' && other.source === 'nas') return false;
    return inside(target, existing) || inside(existing, target);
  })) {
    throw new Error('다른 동기화 영역과 겹치지 않는 저장 폴더를 선택하세요.');
  }
}

function syncInFolder(local, action) {
  const key = folderKey(local);
  const previous = folderSyncJobs.get(key);
  const job = Promise.resolve(previous).catch(() => {}).then(action).finally(() => {
    if (folderSyncJobs.get(key) === job) folderSyncJobs.delete(key);
  });
  folderSyncJobs.set(key, job);
  return job;
}

function githubAccount(connection, repository) {
  const account = workspace(connection).github;
  if (!wrapped(account?.token)) throw new Error('GitHub 타일에서 계정을 연결하세요.');
  if (repository) {
    github.repositoryPath(repository);
    if (repository.split('/')[0].toLowerCase() !== account.login.toLowerCase()) {
      throw new Error('연결한 GitHub 계정의 저장소를 선택하세요.');
    }
  }
  return account;
}

function githubBinding(connection, login) {
  return JSON.stringify(['github', profileBinding(connection.profile), login]);
}

async function githubToken(connection, account) {
  return unseal(safeStorage, account.token, githubBinding(connection, account.login));
}

function runArea(connection, area) {
  if (areaJobs.has(area.id)) return areaJobs.get(area.id);
  const job = syncInFolder(area.local, async () => {
    const signal = connection.abort.signal;
    try {
      signal.throwIfAborted();
      const root = await fs.realpath(area.local);
      if (root !== area.local || !(await fs.stat(root)).isDirectory()) throw new Error('저장 폴더를 다시 선택하세요.');
      let result;
      let files;
      let fileCount;
      if (area.source === 'nas') {
        result = await operate(connection, (store, activeSignal) => {
          files = [];
          fileCount = 0;
          return pullFiles(store, area, {
            signal: activeSignal, progress() {}, file(name) {
              fileCount++;
              if (files.length < 300) files.push(name);
            }
          });
        });
      } else {
        const token = await githubToken(connection, githubAccount(connection, area.repository));
        result = await syncExternal(area, root, { signal, token });
        files = result.files.slice(0, 300);
        fileCount = result.files.length;
      }
      signal.throwIfAborted();
      area.last = { ...result, files: files.sort(), fileCount, checkedAt: Date.now() };
      await persist();
    } catch (error) {
      if (signal.aborted) return;
      area.last = { ...area.last, errors: 1, message: displayError(error), checkedAt: Date.now() };
      await persist().catch(() => {});
      return area.source === 'nas' && networkFailure(error);
    } finally {
      areaJobs.delete(area.id);
      publish();
    }
  });
  areaJobs.set(area.id, job);
  publish();
  return job;
}

function isAutomaticSyncArea(area) {
  return area.source === 'nas' && area.automatic;
}

function scheduleAreas(immediate = false) {
  clearTimeout(areaTimer);
  if (!current || quitting || !workspace().areas.some(isAutomaticSyncArea)) return;
  areaTimer = setTimeout(() => { void runAutomaticAreas(); }, immediate ? 150 : workspace().interval * 60000);
}

function runAutomaticAreas() {
  const connection = current;
  if (!connection || quitting || connection.automaticAreasJob) return;
  clearTimeout(areaTimer);
  connection.automaticAreasJob = (async () => {
    const settings = workspace(connection);
    for (const area of [...settings.areas]) {
      if (current !== connection || quitting) return;
      if (isAutomaticSyncArea(area) && settings.areas.includes(area) && await runArea(connection, area)) break;
    }
  })().finally(() => {
    connection.automaticAreasJob = null;
    if (current === connection) scheduleAreas();
  });
}

function bind(name, handler, scope) {
  ipcMain.handle('launcher:' + name, async (event, ...args) => {
    const view = scope === 'terminal' ? terminalView : scope === 'prompt' ? activePrompt?.view : window;
    const expectedPage = scope === 'terminal' ? terminalPage : scope === 'prompt' ? promptPage : page;
    if (!view || event.sender !== view.webContents || event.senderFrame?.url !== expectedPage ||
        event.senderFrame !== view.webContents.mainFrame) {
      return { ok: false, error: '이 화면에서 작업을 실행할 수 없습니다.' };
    }
    let operation;
    try {
      if (quitting) throw new Error('앱을 종료하는 중입니다.');
      operation = handler(...args);
      if (updateBlockingHandlers.has(name)) pendingOperations.add(operation);
      return { ok: true, value: await operation };
    } catch (error) {
      return { ok: false, error: displayError(error) };
    } finally {
      if (updateBlockingHandlers.has(name)) pendingOperations.delete(operation);
    }
  });
}

async function listLocal(connection, folder) {
  if (typeof folder !== 'string' || !folder.startsWith('/') || folder.includes('\0')) {
    throw new Error('다운로드 폴더 경로를 확인하세요.');
  }
  const segments = folder === '/' ? [] : folder.slice(1).split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' ||
      (process.platform === 'win32' && /[\\:]/u.test(segment)))) {
    throw new Error('다운로드 폴더 경로를 확인하세요.');
  }
  const configured = workspace(connection).local;
  const root = configured ? path.resolve(configured) : await fs.realpath(app.getPath('downloads'));
  const directory = path.join(root, ...segments);
  if (!await guardedFolder(root, directory)) throw new Error('다운로드 폴더 안의 경로를 선택하세요.');
  const names = (await fs.readdir(directory)).filter(name => !/^\.sonac-(?:[0-9a-f-]{36}\.part|stage-.*)$/iu.test(name));
  const entries = await Promise.all(names.map(async name => {
    const info = await fs.lstat(path.join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info || !info.isFile() && !info.isDirectory()) return null;
    return {
      name, path: (folder === '/' ? '' : folder) + '/' + name,
      directory: info.isDirectory(), size: info.isFile() ? info.size : null, modified: info.mtimeMs,
      identity: [info.dev, info.ino, info.ctimeMs].join(':')
    };
  }));
  connection.abort.signal.throwIfAborted();
  return { root, directory, entries: entries.filter(Boolean) };
}

async function selectedEntries(connection, source, folder, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000 ||
      paths.some(item => typeof item !== 'string' || item.length > 4096)) {
    throw new Error('파일이나 폴더를 선택하세요.');
  }
  const selected = new Set(paths);
  const result = source === 'local' ? await listLocal(connection, folder) : {
    entries: await operate(connection, (store, signal) => store.list(remotePath(folder), signal))
  };
  const entries = result.entries.filter(entry => selected.has(entry.path) &&
    (source === 'local' || ![LAYOUT_FILE, manifestName].includes(entry.name.toLowerCase())));
  if (entries.length !== selected.size) throw new Error('선택한 항목이 변경됐습니다. 목록을 새로고침해 주세요.');
  return { ...result, entries };
}

function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 500) {
    throw new Error('터미널 창 크기를 확인하세요.');
  }
}

async function saveTerminalCommands(commands) {
  const previous = db.terminalCommands;
  db.terminalCommands = commands;
  try {
    await persist();
    return commands;
  } catch (error) {
    if (db.terminalCommands === commands) db.terminalCommands = previous;
    throw error;
  }
}

function layoutPages() {
  if (!terminalView && !activePrompt) return;
  const [width, height] = window.getContentSize();
  const y = process.platform === 'darwin' ? 40 : 0;
  const bounds = { x: 0, y, width, height: Math.max(0, height - y) };
  terminalView?.setBounds(bounds);
  activePrompt?.view.setBounds(bounds);
}

function closePrompt(accepted = false) {
  const prompt = activePrompt;
  if (!prompt) return;
  activePrompt = undefined;
  if (window && !window.isDestroyed()) {
    window.contentView.removeChildView(prompt.view);
    (terminalView || window).webContents.focus();
  }
  if (!prompt.view.webContents.isDestroyed()) prompt.view.webContents.close();
  prompt.resolve(accepted);
}

function showPrompt(details) {
  if (activePrompt) throw new Error('열려 있는 확인창을 먼저 닫으세요.');
  if (!window || window.isDestroyed() || !window.isVisible()) return Promise.resolve(false);
  const view = new WebContentsView({
    webPreferences: {
      partition: 'prompt', preload: path.join(__dirname, 'prompt-preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged
    }
  });
  secureWindow(view);
  view.setBackgroundColor('#00000000');
  return new Promise(resolve => {
    activePrompt = { view, details, resolve };
    const close = () => { if (activePrompt?.view === view) closePrompt(); };
    view.webContents.once('render-process-gone', close);
    try {
      window.contentView.addChildView(view);
      layoutPages();
    } catch (error) {
      close();
      throw error;
    }
    void view.webContents.loadURL(promptPage).then(() => {
      if (activePrompt?.view === view) view.webContents.focus();
    }).catch(close);
  });
}

async function showError(title, message) {
  if (activePrompt) closePrompt();
  showWindow();
  if (!window.isVisible()) window.show();
  await showPrompt({ title, message, action: '확인' });
}

function closeTerminal() {
  const view = terminalView;
  terminalView = undefined;
  const pty = terminalSession;
  terminalSession = undefined;
  try { pty?.kill(); } catch { /* process already ended */ }
  if (!view) return;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  publish();
}

function registerHandlers() {
  bind('promptDetails', () => activePrompt.details, 'prompt');
  bind('promptAnswer', accepted => {
    const prompt = activePrompt;
    setImmediate(() => {
      if (activePrompt === prompt) closePrompt(accepted === true);
    });
  }, 'prompt');
  bind('state', status);
  bind('checkUpdate', async () => {
    await updater?.check();
    return status();
  });
  bind('installUpdate', async () => {
    if (applyingUpdate || quitting) return;
    if (restoringLogin || connecting) throw new Error('로그인이 끝난 뒤 업데이트하세요.');
    if (!updater) throw new Error('설치할 업데이트가 없습니다.');
    applyingUpdate = true;
    publish();
    try {
      await updater.prepare();
      if (quitting) return;
      waitingForRestart = true;
      publish();
      const restart = await showPrompt({
        title: '다시 시작할까요?', message: (update.tag || update.version) + ' 업데이트가 준비됐습니다.',
        action: '다시 시작', restart: true
      });
      waitingForRestart = false;
      if (!restart || quitting) return;
      publish();
      while (!quitting && (syncJob || layoutJob || pendingOperations.size || areaJobs.size)) {
        await Promise.allSettled([syncJob, layoutJob, ...pendingOperations, ...areaJobs.values()]);
      }
      if (quitting) return;
      restartForUpdate = true;
      app.quit();
    } finally {
      waitingForRestart = false;
      if (!restartForUpdate) {
        applyingUpdate = false;
        publish();
      }
    }
  });
  bind('login', async (input) => {
    if (applyingUpdate) throw new Error('업데이트가 끝난 뒤 로그인하세요.');
    if (restoringLogin || connecting || current) throw new Error('이미 로그인 중입니다.');
    const { provider = 'synology', user, password, otp, remember } = input;
    if (provider !== 'synology' || typeof user !== 'string' || !user.trim() ||
        user.length > 256 || typeof password !== 'string' || password.length > 4096 ||
        typeof input.url !== 'string' || input.url.length > 2048 || typeof otp !== 'string' || (otp && !/^\d{6}$/u.test(otp))) {
      throw new Error('사용자 이름, 비밀번호 및 OTP를 확인하세요.');
    }
    const profile = { provider, url: endpoint(input.url, provider), user: user.trim(), pin: certificatePin(input.pin) };
    const edited = input.editId && db.connections.find(record => accountKey(record.profile) === input.editId);
    const saved = savedConnection(profile);
    if (input.editId && !edited) throw new Error('수정할 NAS 연결을 찾을 수 없습니다.');
    if (edited && saved && edited !== saved) throw new Error('같은 주소와 계정이 이미 등록되어 있습니다.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length > 48 || (!saved && !name)) throw new Error('NAS 이름을 48자 이내로 입력하세요.');
    profile.name = name || saved?.profile.name || '';
    if (!saved && !edited && db.connections.length >= 30) throw new Error('NAS 연결은 최대 30개까지 추가할 수 있습니다.');
    if (!password && remember !== true) throw new Error('비밀번호를 입력하세요.');
    restorePending = false;
    const secret = password ? { password } : await rememberedSecret(profile);
    if (!current && areaJobs.size) await Promise.allSettled(areaJobs.values());
    try {
      await connect(profile, secret, otp, remember === true, { edited });
    } catch (error) {
      if (!password && saved && error.dsmCode === 400) {
        saved.remembered = null;
        publish();
        await persist();
      }
      throw error;
    }
    return status();
  });
  bind('logout', () => logout({ pauseAutoLogin: true }));
  bind('switchNas', () => logout());
  bind('remoteWrites', async enabled => {
    const connection = needConnection();
    connection.remoteWrites = enabled === true;
    publish();
    return status();
  });
  bind('githubConnect', async input => {
    const connection = needConnection();
    const token = typeof input === 'string' ? input.trim() : '';
    if (!/^[\w-]{16,512}$/u.test(token)) throw new Error('GitHub 개인 액세스 토큰을 입력하세요.');
    const login = await github.identity(token, connection.abort.signal);
    const encrypted = await seal(safeStorage, githubBinding(connection, login), token);
    connection.abort.signal.throwIfAborted();
    const settings = workspace(connection);
    const tracked = settings.github?.login === login ? settings.github.tracked : [];
    settings.github = { login, token: encrypted, tracked };
    await persist();
    publish();
  });
  bind('githubDisconnect', async () => {
    const settings = workspace(needConnection());
    if (settings.areas.some(area => area.source === 'github' && areaJobs.has(area.id))) {
      throw new Error('GitHub 파일 적용이 끝난 뒤 연결을 해제하세요.');
    }
    delete settings.github;
    await persist();
    publish();
  });
  bind('githubRepos', async () => {
    const connection = needConnection();
    const account = githubAccount(connection);
    return github.repositories(await githubToken(connection, account), connection.abort.signal);
  });
  bind('githubCommit', async repository => {
    const connection = needConnection();
    const account = githubAccount(connection, repository);
    if (!account.tracked.includes(repository)) throw new Error('목록에 저장소를 추가하세요.');
    return github.latestCommit(repository, '', await githubToken(connection, account), connection.abort.signal);
  });
  bind('githubTrack', async (repository, track) => {
    const account = githubAccount(needConnection(), repository);
    github.repositoryPath(repository);
    if (track === true && !account.tracked.includes(repository)) {
      if (account.tracked.length >= 30) throw new Error('최대 30개 저장소를 표시할 수 있습니다.');
      account.tracked.push(repository);
    } else if (track === false) {
      account.tracked = account.tracked.filter(name => name !== repository);
    }
    await persist();
    publish();
  });
  bind('areaFolder', async () => {
    const connection = needConnection();
    const result = await dialog.showOpenDialog(window, { title: '동기화 영역의 저장 폴더 선택',
      properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return '';
    const local = await fs.realpath(result.filePaths[0]);
    connection.abort.signal.throwIfAborted();
    connection.pickedAreaFolders.add(local);
    return local;
  });
  bind('areaGroupSave', async input => {
    const settings = workspace(needConnection());
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('영역 이름을 60자 이내로 입력하세요.');
    const previous = input.id ? groupById(settings, input.id) : null;
    if (settings.syncGroups.some(group => group !== previous &&
        group.name.normalize('NFC').toLowerCase() === name.normalize('NFC').toLowerCase())) {
      throw new Error('같은 이름의 영역이 이미 있습니다.');
    }
    const group = previous || { id: randomUUID(), name };
    if (previous) group.name = name;
    else {
      if (settings.syncGroups.length >= 40) throw new Error('최대 40개 영역을 만들 수 있습니다.');
      settings.syncGroups.push(group);
    }
    await persist();
    publish();
    return group.id;
  });
  bind('areaGroupRemove', async id => {
    const settings = workspace(needConnection());
    const group = groupById(settings, id);
    if (settings.areas.some(area => area.groupId === group.id)) throw new Error('영역의 동기화 항목을 먼저 이동하거나 삭제하세요.');
    settings.syncGroups = settings.syncGroups.filter(item => item !== group);
    await persist();
    publish();
  });
  bind('areaSave', async input => {
    const connection = needConnection();
    const settings = workspace(connection);
    const previous = input.id ? areaById(connection, input.id) : null;
    if (input.source === 'link' || previous?.source === 'link') throw new Error('서버 업데이터는 전용 로그인이 필요합니다.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('항목 이름을 60자 이내로 입력하세요.');
    if (!input.local || (input.local !== previous?.local && !connection.pickedAreaFolders.has(input.local))) {
      throw new Error('이 PC의 저장 폴더를 선택하세요.');
    }
    if (previous && areaJobs.has(previous.id)) throw new Error('동기화가 끝난 뒤 수정하세요.');
    const area = { id: previous?.id || randomUUID(), name, source: input.source, local: input.local,
      automatic: input.automatic === true && input.source !== 'github' };
    if (area.source === 'nas') {
      area.remote = remotePath(input.remote);
      if (previous?.remote === area.remote && previous.integrityKey) area.integrityKey = previous.integrityKey;
      if (area.remote === '/' && connection.profile.provider === 'synology') throw new Error('NAS에서 공유 폴더를 선택하세요.');
      await operate(connection, (store, signal) => store.list(area.remote, signal));
    } else if (area.source === 'github') {
      github.repositoryPath(input.repository);
      githubAccount(connection, input.repository);
      area.repository = input.repository;
      area.branch = typeof input.branch === 'string' ? input.branch.trim() : '';
      if (area.branch.length > 255 || /[\u0000-\u001f\u007f]/u.test(area.branch)) throw new Error('브랜치 이름을 확인하세요.');
    } else {
      throw new Error('동기화 소스를 선택하세요.');
    }
    connection.abort.signal.throwIfAborted();
    area.groupId = groupById(settings, input.groupId ?? previous?.groupId).id;
    if (previous && (!settings.areas.includes(previous) || areaJobs.has(previous.id))) {
      throw new Error('동기화가 끝난 뒤 다시 수정하세요.');
    }
    if (!previous && settings.areas.length >= 40) throw new Error('최대 40개 동기화 항목을 만들 수 있습니다.');
    separateFolder(area, [{ local: settings.local, source: 'nas' }, ...settings.areas.filter(item => item !== previous)]);
    if (previous) {
      const fields = ['source', 'local', 'remote', 'repository', 'branch', 'integrityKey'];
      if (fields.every(field => (area[field] || '') === (previous[field] || ''))) {
        area.last = previous.last;
        area.integrityRevision = previous.integrityRevision;
      }
      settings.areas.splice(settings.areas.indexOf(previous), 1, area);
    } else {
      settings.areas.push(area);
    }
    await persist();
    installTray();
    publish();
    scheduleAreas();
    if (isAutomaticSyncArea(area) && current === connection && settings.areas.includes(area)) void runArea(connection, area);
  });
  bind('areaRemove', async id => {
    const connection = needConnection();
    const area = areaById(connection, id);
    if (areaJobs.has(id)) throw new Error('동기화가 끝난 뒤 영역을 삭제하세요.');
    const settings = workspace(connection);
    if (!await confirmChange(connection, {
      title: '동기화 항목 삭제', message: area.name + ' 항목을 삭제할까요?',
      detail: '이 PC에 저장된 파일은 유지됩니다.', action: '삭제'
    })) return false;
    if (!settings.areas.includes(area) || areaJobs.has(id)) throw new Error('항목 상태가 변경됐습니다. 다시 시도하세요.');
    settings.areas = settings.areas.filter(item => item !== area);
    await persist();
    installTray();
    scheduleAreas();
    return true;
    publish();
  });
  bind('areaRun', async id => {
    const connection = needConnection();
    const area = areaById(connection, id);
    if (area.source === 'link') throw new Error('서버 업데이터는 전용 로그인이 필요합니다.');
    if (areaJobs.has(id)) return;
    if (area.source === 'github') {
      const confirmed = await confirmChange(connection, {
        title: 'GitHub 최신 파일 적용', message: area.repository + '의 최신 커밋 파일을 적용할까요?',
        detail: area.local + '\n경로가 같은 파일의 로컬 수정 내용은 덮어씁니다.',
        action: '최신 파일 적용'
      });
      if (!confirmed) return;
      connection.abort.signal.throwIfAborted();
      if (areaById(connection, id) !== area) throw new Error('설정이 변경되었습니다. 다시 시도하세요.');
    }
    await runArea(connection, area);
  });
  bind('list', folder => {
    const location = remotePath(folder);
    return operate(needConnection(), (store, signal) => store.list(location, signal));
  });
  bind('listLocal', async folder => {
    const { root, entries } = await listLocal(needConnection(), folder);
    return { root, entries };
  });
  bind('chooseLocal', async () => {
    const connection = needConnection();
    const result = await dialog.showOpenDialog(window, {
      title: '동기화 폴더 선택', defaultPath: workspace().local || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    });
    connection.abort.signal.throwIfAborted();
    if (result.canceled) return '';
    pickedFolder = await fs.realpath(result.filePaths[0]);
    return pickedFolder;
  });
  bind('settings', async input => {
    if (syncJob || layoutJob || configuring) throw new Error('진행 중인 작업이 끝난 뒤 설정을 저장하세요.');
    const connection = needConnection();
    const settings = workspace(connection);
    const remote = remotePath(input.remote);
    if (remote === '/' && connection.profile.provider === 'synology') throw new Error('NAS에서 공유 폴더를 선택하세요.');
    if (!input.local || ![pickedFolder, settings.local].includes(input.local)) throw new Error('이 PC의 폴더를 선택하세요.');
    const interval = Number(input.interval);
    if (![1, 5, 15, 30, 60].includes(interval)) throw new Error('확인 간격을 선택하세요.');
    configuring = true;
    try {
      await operate(connection, (store, signal) => store.list(remote, signal));
      connection.abort.signal.throwIfAborted();
      separateFolder({ local: input.local, source: 'nas' }, settings.areas);
      const changed = settings.remote !== remote || settings.local !== input.local;
      if (settings.remote !== remote) delete settings.integrityKey;
      const launch = input.launchAtLogin === true;
      if (app.isPackaged && launch !== db.launchAtLogin) {
        app.setLoginItemSettings({
          openAtLogin: launch,
          ...(process.platform === 'win32' ? { name: 'SonacLauncher' } : {})
        });
      }
      Object.assign(settings, { remote, local: input.local, interval, automatic: input.automatic === true });
      db.launchAtLogin = launch;
      if (changed) {
        delete settings.integrityRevision;
        settings.last = null;
        connection.sync = null;
      }
      await persist();
      installTray();
      scheduleSync(true);
      scheduleAreas();
      publish();
      return status();
    } finally {
      configuring = false;
    }
  });
  bind('sync', () => {
    needConnection();
    if (!workspace().remote || !workspace().local) throw new Error('먼저 동기화 폴더를 선택하세요.');
    if (layoutJob || configuring) throw new Error('설정을 저장한 뒤 다시 시도하세요.');
    return runSync(true);
  });
  bind('layout', async input => {
    const connection = needConnection();
    const settings = workspace(connection);
    const value = cleanLayout(input);
    if (syncJob || layoutJob || configuring) throw new Error('진행 중인 작업이 끝난 뒤 런처 구성을 저장하세요.');
    layoutJob = (async () => {
      const target = settings.remote;
      if (target && connection.remoteWrites && await confirmChange(connection, {
        title: '런처 구성 게시', message: 'GitHub 바로가기 설정을 NAS에 게시할까요?',
        detail: connection.profile.url + '\n' + target + '/' + LAYOUT_FILE,
        action: '게시'
      })) {
        requireRemoteWrites(connection);
        await operate(connection, (store, signal) => store.upload(target, LAYOUT_FILE,
          new Blob([JSON.stringify(value, null, 2)]), { overwrite: true, signal }));
      }
      connection.abort.signal.throwIfAborted();
      settings.layout = value;
      await persist();
      publish();
    })();
    try {
      await layoutJob;
      return status();
    } finally {
      layoutJob = null;
    }
  });
  bind('upload', async folder => {
    const connection = needConnection();
    requireRemoteWrites(connection);
    const location = remotePath(folder);
    if (location === '/' && connection.profile.provider === 'synology') throw new Error('업로드할 공유 폴더를 선택하세요.');
    const result = await dialog.showOpenDialog(window, { title: '업로드할 파일 선택', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return null;
    if (!await confirmChange(connection, {
      title: 'NAS 파일 업로드', message: result.filePaths.length + '개 파일을 NAS에 업로드할까요?',
      detail: connection.profile.url + '\n' + location + '\n\n' + result.filePaths.slice(0, 5).map(file => path.basename(file)).join('\n'),
      action: '업로드'
    })) return null;
    const errors = [];
    const progress = transferReporter(connection, 'upload');
    let uploaded = 0;
    for (const filename of result.filePaths) {
      connection.abort.signal.throwIfAborted();
      const name = path.basename(filename);
      try {
        requireRemoteWrites(connection);
        fileName(name);
        if ([LAYOUT_FILE, manifestName].includes(name.toLowerCase())) throw new Error('동기화 제어 파일은 업로드할 수 없습니다.');
        if (!(await fs.lstat(filename)).isFile()) throw new Error('일반 파일만 업로드할 수 있습니다.');
        const blob = await openAsBlob(filename);
        await operate(connection, (store, signal) => store.upload(location, name, blob, { signal, progress }));
        uploaded++;
      } catch (error) {
        errors.push(name + ' · ' + displayError(error));
      }
    }
    return { uploaded, errors };
  });
  bind('mkdir', async (folder, input) => {
    const connection = needConnection();
    requireRemoteWrites(connection);
    const location = remotePath(folder);
    const name = fileName(typeof input === 'string' && input.length <= 255 ? input.trim() : '');
    if (location === '/' || [LAYOUT_FILE, manifestName].includes(name.toLowerCase())) {
      throw new Error('공유 폴더 안에서 사용할 폴더 이름을 확인하세요.');
    }
    if (!await confirmChange(connection, {
      title: 'NAS 폴더 만들기', message: '새 폴더를 만들까요?',
      detail: connection.profile.url + '\n' + location + '/' + name, action: '폴더 만들기'
    })) return false;
    requireRemoteWrites(connection);
    await operate(connection, (store, signal) => store.mkdir(location, name, signal));
    return true;
  });
  bind('download', async (folder, paths) => {
    const connection = needConnection();
    const { entries } = await selectedEntries(connection, 'remote', folder, paths);
    const defaultPath = workspace(connection).local || app.getPath('downloads');
    const [file] = entries;
    const transfer = transferReporter(connection, 'download');
    if (entries.length === 1 && !file.directory) {
      fileName(file.name);
      const result = await dialog.showSaveDialog(window, {
        title: '다운로드 위치 선택', defaultPath: path.join(defaultPath, file.name)
      });
      if (result.canceled || !result.filePath) return null;
      const root = await fs.realpath(path.dirname(result.filePath));
      const destination = path.join(root, fileName(path.basename(result.filePath)));
      await operate(connection, (store, signal) => downloadFile(store, file, destination, { replace: true, signal, root, transfer }));
      return { downloaded: 1, skipped: 0, errors: 0 };
    }
    const result = await dialog.showOpenDialog(window, {
      title: '선택한 항목을 저장할 폴더', defaultPath, properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return null;
    const store = {
      list: location => operate(connection, (client, signal) => client.list(location, signal)),
      download: location => operate(connection, (client, signal) => client.download(location, signal))
    };
    return downloadSelection(store, entries, await fs.realpath(result.filePaths[0]), connection.abort.signal, transfer);
  });
  bind('delete', async (source, folder, paths) => {
    const connection = needConnection();
    if (!['local', 'remote'].includes(source) ||
        (source === 'remote' && connection.profile.provider === 'synology' && remotePath(folder) === '/')) {
      throw new Error('공유 폴더 안에서 삭제할 항목을 선택하세요.');
    }
    if (source === 'remote') requireRemoteWrites(connection);
    const { entries, directory, root } = await selectedEntries(connection, source, folder, paths);
    const names = entries.slice(0, 5).map(entry => entry.name).join('\n') +
      (entries.length > 5 ? '\n외 ' + (entries.length - 5) + '개' : '');
    const description = source === 'remote'
      ? '저장소에서 삭제합니다. 폴더를 선택하면 내부 파일도 함께 삭제됩니다.'
      : '이 PC의 휴지통으로 이동합니다.' + (workspace(connection).local ? ' 저장소에 남아 있는 파일은 다시 동기화될 수 있습니다.' : '');
    if (!await confirmChange(connection, {
      title: '항목 삭제', message: '선택한 ' + entries.length + '개 항목을 삭제할까요?',
      detail: (source === 'remote' ? connection.profile.url + '\n' + folder : directory) + '\n\n' + names + '\n\n' + description,
      action: '삭제'
    })) return null;
    const latest = await selectedEntries(connection, source, folder, paths);
    const before = new Map(entries.map(entry => [entry.path, entry]));
    if (latest.directory !== directory || latest.entries.some(entry =>
      ['directory', 'size', 'modified', 'identity'].some(key => entry[key] !== before.get(entry.path)?.[key]))) {
      throw new Error('확인하는 동안 파일이 변경되었습니다. 새로고침 후 다시 선택하세요.');
    }
    const result = { deleted: 0, errors: [] };
    for (const entry of entries) {
      connection.abort.signal.throwIfAborted();
      try {
        if (source === 'local') {
          if (!await guardedFolder(root, directory)) throw new Error('저장 폴더를 찾을 수 없습니다.');
          await shell.trashItem(path.join(directory, entry.name));
        } else {
          requireRemoteWrites(connection);
          await operate(connection, (store, signal) => store.delete(entry, signal));
        }
        result.deleted++;
      } catch (error) {
        result.errors.push(entry.name + ' · ' + displayError(error));
      }
    }
    return result;
  });
  bind('preview', async (id, source, folder, item) => {
    const connection = needConnection();
    if (!/^[\da-f-]{36}$/iu.test(id) || !['local', 'remote'].includes(source)) {
      throw new Error('미리 볼 파일을 선택하세요.');
    }
    const { entries: [entry], directory, root } = await selectedEntries(connection, source, folder, [item]);
    if (directory && !await guardedFolder(root, directory)) throw new Error('저장 폴더를 찾을 수 없습니다.');
    return createPreview(id, entry, {
      signal: connection.abort.signal,
      filename: directory ? path.join(directory, entry.name) : undefined,
      download: directory ? undefined : abort => operate(connection, (store, signal) =>
        store.download(entry.path, AbortSignal.any([abort, signal])))
    });
  });
  bind('closePreview', clearPreview);
  bind('openLink', async action => {
    const connection = needConnection();
    if (action === 'githubToken') {
      return shell.openExternal('https://github.com/settings/personal-access-tokens/new?name=sonac%20launcher&contents=read&metadata=read');
    }
    if (action !== 'githubShortcut') throw new Error('지원하지 않는 바로가기입니다.');
    const url = new URL(workspace(connection).layout.links.github);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) {
      throw new Error('GitHub 바로가기에는 쿼리가 없는 github.com HTTPS 주소를 사용하세요.');
    }
    await shell.openExternal(url.href);
  });
  bind('terminal', async () => {
    needConnection();
    if (activePrompt) throw new Error('열려 있는 확인창을 먼저 닫으세요.');
    if (terminalView) {
      terminalView.webContents.focus();
      return;
    }
    const view = terminalView = new WebContentsView({
      webPreferences: { partition: 'terminal', preload: path.join(__dirname, 'terminal-preload.js'),
        sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !app.isPackaged }
    });
    secureWindow(view);
    view.webContents.once('render-process-gone', () => { if (terminalView === view) closeTerminal(); });
    view.setBackgroundColor('#0e0f12');
    window.contentView.addChildView(view);
    layoutPages();
    publish();
    try {
      await view.webContents.loadURL(terminalPage);
      if (terminalView === view) view.webContents.focus();
    } catch (error) {
      if (terminalView !== view) return;
      closeTerminal();
      throw error;
    }
  });
  bind('terminalHome', () => {
    const view = terminalView;
    setImmediate(() => {
      if (terminalView !== view) return;
      closeTerminal();
      window.webContents.focus();
    });
  }, 'terminal');
  bind('terminalCommands', () => db.terminalCommands ?? [], 'terminal');
  bind('terminalCommandSave', ({ id, name, category, command }) => {
    name = typeof name === 'string' ? name.trim() : '';
    category = typeof category === 'string' ? category.trim().normalize('NFC') : '';
    if (!name || name.length > 60 || category.length > 40 || /\p{Cc}/u.test(name + category)) {
      throw new Error('이름은 60자, 분류는 40자 이내로 입력하세요.');
    }
    if (typeof command !== 'string' || !command.trim() || command.length > 4096 || /[\p{Cc}\u2028\u2029]/u.test(command)) {
      throw new Error('명령어를 4,096자 이내의 한 줄로 입력하세요.');
    }
    const commands = db.terminalCommands ?? [];
    const index = commands.findIndex(item => item.id === id);
    if (id && index < 0) throw new Error('저장한 명령어를 찾을 수 없습니다.');
    if (!id && commands.length >= 100) throw new Error('명령어를 최대 100개까지 저장할 수 있습니다.');
    const saved = { id: id || randomUUID(), name, category, command };
    const next = [...commands];
    if (index < 0) next.push(saved);
    else next[index] = saved;
    return saveTerminalCommands(next);
  }, 'terminal');
  bind('terminalCommandRemove', id => {
    const commands = db.terminalCommands ?? [];
    return saveTerminalCommands(commands.filter(item => item.id !== id));
  }, 'terminal');
  bind('terminalStart', (cols, rows) => {
    needConnection();
    if (terminalSession) return;
    terminalSize(cols, rows);
    const native = require(app.isPackaged ? path.join(process.resourcesPath, 'node_modules', 'node-pty') : 'node-pty');
    const windows = process.platform === 'win32';
    const executable = windows ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/zsh';
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|LANG|LC_.*|SHELL|TMP|TMPDIR|TEMP|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PATHEXT|HOMEDRIVE|HOMEPATH)$/iu.test(key)));
    const pty = terminalSession = native.spawn(executable, windows ? ['-NoLogo'] : ['-l'], {
      name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...env, TERM: 'xterm-256color' }
    });
    pty.onData(data => {
      if (terminalSession === pty) terminalView?.webContents.send('launcher:terminal', { data });
    });
    pty.onExit(({ exitCode }) => {
      if (terminalSession !== pty) return;
      terminalSession = undefined;
      terminalView?.webContents.send('launcher:terminal', { exitCode });
    });
  }, 'terminal');
  bind('terminalWrite', data => {
    if (terminalSession && typeof data === 'string' && data.length <= 65536) terminalSession.write(data);
  }, 'terminal');
  bind('terminalResize', (cols, rows) => {
    if (!terminalSession) return;
    terminalSize(cols, rows);
    terminalSession.resize(cols, rows);
  }, 'terminal');
}

async function finishQuit() {
  try {
    if (restartForUpdate) await updater?.install(true);
  } catch {
    if (restartForUpdate) {
      quitting = false;
      restartForUpdate = false;
      applyingUpdate = false;
      publish();
      await showError('업데이트를 적용할 수 없습니다', '앱이 설치된 폴더의 쓰기 권한을 확인하세요.');
      return;
    }
  }
  updater?.stop();
  closePrompt();
  clearInterval(networkTimer);
  clearTimeout(timer);
  clearTimeout(areaTimer);
  loginController?.abort();
  current?.abort.abort();
  await Promise.allSettled(areaJobs.values());
  closeTerminal();
  await clearPreview();
  await current?.store.logout();
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void finishQuit();
  });
  app.whenReady().then(async () => {
    secureSession('launcher', 'app');
    secureSession('terminal', 'terminal');
    secureSession('prompt', 'prompt');
    registerHandlers();
    db = await readDB();
    if (process.platform === 'darwin') {
      const menu = Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, {
        label: '보기', submenu: [{
          id: 'menu-bar-icon', label: '메뉴 막대 아이콘 표시', type: 'checkbox', checked: !db.hideMenuBarIcon,
          click: item => void setMenuBarIcon(item.checked)
        }]
      }, { role: 'windowMenu' }]);
      menuBarItem = menu.getMenuItemById('menu-bar-icon');
      Menu.setApplicationMenu(menu);
      app.dock.setIcon(path.join(__dirname, 'ui', 'dock.png'));
    }
    void restore();
    showWindow();
    updater = createUpdater({
      version: releaseVersion, channel: updateChannel, publicKey: app.isPackaged ? updatePublicKey : null,
      repository: updateRepository,
      publish(value) { update = value; publish(); }
    });
    updater.start();
    networkOnline = net.isOnline();
    networkTimer = setInterval(() => void monitorNetwork(), 3000);
    powerMonitor.on('resume', () => {
      retryNetworkSoon(0);
      void monitorNetwork();
      updater.check();
    });
  }).catch(async error => {
    await showError('런처를 시작할 수 없습니다', displayError(error)).catch(() => {});
    app.quit();
  });
}
