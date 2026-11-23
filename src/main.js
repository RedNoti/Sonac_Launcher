'use strict';

const { app, BrowserWindow, Menu, Tray, WebContentsView, dialog, ipcMain, nativeImage, net, powerMonitor, protocol, safeStorage, session, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { setTimeout: delay } = require('node:timers/promises');
const { storage, endpoint, remotePath, childPath, openAsBlob, networkFailure } = require('./storage');
const { certificatePin } = require('./transport');
const { profileBinding, wrapped, seal, unseal } = require('./credentials');
const { LAYOUT_FILE, cleanLayout, pullFiles, scanMissing, downloadFile, downloadSelection, guardedFolder } = require('./sync');
const { origin, createPreview, clearPreview, compatibleVideo, serve } = require('./preview');
const { createUpdater, windowsInstallNotice } = require('./updater');
const { signInWithEmail, refreshLauncherSession } = require('./launcher-auth');
const exaone = require('./exaone');
const { extractAttachment, withAttachments, fileLimit, textLimit, attachmentLimit } = require('./ai-attachments');
const { scanMediaFolders, musicTags, coverFile, readArtwork } = require('./music-library');
const reports = require('./server-reports');
const deployment = require('./server-deployment');
const { manifestName } = require('./nas-integrity');
const github = require('./github');
const { fileName, syncExternal } = require('./areas');

const { productName, version, releaseVersion = version, updatePublicKey, updateRepository, updateChannel,
  firebaseConfig: bundledFirebaseConfig } = require('../package.json');
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
const defaultExaoneRelay = 'https://sonacai.o-r.kr';
const defaultLayout = { version: 1, links: {}, shortcuts: [] };
const usageModes = new Set(['nas', 'server', 'both']);
const sessionErrors = new Set([106, 107, 119]);
const updateBlockingHandlers = new Set(['login', 'logout', 'settings', 'upload', 'download', 'delete',
  'githubConnect', 'githubDisconnect', 'githubTrack', 'areaGroupSave', 'areaGroupRemove', 'areaGroupMove', 'folderFavorite',
  'areaSave', 'areaRemove', 'areaRun', 'syncAll', 'remoteWrites', 'switchNas', 'mkdir', 'renameFile', 'extractArchive', 'moveNas',
  'serverFileAdd', 'serverFileRemove', 'serverDeploy', 'serverRun', 'serverStop', 'serverGitHubConnect', 'serverGitHubDisconnect',
  'serverMonitorSettings', 'serverMonitorTarget', 'serverMonitorCheck', 'mediaFolder', 'setPreference',
  'terminalCommandSave', 'terminalCommandRemove', 'aiManageChat']);
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
let restartForUpdate = false;
const terminalSessions = new Map();
const terminalTabLimit = 8;
let terminalView;
let activePrompt;
let serverAuthAttempt;
let serverSession;
let serverAuthTimer;
let serverEnding;
let serverRestoring = false;
let serverAuthError = '';
let pendingUsageMode;
let aiChatJob;
let aiTitleJob;
let aiHistoryWrite;
let aiManageChatBusy = false;

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
  const { workspaces } = connection.nas;
  workspaces[key] ??= { remote: '', local: '', interval: 5, automatic: true, layout: defaultLayout, last: null };
  const settings = workspaces[key];
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
    if (parsed.version === 1 && (parsed.workspaces || parsed.launcherNas)) {
      if (!parsed.launcherNas) {
        if (!Array.isArray(parsed.connections)) parsed.connections = parsed.profile?.provider === 'synology' ?
          [{ profile: parsed.profile, remembered: parsed.remembered }] : [];
        delete parsed.remembered;
        if (parsed.profile?.provider !== 'synology') parsed.profile = null;
      }
      return parsed;
    }
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  return { version: 1, profile: null, connections: [], launchAtLogin: false, workspaces: {} };
}

async function migrateNasSettings() {
  if (!db.launcherNas || Array.isArray(db.connections)) return;
  const scopes = Object.entries(db.launcherNas);
  if (wrapped(db.launcherRemembered) && scopes.length > 1) {
    try {
      const config = await serverFirebaseConfig();
      const { uid } = await unseal(safeStorage, db.launcherRemembered, serverBinding(config));
      const key = createHash('sha256').update(JSON.stringify([config.projectId || config.apiKey, uid])).digest('hex');
      const index = scopes.findIndex(([id]) => id === key);
      if (index > 0) scopes.unshift(...scopes.splice(index, 1));
    } catch {
      // Saved NAS profiles remain available if the old Firebase session cannot be read.
    }
  }
  const profiles = new Map();
  const workspaces = {};
  const preferred = scopes.find(([, scope]) => scope.profile)?.[1];
  for (const [, scope] of scopes) {
    for (const record of scope.connections ?? []) {
      const key = accountKey(record.profile);
      if (!profiles.has(key)) profiles.set(key, record);
    }
    for (const [key, settings] of Object.entries(scope.workspaces ?? {})) {
      if (!Object.hasOwn(workspaces, key)) workspaces[key] = settings;
    }
  }
  db.profile = preferred?.profile ?? null;
  db.autoLoginPaused = preferred?.autoLoginPaused === true;
  db.connections = [...profiles.values()];
  db.workspaces = workspaces;
  if (scopes.length === 1 && /^[a-f0-9]{64}$/u.test(scopes[0][0]) && profiles.size === 1) {
    db.nasAiLegacy = { [profiles.keys().next().value]: scopes[0][0] };
  }
  await persist();
}

function savedConnection(profile, nas = db) {
  return profile && nas?.connections.find(record => accountKey(record.profile) === accountKey(profile));
}

async function writeJson(filename, data) {
  const temp = filename + '.' + randomUUID() + '.tmp';
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function persist() {
  const filename = path.join(app.getPath('userData'), 'settings.json');
  const data = JSON.stringify(db);
  writeQueue = writeQueue.catch(() => {}).then(() => writeJson(filename, data));
  return writeQueue;
}

function status() {
  const { github: account, ...settings } = current ? workspace() : {};
  const session = serverSession;
  const aiAccount = current || session;
  return {
    packaged: app.isPackaged,
    versionLabel: (app.isPackaged ? updateChannel ?? 'R' : '') + releaseVersion,
    usageMode: usageModes.has(db?.usageMode) ? db.usageMode : null,
    profile: current?.profile || db?.profile,
    connected: !!current,
    connecting: connecting || restoringLogin,
    restoringLogin,
    serverRestoring,
    serverAuthError,
    applyingUpdate,
    restartingUpdate: restartForUpdate,
    terminalOpen: !!terminalView,
    serverUpdaterAccount: session && serverModeEnabled() ? {
      email: session.email,
      githubLogin: serverGitHubAccount(session)?.login,
      files: (Object.hasOwn(db.serverFiles ?? {}, session.uid) ? db.serverFiles[session.uid] : []).map(file => ({
        id: file.id, name: file.name, url: file.url, installed: file.deployment?.tag, updatedAt: file.deployment?.updatedAt,
        updating: session.deployments.get(file.id)?.operation === 'downloading',
        phase: session.deployments.get(file.id)?.phase || (file.deployment ? 'stopped' : 'new')
      })),
      monitoring: serverMonitoringStatus(session)
    } : null,
    serverRemembered: wrapped(db?.launcherRemembered),
    aiEmail: session?.email,
    aiUsage: aiAccount ? { rateLimit: aiAccount.rateLimit, tokens: aiAccount.tokens } : null,
    nasProfiles: db?.connections.map(({ profile, remembered }) => ({
      ...profile, id: accountKey(profile), saved: wrapped(remembered)
    })) || [],
    loginError,
    device,
    launchAtLogin: !!db?.launchAtLogin,
    trayVisible: !!tray,
    settings: current ? { ...settings, remoteWrites: current.remoteWrites } : null,
    github: wrapped(account?.token) ? { login: account.login, tracked: account.tracked } : null,
    runningAreas: [...areaJobs.keys()],
    syncingAll: !!current?.syncingAll,
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
  const visible = db.hideMenuBarIcon === undefined ? !!shouldKeepRunning : !db.hideMenuBarIcon;
  if (menuBarItem) menuBarItem.checked = visible;
  if (!visible) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (!tray) {
    const trayImage = mac ? path.join(__dirname, 'ui', 'tray.png') : iconPath;
    const icon = nativeImage.createFromPath(trayImage).resize({ width: 18, height: 18 });
    if (mac) icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip(productName);
    if (!mac) tray.on('double-click', showWindow);
  }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'sonac launcher 열기', click: showWindow },
    { label: '지금 동기화', enabled: !!settings, click: () => { void runSync(true); void runAutomaticAreas(); } },
    { label: (mac ? '메뉴 막대' : '시스템 트레이') + ' 아이콘 숨기기', click: () => {
      if (!mac && !window?.isVisible()) showWindow();
      void setMenuBarIcon(false);
    } },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
}

async function setMenuBarIcon(visible) {
  try {
    await setPreference('trayVisible', visible);
  } catch (error) {
    installTray();
    await showError('아이콘 표시 설정 저장 실패', displayError(error));
  }
}

function setLaunchAtLogin(enabled) {
  if (app.isPackaged && enabled !== !!db.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { name: 'SonacLauncher' } : {}) });
  }
  db.launchAtLogin = enabled;
}

async function setPreference(name, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('설정 값을 확인하세요.');
  const automatic = name === 'automaticSync';
  const settings = automatic ? workspace(needConnection()) : db;
  const key = automatic ? 'automatic' : name === 'trayVisible' ? 'hideMenuBarIcon' : 'launchAtLogin';
  if (!automatic && name !== 'trayVisible' && name !== 'launchAtLogin') throw new Error('설정을 찾을 수 없습니다.');
  const previous = settings[key];
  const value = name === 'trayVisible' ? !enabled : enabled;
  try {
    if (name === 'launchAtLogin') setLaunchAtLogin(enabled);
    else settings[key] = value;
    await persist();
  } catch (error) {
    if (settings[key] === value) {
      if (name === 'launchAtLogin') setLaunchAtLogin(!!previous);
      settings[key] = previous;
    }
    throw error;
  }
  installTray();
  if (automatic) scheduleSync(enabled);
  publish();
  return status();
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
  if (!online || recoveringNetwork || applyingUpdate || connecting || restoringLogin || (serverSession && serverModeEnabled() && !current) || serverAuthAttempt || quitting ||
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
  const nas = db;
  if (applyingUpdate) throw new Error('업데이트가 끝난 뒤 로그인하세요.');
  if (connecting || current || (serverSession && nas.usageMode === 'server') || serverAuthAttempt || quitting) {
    throw new Error('이미 로그인 중이거나 앱을 종료하는 중입니다.');
  }
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
    nas.profile = profile;
    nas.autoLoginPaused = false;
    const saved = edited || savedConnection(profile, nas);
    if (saved) Object.assign(saved, { profile, remembered });
    else nas.connections.push({ profile, remembered });
    current = { profile, nas, store, secret: renewed, remember, remoteWrites: true, abort: new AbortController(), sync: null,
      reconnect: null, pickedAreaFolders: new Set() };
    restorePending = false;
    networkRetryDelay = 3000;
    networkRetryAt = Infinity;
    workspace();
    await persist();
    controller.signal.throwIfAborted();
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

async function rememberedSecret(profile, nas) {
  const secret = await unseal(safeStorage, savedConnection(profile, nas)?.remembered, profileBinding(profile));
  if (typeof secret?.password !== 'string' || !secret.password) throw new Error('다시 로그인하세요.');
  return secret;
}

async function restore() {
  const nas = db;
  if (pendingUsageMode || (nas.usageMode !== 'nas' && nas.usageMode !== 'both')) return;
  const saved = savedConnection(nas?.profile, nas);
  if (nas?.autoLoginPaused || !saved?.remembered) return;
  restoringLogin = true;
  publish();
  try {
    if (!wrapped(saved.remembered)) {
      saved.remembered = null;
      await persist();
      throw new Error('저장된 로그인 보호 방식이 바뀌었습니다. 비밀번호를 다시 입력하세요.');
    }
    const secret = await rememberedSecret(nas.profile, nas);
    await connect(nas.profile, secret, '', true, { restoring: true });
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

async function aiConnection() {
  const directory = app.isPackaged ? app.getPath('userData') : app.getAppPath();
  const filename = process.env.SONAC_EXAONE_CONFIG || path.join(directory, 'exaone-config.json');
  const config = await fs.readFile(filename, 'utf8').then(JSON.parse).catch(() => null);
  const relayUrl = process.env.SONAC_EXAONE_RELAY_URL || config?.relayUrl || defaultExaoneRelay;
  return exaone.relayEndpoint(relayUrl, needAiSession().idToken);
}

async function saveAiHistory(history, chats) {
  aiHistoryWrite = writeJson(history.filename, JSON.stringify(chats));
  try {
    await aiHistoryWrite;
    history.chats = chats;
  } catch {
    throw new Error('AI 대화를 이 PC에 저장할 수 없습니다.');
  } finally {
    aiHistoryWrite = undefined;
  }
}

function requireRemoteWrites(connection) {
  connection.abort.signal.throwIfAborted();
  if (!connection.remoteWrites) throw new Error('설정에서 NAS 쓰기를 먼저 허용하세요.');
}

function transferReporter(connection, direction, items) {
  let previousName;
  let currentIndex = -1;
  let sentItems = false;
  let started;
  let lastSent;
  return (name, bytes, total, index, status, error) => {
    if (current !== connection || !window || window.isDestroyed()) return;
    const now = performance.now();
    if (name !== previousName || bytes === 0) {
      if (index === undefined) currentIndex++;
      previousName = name;
      started = now;
      lastSent = -Infinity;
    }
    if (!status && now - lastSent < 120 && bytes !== total) return;
    lastSent = now;
    window.webContents.send('launcher:transfer', { name, direction, bytes, total, index: index ?? currentIndex, status, error, items: sentItems ? undefined : items,
      elapsed: (now - started) / 1000,
      rate: bytes / Math.max(0.05, (now - started) / 1000) });
    sentItems = true;
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
  if (pauseAutoLogin) connection.nas.autoLoginPaused = true;
  if (forget) {
    const saved = savedConnection(connection.profile, connection.nas);
    if (saved) saved.remembered = null;
  }
  aiChatJob?.abort();
  aiTitleJob?.controller.abort();
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
  if (repository) github.repositoryPath(repository);
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

function droppedLocalPaths(input, limit) {
  if (!Array.isArray(input) || !input.length || input.length > limit ||
      input.some(file => typeof file !== 'string' || file.length > 4096 || !path.isAbsolute(file) || file.includes('\0'))) {
    throw new Error('한 번에 놓을 수 있는 파일은 최대 ' + limit + '개입니다.');
  }
  return [...new Set(input)];
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

function writableName(input) {
  const name = fileName(typeof input === 'string' && input.length <= 255 ? input : '');
  if ([LAYOUT_FILE, manifestName].includes(name.toLowerCase())) throw new Error('동기화 제어 파일 이름은 사용할 수 없습니다.');
  return name;
}

async function requireUnusedName(store, folder, name, signal, originalPath) {
  const key = name.normalize('NFC').toLowerCase();
  if ((await store.list(folder, signal)).some(item => item.path !== originalPath &&
      item.name.normalize('NFC').toLowerCase() === key)) {
    throw new Error('같은 이름의 파일 또는 폴더가 이미 있습니다.');
  }
}

async function uploadExtractedFiles(connection, directory, folder) {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    requireRemoteWrites(connection);
    const local = path.join(directory, item.name);
    if (item.isDirectory()) {
      await operate(connection, (store, signal) => store.mkdir(folder, item.name, signal));
      await uploadExtractedFiles(connection, local, childPath(folder, item.name));
    } else {
      const blob = await openAsBlob(local);
      await operate(connection, (store, signal) => store.upload(folder, item.name, blob, { signal }));
    }
  }
}

async function extractOnSynology(connection, location, entry, name) {
  const report = transferReporter(connection, 'extract');
  let staging;
  if (name) {
    const stagingName = 'sonac-extract-' + randomUUID();
    await operate(connection, (store, signal) => store.mkdir(location, stagingName, signal));
    staging = { path: childPath(location, stagingName), directory: true };
  }
  let task;
  try {
    requireRemoteWrites(connection);
    task = await operate(connection, (store, signal) => store.startExtract(entry.path, staging?.path ?? location, signal));
    report(entry.name, 0, null);
    while (true) {
      const status = await operate(connection, (store, signal) => store.extractStatus(task, signal));
      if (status.finished) {
        task = undefined;
        break;
      }
      const percent = Number.isFinite(status.progress) && status.progress >= 0
        ? Math.round(status.progress * 100) : null;
      report(entry.name, percent ?? 0, percent === null ? null : 100);
      await delay(1000, undefined, { signal: connection.abort.signal });
    }
    if (staging) {
      await operate(connection, async (store, signal) => {
        await requireUnusedName(store, location, name, signal);
        requireRemoteWrites(connection);
        await store.rename(location, staging, name, signal);
      });
      staging = undefined;
    }
    return name;
  } finally {
    if ((task || staging) && !connection.abort.signal.aborted && connection.remoteWrites) {
      await operate(connection, async (store, signal) => {
        if (task) await store.stopExtract(task, signal);
        if (staging) await store.delete(staging, signal);
      }).catch(() => {});
    }
  }
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
  for (const id of terminalSessions.keys()) closeTerminalTab(id);
  if (!view) return;
  if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  publish();
}

function closeTerminalTab(id) {
  const pty = terminalSessions.get(id);
  terminalSessions.delete(id);
  try { pty?.kill(); } catch { /* process already ended */ }
}

function serverModeEnabled() {
  const mode = pendingUsageMode ?? db?.usageMode;
  return mode === 'server' || mode === 'both';
}

function needAiSession() {
  if (!serverSession || serverSession.expiresAt <= Date.now()) {
    throw new Error('AI 채팅에 다시 로그인하세요.');
  }
  return serverSession;
}

function needAiAccount() {
  const session = needAiSession();
  return current || session;
}

function needTerminalSession() {
  if (!current) needServerSession();
}

function needServerSession() {
  if (!serverModeEnabled() || !serverSession || serverSession.expiresAt <= Date.now()) {
    throw new Error('서버 업데이터에 다시 로그인하세요.');
  }
  return serverSession;
}

function serverFiles() {
  const { uid } = needServerSession();
  db.serverFiles ??= {};
  if (!Object.hasOwn(db.serverFiles, uid)) {
    Object.defineProperty(db.serverFiles, uid, { value: [], enumerable: true });
  }
  return db.serverFiles[uid];
}

function serverGitHubKey(session) {
  return JSON.stringify(['server-github', serverBinding(session.firebaseConfig), session.uid]);
}

function serverGitHubAccount(session) {
  return db.serverGitHub?.[serverGitHubKey(session)];
}

async function serverGitHubToken(session) {
  const account = serverGitHubAccount(session);
  const token = account ? await unseal(safeStorage, account.token, serverGitHubKey(session)) : undefined;
  session.abort.signal.throwIfAborted();
  return token;
}

function serverProject(id) {
  const session = needServerSession();
  const file = serverFiles().find(item => item.id === id);
  if (!file) throw new Error('연결한 배포 파일을 찾을 수 없습니다.');
  const account = createHash('sha256').update(monitoringBinding(session)).digest('hex');
  const root = path.join(app.getPath('userData'), 'server-deployments', account, file.id);
  const data = path.join(root, 'data');
  if (!session.deployments.has(id)) session.deployments.set(id, { log: '' });
  return { session, file, root, data, runtime: session.deployments.get(id) };
}

function runServerOperation(runtime, phase, operation) {
  if (applyingUpdate || runtime.task) throw new Error('진행 중인 작업이 끝난 뒤 다시 시도하세요.');
  runtime.phase = phase;
  runtime.operation = phase;
  runtime.task = Promise.resolve().then(operation).finally(() => {
    runtime.task = undefined;
    runtime.operation = undefined;
    publish();
  });
  publish();
  return runtime.task;
}

async function startDeployment(project, spec, phase = 'starting') {
  const { runtime } = project;
  runtime.phase = phase;
  publish();
  await deployment.startProcess(spec, project.data, runtime, (code, signal) => {
    if (runtime.phase === 'running') {
      runtime.phase = code === 0 && !signal ? 'stopped' : 'failed';
      publish();
    }
  });
  runtime.phase = runtime.child ? 'running' : 'failed';
}

async function stopDeployments(session) {
  if (!session) return;
  await Promise.allSettled([...session.deployments.values()].map(async runtime => {
    await runtime.task?.catch(() => {});
    await deployment.stopProcess(runtime);
  }));
}

async function deployRelease(project, assetId) {
  const { session, file, runtime, root, data } = project;
  const signal = session.abort.signal;
  const previous = file.deployment;
  const version = randomUUID();
  const stage = path.join(root, version);
  let extracted = false;
  let stoppedPrevious = false;
  let starting = false;
  let tag;
  const log = message => deployment.appendLog(runtime, '\n[런처] ' + message + '\n');
  try {
    const token = await serverGitHubToken(session);
    const assets = await deployment.releaseAssets(releaseFileUrl(file.url), signal, token);
    const asset = assets.find(item => item.id === assetId);
    if (!asset) throw new Error('릴리스가 바뀌었습니다. 배포 파일을 다시 선택하세요.');
    tag = asset.tag;
    log('배포 ZIP ' + tag + ' · ' + asset.name);
    const bytes = await deployment.downloadAsset(asset, signal, token);
    runtime.phase = 'extracting';
    publish();
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    await fs.mkdir(stage, { mode: 0o700 });
    await deployment.extractZip(bytes, stage, signal);
    extracted = true;
    log(tag + ' ZIP을 새 배포 폴더에 풀었습니다.');
    const spec = await deployment.launchSpec(stage);
    signal.throwIfAborted();
    if (runtime.child) {
      await deployment.stopProcess(runtime);
      stoppedPrevious = true;
    }
    signal.throwIfAborted();
    starting = true;
    await startDeployment(project, spec);
    signal.throwIfAborted();
    file.deployment = { version, tag: asset.tag, updatedAt: Date.now() };
    await persist();
    log(tag + ' 배포 완료');
  } catch (error) {
    const message = (tag ? tag + ' 배포 실패' : '배포 실패') + ' · ' + displayError(error);
    log(message);
    file.deployment = previous;
    if (starting) await deployment.stopProcess(runtime).catch(() => {});
    let retained = false;
    if (!previous && extracted && !signal.aborted) {
      file.deployment = { version, tag };
      try {
        await persist();
        retained = true;
        log('받은 파일은 배포 폴더에서 확인할 수 있습니다.');
      } catch {
        file.deployment = previous;
      }
    }
    if (!retained && (!runtime.child || !starting)) {
      await fs.rm(stage, { force: true, recursive: true }).catch(() => {});
    }
    runtime.phase = runtime.child && !starting ? 'running' : 'failed';
    if (stoppedPrevious && previous && !signal.aborted && !runtime.child) {
      try {
        const spec = await deployment.launchSpec(path.join(root, previous.version));
        await startDeployment(project, spec);
        if (runtime.phase === 'running') log('이전 버전 ' + previous.tag + '을 다시 실행했습니다.');
      } catch (rollbackError) {
        runtime.phase = 'failed';
        log('이전 버전 ' + previous.tag + ' 실행 실패 · ' + displayError(rollbackError));
      }
    }
    const result = previous && runtime.phase === 'running'
      ? ' 이전 버전 ' + previous.tag + '이 실행 중입니다.' : '';
    throw new Error(message + result, { cause: error });
  }
  if (previous) await fs.rm(path.join(root, previous.version), { force: true, recursive: true }).catch(() => {});
}

function monitoringSettings(session) {
  db.monitoring ??= {};
  if (!Object.hasOwn(db.monitoring, session.uid)) {
    Object.defineProperty(db.monitoring, session.uid, {
      value: { enabled: false, time: '09:00', targets: [], pending: [] }, enumerable: true
    });
  }
  return db.monitoring[session.uid];
}

function serverMonitoringStatus(session) {
  const settings = monitoringSettings(session);
  return {
    enabled: settings.enabled, time: settings.time, hasWebhook: wrapped(settings.webhook),
    deliveryEnabled: settings.deliveryEnabled ?? wrapped(settings.webhook), dailyReports: settings.dailyReports,
    targets: settings.targets.map(({ id, name, url, latest }) => ({ id, name, url,
      latest: latest && { status: latest.status, at: latest.at, latencyMs: latest.latencyMs, httpStatus: latest.httpStatus } })),
    checking: !!session.monitor?.poll, latestReport: settings.latestReport, error: session.monitor?.error || ''
  };
}

const monitoringBinding = session => JSON.stringify(['server-monitoring', serverBinding(session.firebaseConfig), session.uid]);

function stopServerMonitoring(session) {
  clearInterval(session?.monitor?.timer);
  session?.monitor?.controller.abort();
}

function startServerMonitoring(session) {
  stopServerMonitoring(session);
  const controller = new AbortController();
  const runtime = session.monitor = { controller, signal: AbortSignal.any([controller.signal, session.abort.signal]) };
  if (!monitoringSettings(session).enabled) return;
  const check = () => void runServerMonitoring(session, runtime);
  runtime.timer = setInterval(check, 60000);
  check();
}

async function persistMonitoringChange(session, rollback) {
  stopServerMonitoring(session);
  try { await persist(); }
  catch (error) { rollback(); throw error; }
  finally {
    if (serverSession === session) startServerMonitoring(session);
    publish();
  }
  return status();
}

async function runServerMonitoring(session, runtime, targetId) {
  const { signal } = runtime;
  if (runtime.poll || signal.aborted || session.expiresAt <= Date.now() || !net.isOnline()) return;
  const settings = monitoringSettings(session);
  const targets = targetId ? settings.targets.filter(target => target.id === targetId) : settings.targets;
  if (!targets.length) return;
  runtime.poll = true;
  publish();
  try {
    const checks = await Promise.all(targets.map(async target => [target, await reports.probeTarget(target, signal)]));
    signal.throwIfAborted();
    for (const [target, observation] of checks) {
      const incident = reports.recordObservation(target, observation);
      if (incident && settings.enabled) settings.pending.push(incident);
    }
    settings.pending = settings.pending.slice(-20);
    await persist();
    signal.throwIfAborted();
    if (settings.enabled && !runtime.report) void prepareServerMonitoringReport(session, runtime);
  } catch {
    if (!signal.aborted) {
      runtime.error = '모니터링 결과를 저장할 수 없습니다.';
      publish();
    }
  } finally {
    runtime.poll = false;
    if (!signal.aborted) publish();
  }
}

async function prepareServerMonitoringReport(session, runtime) {
  const { signal } = runtime;
  const settings = monitoringSettings(session);
  const window = reports.dailyReportWindow(Date.now(), settings.time);
  const daily = window && settings.lastDaily !== window.day ? settings.targets.flatMap(target => {
    const day = reports.summarizeDay(target.days?.[window.day]);
    return day ? [{ service: target.name, day, comparison: reports.summarizeDay(target.days?.[window.comparison]) }] : [];
  }) : [];
  const incident = settings.pending[0];
  if (!incident && !daily.length) return;
  runtime.report = true;
  try {
    const title = incident ? '서비스 이상 감지 · ' + incident.service : '서버 일일보고 · ' + window.day;
    const instruction = incident ? '이상 유형, 원인 후보와 확인할 항목을 3~5줄로 작성하세요.'
      : '전날 상태와 이전 날과의 차이, 주요 이벤트, 에러·경고 추세를 관측 범위에서 요약하세요.';
    const fallback = incident ? (incident.event ? '모니터링 주소가 장애 이벤트를 보고했습니다.' :
      '정상 이외 상태가 연속 ' + incident.consecutive + '회 감지됐습니다.') + ' HTTP 상태와 서버 로그를 확인하세요.'
      : daily.map(({ service, day }) => service + ' · 확인 ' + day.checks + '회, 장애 ' + day.down + '회, 경고 ' + day.degraded + '회').join('\n');
    let text;
    try {
      text = await reports.analyzeReport(await aiConnection(), instruction, incident || daily, signal);
    } catch {
      signal.throwIfAborted();
      text = fallback + '\nEXAONE 분석을 사용할 수 없어 관측 결과를 표시합니다.';
    }
    signal.throwIfAborted();
    const previousDaily = settings.lastDaily;
    const previousPending = settings.pending;
    const previousReport = settings.latestReport;
    const previousHistory = settings.dailyReports;
    if (incident) settings.pending = settings.pending.filter(item => item !== incident);
    else settings.lastDaily = window.day;
    const webhook = incident || settings.deliveryEnabled !== false ? settings.webhook : undefined;
    const report = { title, text: text.slice(0, 4000), at: Date.now(), delivery: wrapped(webhook) ? 'unconfirmed' : 'local' };
    if (!incident) {
      report.day = window.day;
      report.services = daily.length;
      report.down = daily.reduce((total, item) => total + item.day.down, 0);
      report.degraded = daily.reduce((total, item) => total + item.day.degraded, 0);
      const legacyDaily = /^서버 일일보고 · (\d{4}-\d{2}-\d{2})$/u.exec(previousReport?.title || '')?.[1];
      const history = previousHistory ?? (legacyDaily ? [{ ...previousReport, day: legacyDaily }] : []);
      settings.dailyReports = [report, ...history.filter(item => item.day !== report.day)].slice(0, 14);
    }
    settings.latestReport = report;
    try { await persist(); }
    catch (error) {
      settings.lastDaily = previousDaily;
      settings.pending = previousPending;
      settings.latestReport = previousReport;
      settings.dailyReports = previousHistory;
      throw error;
    }
    signal.throwIfAborted();
    runtime.error = '';
    if (wrapped(webhook)) {
      try {
        const url = await unseal(safeStorage, webhook, monitoringBinding(session));
        signal.throwIfAborted();
        await reports.sendDiscord(url, title, text, signal);
        report.delivery = 'sent';
      } catch {
        report.delivery = 'failed';
        if (!signal.aborted) runtime.error = 'Discord 전송 여부를 확인할 수 없습니다. 웹후크와 채널을 확인하세요.';
      }
      await persist();
    }
    if (!signal.aborted) publish();
  } catch {
    if (!signal.aborted) {
      runtime.error = '모니터링 보고서를 저장할 수 없습니다.';
      publish();
    }
  } finally {
    runtime.report = false;
  }
}

async function serverUpdaterLogout({ forget = false } = {}) {
  const session = serverSession;
  if (!session) return serverEnding;
  serverSession = undefined;
  aiChatJob?.abort();
  aiTitleJob?.controller.abort();
  if (!current) closeTerminal();
  stopServerMonitoring(session);
  session.abort.abort();
  clearTimeout(serverAuthTimer);
  const forgetSaved = forget && !!db.launcherRemembered;
  if (forgetSaved) delete db.launcherRemembered;
  serverEnding = Promise.all([stopDeployments(session), forgetSaved ? persist() : undefined]);
  publish();
  try {
    await serverEnding;
  } finally {
    serverEnding = undefined;
  }
}

function scheduleServerRefresh(session, retry = false) {
  const remaining = session.expiresAt - Date.now();
  serverAuthTimer = setTimeout(async () => {
    if (serverSession !== session) return;
    if (session.expiresAt <= Date.now()) {
      await serverUpdaterLogout().catch(() => {});
      return;
    }
    serverAuthTimer = setTimeout(() => {
      if (serverSession === session) void serverUpdaterLogout().catch(() => {});
    }, session.expiresAt - Date.now());
    try {
      const next = await refreshLauncherSession(session.firebaseConfig, session, session.abort.signal);
      if (serverSession !== session) return;
      clearTimeout(serverAuthTimer);
      const rotated = next.refreshToken !== session.refreshToken || next.email !== session.email;
      Object.assign(session, next);
      scheduleServerRefresh(session);
      if (session.remember && rotated) {
        await rememberServerSession(session.firebaseConfig, session, session.abort.signal).catch(() => {});
      }
      if (rotated && serverSession === session) publish();
    } catch (error) {
      if (serverSession !== session) return;
      if (error.code === 'auth/network-request-failed' && session.expiresAt > Date.now()) {
        clearTimeout(serverAuthTimer);
        scheduleServerRefresh(session, true);
      } else {
        await serverUpdaterLogout({ forget: error.cause === 'invalid-session' }).catch(() => {});
      }
    }
  }, retry ? Math.min(30000, remaining) : Math.max(1000, remaining - 300000));
}

async function serverFirebaseConfig() {
  let config;
  try {
    const override = process.env.SONAC_SERVER_AUTH_CONFIG;
    if (override) {
      config = JSON.parse(await fs.readFile(override, 'utf8')).firebaseConfig;
    } else if (app.isPackaged) {
      const filename = path.join(app.getPath('userData'), 'server-auth.json');
      const local = await fs.readFile(filename, 'utf8').then(JSON.parse).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      config = { ...bundledFirebaseConfig, ...local?.firebaseConfig };
    } else {
      config = require(path.join(__dirname, '..', 'firebase-config.cjs')).firebaseConfig;
    }
  } catch {
    throw new Error('Firebase 로그인 설정 파일을 읽을 수 없습니다.');
  }
  if (!/^[\w-]{20,120}$/u.test(config?.apiKey || '')) throw new Error('Firebase 웹 앱의 API 키를 확인하세요.');
  return config;
}

const serverBinding = config => JSON.stringify(['launcher-firebase', config.projectId || config.apiKey]);

async function rememberServerSession(config, { uid, email, refreshToken }, signal) {
  if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 8192) {
    throw new Error('Firebase에서 저장할 로그인 정보를 받지 못했습니다.');
  }
  const record = await seal(safeStorage, serverBinding(config), { uid, email, refreshToken });
  signal.throwIfAborted();
  db.launcherRemembered = record;
  await persist();
}

function activateServerSession(session, firebaseConfig, remember, signal) {
  signal.throwIfAborted();
  session.abort = new AbortController();
  session.deployments = new Map();
  session.firebaseConfig = firebaseConfig;
  session.remember = remember;
  serverSession = session;
  scheduleServerRefresh(session);
  if (serverModeEnabled()) startServerMonitoring(session);
  publish();
}

async function restoreServerSession(forAi = false) {
  if (forAi ? !current && !serverModeEnabled() : !serverModeEnabled() || current) return;
  if (!db.launcherRemembered || serverAuthAttempt || serverSession || serverEnding || connecting || restoringLogin || applyingUpdate) return;
  const controller = serverAuthAttempt = new AbortController();
  serverAuthError = '';
  serverRestoring = true;
  publish();
  try {
    const config = await serverFirebaseConfig();
    const saved = await unseal(safeStorage, db.launcherRemembered, serverBinding(config));
    const session = await refreshLauncherSession(config, saved ?? {}, controller.signal);
    if (session.refreshToken !== saved.refreshToken || session.email !== saved.email) {
      await rememberServerSession(config, session, controller.signal);
    }
    activateServerSession(session, config, true, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    serverAuthError = displayError(error);
    if (error.cause === 'invalid-session') {
      delete db.launcherRemembered;
      await persist().catch(() => {});
    }
  } finally {
    serverAuthAttempt = undefined;
    serverRestoring = false;
    publish();
  }
}

function releaseFileUrl(input) {
  const invalid = () => new Error('GitHub 릴리스 목록, 릴리스 태그 또는 파일 다운로드 주소를 입력하세요.');
  if (typeof input !== 'string' || input.length > 2048) throw invalid();
  const url = URL.parse(input.trim());
  if (url?.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) throw invalid();
  if (!/^\/[\w.-]+\/[\w.-]+\/releases(?:\/(?:latest(?:\/download\/[^/]+)?|tag\/[^/]+|download\/[^/]+\/[^/]+))?\/?$/u.test(url.pathname) ||
      /%(?:2f|5c)/iu.test(url.pathname)) throw invalid();
  return url.href;
}

let trashDataOnQuit = false;

function registerHandlers() {
  bind('uninstallMac', async () => {
    if (process.platform !== 'darwin' || !app.isPackaged || applyingUpdate || quitting) {
      throw new Error('설치된 macOS 앱에서 삭제할 수 있습니다.');
    }
    const bundle = path.resolve(process.execPath, '../../..');
    if (path.extname(bundle) !== '.app') throw new Error('앱의 설치 위치를 확인할 수 없습니다.');
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: '소낙 런처를 휴지통으로 이동할까요?',
      detail: '로컬 데이터에는 로그인, 설정, AI 대화와 서버 배포 데이터가 포함됩니다. 지정한 동기화·다운로드 폴더의 파일은 유지됩니다.',
      buttons: ['취소', '앱만 삭제', '앱 및 로컬 데이터 삭제'],
      defaultId: 0,
      cancelId: 0
    });
    if (response === 0) return;
    if (applyingUpdate || quitting) throw new Error('진행 중인 작업이 끝난 뒤 다시 시도하세요.');
    await shell.trashItem(bundle);
    app.setLoginItemSettings({ openAtLogin: false });
    trashDataOnQuit = response === 2;
    app.quit();
  });
  bind('setUsageMode', async (mode, preparing = false) => {
    if (preparing === true && mode === null) {
      pendingUsageMode = undefined;
      return status();
    }
    if (!usageModes.has(mode)) throw new Error('사용할 기능을 선택하세요.');
    const finishingSetup = preparing !== true && pendingUsageMode === mode;
    if ((!finishingSetup && (current || serverSession)) || connecting || restoringLogin || serverAuthAttempt || applyingUpdate) {
      throw new Error('연결 작업이 끝난 뒤 사용 모드를 변경하세요.');
    }
    if (preparing === true) {
      pendingUsageMode = mode;
      return status();
    }
    const previous = db.usageMode;
    db.usageMode = mode;
    try {
      await persist();
    } catch (error) {
      db.usageMode = previous;
      throw error;
    }
    pendingUsageMode = undefined;
    publish();
    return status();
  });
  bind('serverUpdaterRestore', async forAi => {
    await restoreServerSession(forAi === true);
    return status();
  });
  bind('serverUpdaterLogin', async credentials => {
    const forAi = credentials?.forAi === true;
    if (!serverModeEnabled() && !(forAi && current)) throw new Error('먼저 NAS에 로그인하세요.');
    if (serverAuthAttempt || serverSession || serverEnding) throw new Error('이전 세션이 끝난 뒤 로그인하세요.');
    if ((!forAi && current) || connecting || restoringLogin || applyingUpdate) throw new Error('다른 연결이 끝난 뒤 로그인하세요.');
    const { email, password, remember } = credentials ?? {};
    if (typeof email !== 'string' || !email.trim() || email.length > 254 ||
        typeof password !== 'string' || !password || password.length > 4096) {
      throw new Error('이메일 또는 비밀번호를 확인하세요.');
    }
    const controller = serverAuthAttempt = new AbortController();
    serverAuthError = '';
    try {
      const firebaseConfig = await serverFirebaseConfig();
      const session = await signInWithEmail({
        firebaseConfig, signal: controller.signal, email: email.trim(), password
      });
      if (remember === true) {
        await rememberServerSession(firebaseConfig, session, controller.signal);
      } else if (db.launcherRemembered) {
        delete db.launcherRemembered;
        await persist();
      }
      activateServerSession(session, firebaseConfig, remember === true, controller.signal);
      return status();
    } finally {
      serverAuthAttempt = undefined;
    }
  });
  bind('serverUpdaterLogout', async forget => {
    await serverUpdaterLogout({ forget: forget === true });
    return status();
  });
  bind('aiHistory', async () => {
    const connection = needAiAccount();
    await aiHistoryWrite?.catch(() => {});
    if ((current || serverSession) !== connection || !serverSession) throw new Error('AI 채팅에 다시 로그인하세요.');
    const id = connection.profile ? accountKey(connection.profile) : createHash('sha256').update(connection.uid).digest('hex');
    const directory = app.getPath('userData');
    const history = connection.chatHistory ??= { filename: path.join(directory, connection.profile ? 'nas-ai-history' : 'launcher-ai-history', id + '.json') };
    if (history.chats) return history.chats;
    const chats = await fs.readFile(history.filename, 'utf8').catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      const legacy = connection.profile && db.nasAiLegacy?.[id];
      if (!legacy) return '[]';
      return fs.readFile(path.join(directory, 'ai-history', legacy + '.json'), 'utf8').catch(error => {
        if (error.code === 'ENOENT') return '[]';
        throw error;
      });
    }).then(JSON.parse).catch(() => {
      throw new Error('이 PC에 저장된 AI 대화를 읽을 수 없습니다.');
    });
    if ((current || serverSession) !== connection || !serverSession) throw new Error('AI 채팅에 다시 로그인하세요.');
    if (!Array.isArray(chats)) throw new Error('이 PC에 저장된 AI 대화 형식을 확인하세요.');
    return history.chats ??= chats;
  });
  bind('aiManageChat', async (id, action, title) => {
    const account = needAiAccount();
    if (aiChatJob || aiManageChatBusy) throw new Error('진행 중인 작업이 끝난 뒤 대화를 수정하세요.');
    const name = typeof title === 'string' ? title.trim() : '';
    if (action !== 'delete' && (action !== 'rename' || !name || name.length > 80)) {
      throw new Error('대화 제목을 80자 이내로 입력하세요.');
    }
    aiManageChatBusy = true;
    try {
      const titleJob = aiTitleJob;
      titleJob?.controller.abort();
      await titleJob?.task.catch(() => {});
      if (needAiAccount() !== account) throw new Error('AI 채팅에 다시 로그인하세요.');
      const history = account.chatHistory;
      const index = history?.chats?.findIndex(chat => chat.id === id) ?? -1;
      if (index < 0) throw new Error('저장된 대화를 찾을 수 없습니다.');
      const next = history.chats.slice();
      if (action === 'delete') next.splice(index, 1);
      else next[index] = { ...next[index], title: name, summarized: true };
      await saveAiHistory(history, next);
      return action === 'rename' ? name : null;
    } finally {
      aiManageChatBusy = false;
    }
  });
  let choosingAiFiles = false;
  bind('aiPickFiles', async dropped => {
    const account = needAiAccount();
    if (choosingAiFiles) return { files: [], errors: [] };
    choosingAiFiles = true;
    try {
      const result = dropped === undefined ? await dialog.showOpenDialog(window, {
        title: 'AI 채팅에 문서 또는 코드 첨부',
        properties: ['openFile', 'multiSelections']
      }) : { filePaths: droppedLocalPaths(dropped, attachmentLimit) };
      if (result.canceled) return { files: [], errors: [] };
      if (result.filePaths.length > attachmentLimit) throw new Error('파일은 한 번에 3개까지 첨부할 수 있습니다.');
      const files = [];
      const errors = [];
      for (const filename of result.filePaths) {
        const name = path.basename(filename).slice(0, 255);
        try {
          if (!(await fs.lstat(filename)).isFile()) throw new Error('일반 파일만 첨부할 수 있습니다.');
          const handle = await fs.open(filename, 'r');
          try {
            const info = await handle.stat();
            if (!info.isFile() || info.size > fileLimit) throw new Error('8 MiB 이하의 파일을 선택하세요.');
            const buffer = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < buffer.length) {
              const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
              if (!bytesRead) break;
              offset += bytesRead;
            }
            files.push(extractAttachment(name, buffer.subarray(0, offset)));
          } finally {
            await handle.close();
          }
        } catch (error) {
          errors.push(name + ' · ' + (error.code ? '파일을 읽을 수 없습니다.' : error.message));
        }
      }
      if (needAiAccount() !== account) throw new Error('AI 채팅에 다시 로그인하세요.');
      return { files, errors };
    } finally {
      choosingAiFiles = false;
    }
  });
  bind('aiChat', async (requestId, chatId, content, effort, attachments = []) => {
    const account = needAiAccount();
    if (aiChatJob || aiManageChatBusy) throw new Error('진행 중인 작업이 끝난 뒤 다시 보내세요.');
    if (!exaone.reasoningEfforts.includes(effort)) throw new Error('추론 강도를 확인하세요.');
    if (![requestId, chatId].every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/u.test(id)) ||
        typeof content !== 'string' || content.length > 12000 || !Array.isArray(attachments) ||
        (!content.trim() && !attachments.length) || attachments.length > attachmentLimit ||
        attachments.some(file => typeof file?.name !== 'string' || !file.name.trim() || file.name.length > 255 ||
          typeof file.text !== 'string' || !file.text.trim() || file.text.length > textLimit)) {
      throw new Error('보낼 메시지를 확인하세요.');
    }
    const controller = aiChatJob = new AbortController();
    const sendPhase = phase => {
      if (!controller.signal.aborted && (current || serverSession) === account && !!serverSession && window && !window.isDestroyed()) {
        window.webContents.send('launcher:aiPhase', requestId, phase);
      }
    };
    try {
      const titleJob = aiTitleJob;
      titleJob?.controller.abort();
      await titleJob?.task.catch(() => {});
      if (controller.signal.aborted || (current || serverSession) !== account || !serverSession) return null;
      const history = account.chatHistory;
      const chats = history?.chats;
      if (!chats) throw new Error('저장된 대화를 먼저 불러오세요.');
      const index = chats.findIndex(chat => chat.id === chatId);
      const previous = chats[index];
      const message = { role: 'user', content: content.trim(),
        ...(attachments.length ? { attachments: attachments.map(({ name, text }) => ({ name, text })) } : {}) };
      const context = [...(previous?.messages.slice(-30) ?? []), message]
        .map(turn => ({ role: turn.role, content: withAttachments(turn) }));
      while (context.reduce((length, turn) => length + turn.content.length, 0) > 180000) context.splice(0, 2);
      let partial = '';
      const result = await exaone.queuedChat(aiConnection, context, effort, controller.signal, text => {
        partial += text;
        if (!controller.signal.aborted && window && !window.isDestroyed()) {
          window.webContents.send('launcher:aiText', requestId, text);
        }
      }, rateLimit => {
        if ((current || serverSession) !== account || !serverSession) return;
        account.rateLimit = rateLimit;
        publish();
      }, { retryAt: account.rateLimit?.retryAt, onPhase: sendPhase }).catch(error => {
        if (!controller.signal.aborted) throw error;
        return { answer: partial, tokens: undefined };
      });
      if (!result.answer.trim()) return null;
      if (!quitting && (current || serverSession) === account && !!serverSession) {
        sendPhase('saving');
        const chat = {
          ...previous,
          id: chatId,
          title: previous?.title ?? (message.content || message.attachments?.[0]?.name || '새 대화').replace(/\s+/gu, ' ').slice(0, 45),
          messages: [...(previous?.messages ?? []), message, { role: 'assistant', content: result.answer }]
        };
        const next = chats.slice();
        if (index < 0) next.unshift(chat);
        else next[index] = chat;
        await saveAiHistory(history, next);
      }
      if ((current || serverSession) === account && !!serverSession) {
        account.tokens = result.tokens;
        publish();
      }
      return (current || serverSession) === account && !!serverSession ? result.answer : null;
    } finally {
      aiChatJob = undefined;
    }
  });
  bind('aiTitle', async chatId => {
    const account = needAiAccount();
    const history = account.chatHistory;
    const chats = history?.chats;
    const index = chats?.findIndex(chat => chat.id === chatId) ?? -1;
    const chat = chats?.[index];
    if (!chat) return null;
    if (chat.summarized) return chat.title;
    if (aiChatJob || aiTitleJob || aiManageChatBusy || account.rateLimit?.retryAt > Date.now() ||
        !chat.messages.some(message => message.role === 'assistant')) return null;
    const controller = new AbortController();
    const job = aiTitleJob = { controller };
    job.task = (async () => {
      const connection = await aiConnection();
      const title = await exaone.summarizeTitle(connection, chat.messages, controller.signal, rateLimit => {
        if (controller.signal.aborted || (current || serverSession) !== account || !serverSession) return;
        account.rateLimit = rateLimit;
        publish();
      });
      if (!title || controller.signal.aborted || (current || serverSession) !== account || !serverSession || quitting) return null;
      const next = chats.slice();
      next[index] = { ...chat, title, summarized: true };
      await saveAiHistory(history, next);
      return (current || serverSession) === account && !!serverSession ? title : null;
    })();
    try {
      return await job.task;
    } finally {
      aiTitleJob = undefined;
    }
  });
  bind('aiCancel', () => { needAiAccount(); aiChatJob?.abort(); });
  bind('serverFileAdd', async input => {
    const files = serverFiles();
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw new Error('파일 이름은 80자 이내로 입력하세요.');
    const url = releaseFileUrl(input.url);
    if (files.some(file => file.url === url)) throw new Error('이미 연결된 파일입니다.');
    if (files.length >= 100) throw new Error('파일은 최대 100개까지 연결할 수 있습니다.');
    files.push({ id: randomUUID(), name, url });
    await persist();
    publish();
  });
  bind('serverFileRemove', async id => {
    const files = serverFiles();
    const index = files.findIndex(file => file.id === id);
    if (index === -1) return;
    const project = serverProject(id);
    if (project.runtime.child) throw new Error('서버를 정지한 뒤 연결을 해제하세요.');
    await runServerOperation(project.runtime, 'stopping', async () => {
      const [file] = files.splice(files.indexOf(project.file), 1);
      try {
        await persist();
      } catch (error) {
        files.splice(index, 0, file);
        project.runtime.phase = file.deployment ? 'stopped' : 'new';
        throw error;
      }
      project.session.deployments.delete(id);
      if (file.deployment) {
        await fs.rm(path.join(project.root, file.deployment.version), { force: true, recursive: true }).catch(() => {});
      }
    });
  });
  bind('serverFileOpen', async id => {
    const file = serverFiles().find(file => file.id === id);
    if (!file) throw new Error('연결한 파일을 찾을 수 없습니다.');
    await shell.openExternal(releaseFileUrl(file.url));
  });
  bind('serverAssets', async id => {
    const { session, file } = serverProject(id);
    const assets = await deployment.releaseAssets(releaseFileUrl(file.url), session.abort.signal, await serverGitHubToken(session));
    return assets.map(({ id, name, size, tag }) => ({ id, name, size, tag }));
  });
  bind('serverGitHubConnect', async input => {
    const session = needServerSession();
    const token = typeof input === 'string' ? input.trim() : '';
    if (!/^[\w-]{16,512}$/u.test(token)) throw new Error('GitHub 개인 액세스 토큰을 입력하세요.');
    const login = await github.identity(token, session.abort.signal);
    const key = serverGitHubKey(session);
    const encrypted = await seal(safeStorage, key, token);
    session.abort.signal.throwIfAborted();
    db.serverGitHub ??= {};
    db.serverGitHub[key] = { login, token: encrypted };
    await persist();
    publish();
  });
  bind('serverGitHubDisconnect', async () => {
    const session = needServerSession();
    if (!serverGitHubAccount(session)) return;
    delete db.serverGitHub[serverGitHubKey(session)];
    await persist();
    publish();
  });
  bind('serverGitHubRepos', async () => {
    const session = needServerSession();
    const token = await serverGitHubToken(session) ?? process.env.SONAC_RELEASE_GITHUB_TOKEN;
    if (!token) throw new Error('GitHub 계정을 먼저 연결하세요.');
    return github.repositories(token, session.abort.signal);
  });
  bind('serverDeploy', (id, assetId) => {
    const project = serverProject(id);
    return runServerOperation(project.runtime, 'downloading', () => deployRelease(project, assetId));
  });
  bind('serverRun', id => {
    const project = serverProject(id);
    const { file, root, data, runtime, session } = project;
    if (!file.deployment) throw new Error('ZIP을 먼저 배포하세요.');
    if (runtime.child) throw new Error('서버가 이미 실행 중입니다.');
    return runServerOperation(runtime, 'starting', async () => {
      try {
        const spec = await deployment.launchSpec(path.join(root, file.deployment.version));
        session.abort.signal.throwIfAborted();
        await startDeployment(project, spec);
      } catch (error) {
        runtime.phase = 'failed';
        throw error;
      }
    });
  });
  bind('serverStop', id => {
    const { runtime } = serverProject(id);
    return runServerOperation(runtime, 'stopping', async () => {
      try {
        await deployment.stopProcess(runtime);
        runtime.phase = 'stopped';
      } catch (error) {
        runtime.phase = runtime.child ? 'running' : 'failed';
        throw error;
      }
    });
  });
  bind('serverLogs', id => serverProject(id).runtime.log);
  bind('serverDeploymentFolder', async id => {
    const { file, root, runtime } = serverProject(id);
    if (runtime.task) throw new Error('진행 중인 작업이 끝난 뒤 폴더를 열어주세요.');
    if (!file.deployment) throw new Error('ZIP을 먼저 배포하세요.');
    const folder = await deployment.deploymentFolder(path.join(root, file.deployment.version)).catch(error => {
      if (error.code === 'ENOENT') throw new Error('배포 폴더가 없습니다. ZIP을 다시 배포하세요.');
      throw error;
    });
    if (await shell.openPath(folder)) throw new Error('서버 배포 폴더를 열 수 없습니다.');
  });
  bind('serverDataFolder', async id => {
    const { data } = serverProject(id);
    await fs.mkdir(data, { recursive: true, mode: 0o700 });
    if (await shell.openPath(data)) throw new Error('서버 데이터 폴더를 열 수 없습니다.');
  });
  bind('serverMonitorCheck', async targetId => {
    const session = needServerSession();
    if (!net.isOnline()) throw new Error('인터넷 연결을 확인하세요.');
    if (targetId !== undefined && !monitoringSettings(session).targets.some(target => target.id === targetId)) {
      throw new Error('등록된 서비스를 선택하세요.');
    }
    if (session.monitor) await runServerMonitoring(session, session.monitor, targetId);
    return status();
  });
  bind('serverMonitorSettings', async input => {
    const session = needServerSession();
    if (typeof input?.enabled !== 'boolean' || typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.time)) {
      throw new Error('보고 시각을 확인하세요.');
    }
    const settings = monitoringSettings(session);
    let webhook;
    if (input.webhook) {
      const url = reports.discordWebhook(input.webhook);
      webhook = await seal(safeStorage, monitoringBinding(session), url.href);
    }
    session.abort.signal.throwIfAborted();
    const previous = { enabled: settings.enabled, time: settings.time, webhook: settings.webhook,
      deliveryEnabled: settings.deliveryEnabled };
    Object.assign(settings, { enabled: input.enabled, time: input.time,
      deliveryEnabled: typeof input.deliveryEnabled === 'boolean' ? input.deliveryEnabled : settings.deliveryEnabled,
      webhook: webhook ?? (input.removeWebhook === true ? undefined : settings.webhook) });
    return persistMonitoringChange(session, () => {
      if (settings.enabled === input.enabled && settings.time === input.time) Object.assign(settings, previous);
    });
  });
  bind('serverMonitorTarget', async (input, remove = false) => {
    const session = needServerSession();
    const settings = monitoringSettings(session);
    const previous = settings.targets;
    if (remove === true) settings.targets = previous.filter(target => target.id !== input);
    else {
      const target = reports.monitoringTarget(input);
      if (previous.length >= 10) throw new Error('서비스는 최대 10개까지 등록할 수 있습니다.');
      if (previous.some(item => item.url === target.url || item.name.toLowerCase() === target.name.toLowerCase())) {
        throw new Error('이미 등록된 서비스 이름이나 주소입니다.');
      }
      settings.targets = [...previous, { id: randomUUID(), ...target }];
    }
    const next = settings.targets;
    return persistMonitoringChange(session, () => { if (settings.targets === next) settings.targets = previous; });
  });
  bind('promptDetails', () => activePrompt.details, 'prompt');
  bind('promptAnswer', accepted => {
    const prompt = activePrompt;
    setImmediate(() => {
      if (activePrompt !== prompt) return;
      const choices = prompt.details.choices;
      if (choices) {
        const value = prompt.details.rememberChoice ? accepted?.value : accepted;
        const selected = choices.find(choice => choice.value === value);
        if (!selected) closePrompt(false);
        else if (prompt.details.rememberChoice) {
          closePrompt({ value: selected.value, applyToRemaining: accepted.applyToRemaining === true });
        } else closePrompt(selected.value);
      } else {
        closePrompt(accepted === true);
      }
    });
  }, 'prompt');
  bind('state', status);
  bind('setPreference', setPreference);
  bind('checkUpdate', async () => {
    await updater?.check();
    return status();
  });
  bind('installUpdate', async (confirmed = false) => {
    if (applyingUpdate || quitting) throw new Error('업데이트 또는 종료 작업이 진행 중입니다.');
    if (restoringLogin || connecting) throw new Error('로그인이 끝난 뒤 업데이트하세요.');
    if (!updater) throw new Error('설치할 업데이트가 없습니다.');
    if (confirmed === true && update?.phase !== 'ready') throw new Error('업데이트 준비를 먼저 완료하세요.');
    applyingUpdate = true;
    publish();
    let restartTimeout;
    try {
      await updater.prepare();
      if (confirmed !== true || quitting) return;
      const deadline = new Promise((_, reject) => {
        restartTimeout = setTimeout(() => reject(new Error('동기화 또는 파일 작업이 진행 중입니다. 끝난 뒤 다시 시작하세요.')), 20000);
      });
      const remaining = () => [syncJob, layoutJob, ...pendingOperations, ...areaJobs.values()].filter(Boolean);
      for (let jobs = remaining(); !quitting && jobs.length; jobs = remaining()) {
        await Promise.race([Promise.allSettled(jobs), deadline]);
      }
      if (quitting) return;
      restartForUpdate = true;
      publish();
      app.quit();
    } finally {
      clearTimeout(restartTimeout);
      if (!restartForUpdate) {
        applyingUpdate = false;
        publish();
      }
    }
  });
  bind('login', async (input) => {
    const nas = db;
    const mode = pendingUsageMode ?? nas.usageMode;
    if (mode !== 'nas' && mode !== 'both') throw new Error('사용 모드에서 NAS를 선택하세요.');
    if (applyingUpdate) throw new Error('업데이트가 끝난 뒤 로그인하세요.');
    if (restoringLogin || connecting || current) throw new Error('이미 로그인 중입니다.');
    const { provider = 'synology', user, password, otp, remember } = input;
    if (provider !== 'synology' || typeof user !== 'string' || !user.trim() ||
        user.length > 256 || typeof password !== 'string' || password.length > 4096 ||
        typeof input.url !== 'string' || input.url.length > 2048 || typeof otp !== 'string' || (otp && !/^\d{6}$/u.test(otp))) {
      throw new Error('사용자 이름, 비밀번호 및 OTP를 확인하세요.');
    }
    const profile = { provider, url: endpoint(input.url, provider), user: user.trim(), pin: certificatePin(input.pin) };
    const edited = input.editId && nas.connections.find(record => accountKey(record.profile) === input.editId);
    const saved = savedConnection(profile);
    if (input.editId && !edited) throw new Error('수정할 NAS 연결을 찾을 수 없습니다.');
    if (edited && saved && edited !== saved) throw new Error('같은 주소와 계정이 이미 등록되어 있습니다.');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length > 48 || (!saved && !name)) throw new Error('NAS 이름을 48자 이내로 입력하세요.');
    profile.name = name || saved?.profile.name || '';
    if (!saved && !edited && nas.connections.length >= 30) throw new Error('NAS 연결은 최대 30개까지 추가할 수 있습니다.');
    if (!password && remember !== true) throw new Error('비밀번호를 입력하세요.');
    restorePending = false;
    const secret = password ? { password } : await rememberedSecret(profile, nas);
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
    const connection = needConnection();
    const account = githubAccount(connection, repository);
    github.repositoryPath(repository);
    if (track === true && !account.tracked.includes(repository)) {
      await github.requireRepositoryAccess(repository, await githubToken(connection, account), connection.abort.signal);
      connection.abort.signal.throwIfAborted();
      if (workspace(connection).github !== account) throw new Error('GitHub 연결이 변경됐습니다. 다시 시도하세요.');
      if (account.tracked.includes(repository)) return;
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
  bind('areaGroupMove', async (id, targetId) => {
    const settings = workspace(needConnection());
    const group = groupById(settings, id);
    const target = settings.syncGroups.indexOf(groupById(settings, targetId));
    if (group.id === targetId) return;
    settings.syncGroups.splice(settings.syncGroups.indexOf(group), 1);
    settings.syncGroups.splice(target, 0, group);
    await persist();
    publish();
  });
  bind('folderFavorite', async (input, enabled) => {
    const settings = workspace(needConnection());
    const folder = remotePath(input);
    if (folder === '/' || typeof enabled !== 'boolean') throw new Error('즐겨찾기 폴더를 확인하세요.');
    const favorites = settings.folderFavorites ?? [];
    if (enabled === favorites.includes(folder)) return;
    if (enabled && favorites.length >= 40) throw new Error('폴더 즐겨찾기는 최대 40개까지 추가할 수 있습니다.');
    settings.folderFavorites = enabled ? [...favorites, folder] : favorites.filter(path => path !== folder);
    await persist();
    publish();
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
      const account = githubAccount(connection, input.repository);
      if (previous?.repository !== input.repository && !account.tracked.includes(input.repository)) {
        throw new Error('GitHub 메뉴의 선택한 프로젝트에 저장소를 먼저 추가하세요.');
      }
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
    if (connection.syncingAll) throw new Error('동기화가 끝난 뒤 설정을 저장하세요.');
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
      if (typeof input.launchAtLogin === 'boolean') setLaunchAtLogin(input.launchAtLogin);
      if (typeof input.automatic === 'boolean') settings.automatic = input.automatic;
      Object.assign(settings, { remote, local: input.local, interval });
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
  bind('syncAll', async () => {
    const connection = needConnection();
    if (connection.syncingAll) return;
    const settings = workspace(connection);
    const base = !!(settings.remote && settings.local);
    const areas = settings.areas.filter(area => area.source === 'nas' || area.source === 'github');
    if (!base && !areas.length) throw new Error('먼저 동기화 폴더를 선택하세요.');
    if (base && (layoutJob || configuring)) throw new Error('설정을 저장한 뒤 다시 시도하세요.');
    connection.syncingAll = true;
    publish();
    try {
      const projects = areas.filter(area => area.source === 'github');
      if (projects.length && !await confirmChange(connection, {
        title: '모든 항목 동기화',
        message: '등록된 항목을 동기화할까요? GitHub의 최신 파일이 같은 경로의 로컬 파일을 덮어씁니다.',
        detail: projects.map(area => area.name + ' · ' + area.repository).join('\n'),
        action: '모두 동기화'
      })) return;
      const signal = connection.abort.signal;
      const changed = () => new Error('동기화 항목 설정이 변경되었습니다. 다시 시도하세요.');
      if (areas.some(area => !settings.areas.includes(area))) throw changed();
      if (base) {
        const result = syncJob ? await syncJob : null;
        signal.throwIfAborted();
        if (!result || result.pending) {
          if (layoutJob || configuring) throw new Error('설정을 저장한 뒤 다시 시도하세요.');
          await runSync(true);
        }
      }
      for (const area of areas) {
        signal.throwIfAborted();
        if (!settings.areas.includes(area)) throw changed();
        await runArea(connection, area);
      }
    } finally {
      connection.syncingAll = false;
      publish();
    }
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
  bind('upload', async (folder, dropped, retryId) => {
    const connection = needConnection();
    requireRemoteWrites(connection);
    const location = remotePath(folder);
    if (location === '/' && connection.profile.provider === 'synology') throw new Error('업로드할 공유 폴더를 선택하세요.');
    let result;
    if (retryId !== undefined) {
      const retry = connection.uploadRetry;
      if (!retry || retry.id !== retryId || retry.folder !== location) throw new Error('다시 시도할 업로드를 찾을 수 없습니다. 파일을 다시 선택하세요.');
      result = { filePaths: retry.files };
    } else {
      result = dropped === undefined
        ? await dialog.showOpenDialog(window, { title: '업로드할 파일 선택', properties: ['openFile', 'multiSelections'] })
        : { filePaths: droppedLocalPaths(dropped, 1000) };
    }
    if (result.canceled) return null;
    if (!await confirmChange(connection, {
      title: 'NAS 파일 업로드', message: result.filePaths.length + '개 파일을 NAS에 업로드할까요?',
      detail: connection.profile.url + '\n' + location + '\n\n' + result.filePaths.slice(0, 5).map(file => path.basename(file)).join('\n'),
      action: '업로드'
    })) return null;
    const errors = [];
    const failedPaths = [];
    const items = await Promise.all(result.filePaths.map(async filename => ({
      name: path.basename(filename),
      size: await fs.lstat(filename).then(info => info.isFile() ? info.size : null).catch(() => null)
    })));
    const progress = transferReporter(connection, 'upload', items);
    let uploaded = 0;
    let skipped = 0;
    let conflictAction;
    for (const [index, filename] of result.filePaths.entries()) {
      connection.abort.signal.throwIfAborted();
      const name = path.basename(filename);
      progress(name, 0, items[index].size, index);
      try {
        requireRemoteWrites(connection);
        writableName(name);
        if (!(await fs.lstat(filename)).isFile()) throw new Error('일반 파일만 업로드할 수 있습니다.');
        const siblings = await operate(connection, (store, signal) => store.list(location, signal));
        const key = value => value.normalize('NFC').toLowerCase();
        const existing = siblings.find(item => key(item.name) === key(name));
        let targetName = name;
        let overwrite = false;
        if (existing) {
          const choice = conflictAction ? { value: conflictAction } : await showPrompt({
            title: '같은 이름의 파일이 있습니다', message: name, rememberChoice: true, detail: location + '\n업로드 방법을 선택하세요.',
            choices: [
              { value: 'keepBoth', label: '이름을 바꿔 둘 다 저장', style: 'primary' },
              { value: 'overwrite', label: '덮어쓰기', style: 'danger' },
              { value: 'skip', label: '건너뛰기' }
            ]
          });
          requireRemoteWrites(connection);
          if (choice?.applyToRemaining) conflictAction = choice.value;
          if (!choice || choice.value === 'skip') {
            skipped++;
            progress(name, 0, items[index].size, index, 'skipped');
            continue;
          }
          if (choice.value === 'overwrite') {
            if (existing.directory) throw new Error('같은 이름의 폴더는 파일로 덮어쓸 수 없습니다.');
            overwrite = true;
            targetName = existing.name;
          } else {
            const names = new Set(siblings.map(item => key(item.name)));
            const extension = path.extname(name);
            const stem = name.slice(0, name.length - extension.length);
            let suffix = 1;
            do { targetName = stem + ' (' + suffix++ + ')' + extension; } while (names.has(key(targetName)));
            writableName(targetName);
          }
        }
        const blob = await openAsBlob(filename);
        await operate(connection, (store, signal) => store.upload(location, targetName, blob, { overwrite, signal, progress: (name, bytes, total) => progress(name, bytes, total, index) }));
        uploaded++;
        progress(targetName, blob.size, blob.size, index, 'done');
      } catch (error) {
        const message = displayError(error);
        errors.push(name + ' · ' + message);
        failedPaths.push(filename);
        progress(name, 0, items[index].size, index, 'error', message);
      }
    }
    const nextRetry = failedPaths.length ? { id: randomUUID(), folder: location, files: failedPaths } : undefined;
    connection.uploadRetry = nextRetry;
    return { uploaded, skipped, errors, retryId: nextRetry?.id };
  });
  bind('moveNas', async (folder, paths, destination, copy = false) => {
    if (typeof copy !== 'boolean') throw new Error('파일 작업을 확인하세요.');
    const connection = needConnection();
    requireRemoteWrites(connection);
    const source = remotePath(folder);
    const target = remotePath(destination);
    if (source === '/' || target === '/' || source === target) throw new Error('다른 NAS 폴더를 선택하세요.');
    const { entries } = await selectedEntries(connection, 'remote', source, paths);
    if (entries.some(entry => entry.path === target || target.startsWith(entry.path + '/'))) {
      throw new Error('폴더를 자기 자신이나 하위 폴더로 옮길 수 없습니다.');
    }
    if (!await confirmChange(connection, {
      title: copy ? 'NAS 항목 복사' : 'NAS 항목 이동', message: entries.length + (copy ? '개 항목을 이 폴더로 복사할까요?' : '개 항목을 이 폴더로 옮길까요?'),
      detail: connection.profile.url + '\n' + target, action: copy ? '복사' : '이동'
    })) return null;
    const task = await operate(connection, async (store, signal) => {
      const siblings = await store.list(target, signal);
      const names = new Set(siblings.map(item => item.name.normalize('NFC').toLowerCase()));
      if (entries.some(item => names.has(item.name.normalize('NFC').toLowerCase()))) {
        throw new Error('대상 폴더에 같은 이름의 항목이 있습니다.');
      }
      requireRemoteWrites(connection);
      return store.startMove(entries, target, signal, copy);
    });
    const progress = transferReporter(connection, copy ? 'copy' : 'move');
    while (true) {
      const status = await operate(connection, (store, signal) => store.moveStatus(task, signal));
      if (status.finished) {
        const listing = await operate(connection, (store, signal) => store.list(copy ? target : source, signal));
        const present = new Set(listing.map(entry => entry.name));
        const completed = entries.filter(entry => copy ? present.has(entry.name) : !present.has(entry.name)).length;
        return { moved: completed, total: entries.length };
      }
      const percent = Number.isFinite(status.progress) && status.progress >= 0
        ? Math.round(status.progress * 100) : null;
      progress(target, percent ?? 0, percent === null ? null : 100);
      await delay(1000, undefined, { signal: connection.abort.signal });
    }
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
  bind('renameFile', async (folder, selected, input) => {
    const connection = needConnection();
    requireRemoteWrites(connection);
    const location = remotePath(folder);
    if (location === '/') throw new Error('공유 폴더 안에서 이름을 바꿀 항목을 선택하세요.');
    const name = writableName(typeof input === 'string' ? input.trim() : '');
    const { entries: [entry] } = await selectedEntries(connection, 'remote', location, [selected]);
    if (entry.name === name) return true;
    await operate(connection, async (store, signal) => {
      await requireUnusedName(store, location, name, signal, entry.path);
      requireRemoteWrites(connection);
      await store.rename(location, entry, name, signal);
    });
    return true;
  });
  bind('extractArchive', async (folder, selected, destination = 'folder') => {
    const connection = needConnection();
    requireRemoteWrites(connection);
    const location = remotePath(folder);
    if (location === '/') throw new Error('공유 폴더 안에서 ZIP 파일을 선택하세요.');
    const { entries: [entry] } = await selectedEntries(connection, 'remote', location, [selected]);
    if (entry.directory || !/\.zip$/iu.test(entry.name)) throw new Error('ZIP 파일을 선택하세요.');
    if (destination !== 'here' && destination !== 'folder') throw new Error('압축을 풀 위치를 선택하세요.');
    const name = destination === 'folder' ? writableName(entry.name.slice(0, -4)) : null;
    if (name) await operate(connection, (store, signal) => requireUnusedName(store, location, name, signal));
    if (connection.profile.provider === 'synology') return extractOnSynology(connection, location, entry, name);
    const archiveLimit = 128 * 1024 ** 2;
    if (entry.size > archiveLimit) throw new Error('WebDAV에서는 128 MiB 이하의 ZIP 파일만 압축을 풀 수 있습니다.');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sonac-extract-'));
    const stagingName = 'sonac-extract-' + randomUUID();
    const staging = { path: childPath(location, stagingName), directory: true };
    let staged = false;
    try {
      const archive = await operate(connection, async (store, signal) => {
        const response = await store.download(entry.path, signal);
        if (!response.body) throw new Error('NAS가 ZIP 내용을 반환하지 않았습니다.');
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > archiveLimit) throw new Error('128 MiB 이하의 ZIP 파일만 압축을 풀 수 있습니다.');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks, size);
      });
      await deployment.extractZip(archive, temp, connection.abort.signal, {
        limit: 256 * 1024 ** 2, entryLimit: 2000, validatePart: writableName, preserveDirectories: true
      });
      requireRemoteWrites(connection);
      if (!name) {
        const paths = await fs.readdir(temp);
        const entries = await operate(connection, (store, signal) => store.list(location, signal));
        const existing = new Set(entries.map(item => item.name.normalize('NFC').toLowerCase()));
        if (paths.some(item => existing.has(item.normalize('NFC').toLowerCase()))) {
          throw new Error('같은 이름의 파일 또는 폴더가 이미 있습니다.');
        }
        await uploadExtractedFiles(connection, temp, location);
        return null;
      }
      await operate(connection, (store, signal) => store.mkdir(location, stagingName, signal));
      staged = true;
      await uploadExtractedFiles(connection, temp, staging.path);
      await operate(connection, async (store, signal) => {
        await requireUnusedName(store, location, name, signal);
        requireRemoteWrites(connection);
        await store.rename(location, staging, name, signal);
      });
      staged = false;
      return name;
    } finally {
      if (staged && !connection.abort.signal.aborted && connection.remoteWrites) {
        await operate(connection, (store, signal) => store.delete(staging, signal)).catch(() => {});
      }
      await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
    }
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
  bind('mediaFolder', async (kind, folder) => {
    if (!['audio', 'video'].includes(kind)) throw new Error('플레이어를 확인하세요.');
    const connection = needConnection();
    const location = remotePath(folder);
    const scans = connection.mediaScans ??= new Map();
    scans.get(kind)?.abort();
    const controller = new AbortController();
    scans.set(kind, controller);
    const signal = AbortSignal.any([connection.abort.signal, controller.signal]);
    try {
      const list = target => operate(connection, (store, sessionSignal) =>
        store.list(target, AbortSignal.any([signal, sessionSignal])));
      const library = await scanMediaFolders(location, list, signal, kind);
      signal.throwIfAborted();
      const settings = workspace(connection);
      if (settings.mediaFolders?.[kind] !== location) {
        const previous = settings.mediaFolders;
        const next = { ...previous, [kind]: location };
        settings.mediaFolders = next;
        try { await persist(); }
        catch (error) {
          if (settings.mediaFolders === next) settings.mediaFolders = previous;
          throw error;
        }
        signal.throwIfAborted();
        publish();
      }
      return library;
    } finally {
      if (scans.get(kind) === controller) scans.delete(kind);
    }
  });
  bind('mediaPlay', async (id, kind, folder, item, audioSlot, coverPath) => {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/iu.test(id) || !['audio', 'video'].includes(kind)) {
      throw new Error('재생할 파일을 선택하세요.');
    }
    if (kind === 'audio' && ![0, 1].includes(audioSlot)) throw new Error('음악 재생 위치를 확인하세요.');
    const slot = kind === 'audio' ? 'audio-' + audioSlot : kind;
    const connection = needConnection();
    const requests = connection.mediaRequests ??= new Map();
    requests.get(slot)?.controller.abort();
    const job = { id, controller: new AbortController() };
    requests.set(slot, job);
    const signal = AbortSignal.any([connection.abort.signal, job.controller.signal]);
    try {
      const { entries: [entry] } = await selectedEntries(connection, 'remote', folder, [item]);
      signal.throwIfAborted();
      return await createPreview(id, entry, {
        player: kind, slot, signal,
        metadata: kind === 'audio' ? async filename => {
          const tags = await musicTags(filename);
          signal.throwIfAborted();
          if (!tags.cover && typeof coverPath === 'string') {
            try {
              const { entries: [cover] } = await selectedEntries(connection, 'remote', folder, [coverPath]);
              if (coverFile(cover)) {
                tags.cover = await readArtwork(await operate(connection, (store, sessionSignal) =>
                  store.download(cover.path, AbortSignal.any([signal, sessionSignal, AbortSignal.timeout(4000)]))));
              }
            } catch { signal.throwIfAborted(); }
          }
          return tags;
        } : undefined,
        download: abort => operate(connection, (store, sessionSignal) =>
          store.download(entry.path, AbortSignal.any([abort, sessionSignal])))
      });
    } finally {
      if (requests.get(slot) === job) requests.delete(slot);
    }
  });
  bind('mediaCompatible', id => {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/iu.test(id)) throw new Error('영상을 다시 선택하세요.');
    return compatibleVideo(id, needConnection().abort.signal);
  });
  bind('mediaSubtitle', async (folder, item) => {
    const connection = needConnection();
    const { entries: [entry] } = await selectedEntries(connection, 'remote', folder, [item]);
    const limit = 2 * 1024 ** 2;
    if (entry.directory || !/\.(?:srt|vtt|ass|ssa|smi)$/iu.test(entry.name) || entry.size > limit) {
      throw new Error('2 MiB 이하의 SRT, VTT, ASS, SSA 또는 SMI 자막을 선택하세요.');
    }
    const response = await operate(connection, (store, signal) => store.download(entry.path, signal));
    if (!response.body) throw new Error('자막 파일을 읽을 수 없습니다.');
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error('자막 파일이 2 MiB를 초과합니다.');
      chunks.push(chunk);
    }
    connection.abort.signal.throwIfAborted();
    return Uint8Array.from(Buffer.concat(chunks, length));
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
  bind('closePreview', id => {
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/iu.test(id)) return;
    for (const job of current?.mediaRequests?.values() ?? []) {
      if (job.id === id) job.controller.abort();
    }
    return clearPreview(id);
  });
  bind('openLink', async action => {
    const connection = action === 'serverGitHubToken' ? null : needConnection();
    if (action === 'serverGitHubToken') needServerSession();
    if (action === 'githubClassicToken') return shell.openExternal('https://github.com/settings/tokens/new?scopes=repo');
    if (action === 'githubToken' || action === 'serverGitHubToken') {
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
    needTerminalSession();
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
  bind('terminalStart', (id, cols, rows) => {
    needTerminalSession();
    if (!Number.isSafeInteger(id) || id < 1 || terminalSessions.has(id)) throw new Error('터미널 탭을 확인하세요.');
    if (terminalSessions.size >= terminalTabLimit) throw new Error('터미널 탭은 최대 8개까지 열 수 있습니다.');
    terminalSize(cols, rows);
    const native = require(app.isPackaged ? path.join(process.resourcesPath, 'node_modules', 'node-pty') : 'node-pty');
    const windows = process.platform === 'win32';
    const executable = windows ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32',
      'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/zsh';
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|HOME|USER|LOGNAME|LANG|LC_.*|SHELL|TMP|TMPDIR|TEMP|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|APPDATA|LOCALAPPDATA|PATHEXT|HOMEDRIVE|HOMEPATH)$/iu.test(key)));
    const pty = native.spawn(executable, windows ? ['-NoLogo'] : ['-l'], {
      name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...env, TERM: 'xterm-256color' }
    });
    terminalSessions.set(id, pty);
    pty.onData(data => {
      if (terminalSessions.get(id) === pty) terminalView?.webContents.send('launcher:terminal', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      if (terminalSessions.get(id) !== pty) return;
      terminalSessions.delete(id);
      terminalView?.webContents.send('launcher:terminal', { id, exitCode });
    });
  }, 'terminal');
  bind('terminalCloseTab', closeTerminalTab, 'terminal');
  bind('terminalWrite', (id, data) => {
    if (typeof data === 'string' && data.length <= 65536) terminalSessions.get(id)?.write(data);
  }, 'terminal');
  bind('terminalResize', (id, cols, rows) => {
    const pty = terminalSessions.get(id);
    if (!pty) return;
    terminalSize(cols, rows);
    pty.resize(cols, rows);
  }, 'terminal');
}

async function finishQuit() {
  aiChatJob?.abort();
  aiTitleJob?.controller.abort();
  await aiHistoryWrite?.catch(() => {});
  try {
    if (restartForUpdate) await updater?.install(true);
  } catch (error) {
    if (restartForUpdate) {
      quitting = false;
      restartForUpdate = false;
      applyingUpdate = false;
      publish();
      await showError('업데이트를 실행할 수 없습니다', displayError(error));
      return;
    }
  }
  serverAuthAttempt?.abort();
  clearTimeout(serverAuthTimer);
  updater?.stop();
  stopServerMonitoring(serverSession);
  serverSession?.abort.abort();
  await stopDeployments(serverSession);
  await serverEnding?.catch(() => {});
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
  await writeQueue.catch(() => {});
  if (trashDataOnQuit) {
    try {
      await Promise.all(['launcher', 'terminal', 'prompt', 'default'].map(partition =>
        (partition === 'default' ? session.defaultSession : session.fromPartition(partition)).clearStorageData()));
      await shell.trashItem(app.getPath('userData'));
    } catch (error) {
      await showError('로컬 데이터를 모두 지우지 못했습니다', displayError(error));
    }
  }
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
    await migrateNasSettings();
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
    if (db.usageMode === 'server') void restoreServerSession().catch(() => {});
    else void restore().catch(() => {});
    installTray();
    showWindow();
    if (process.platform === 'win32' && app.isPackaged) {
      window.once('ready-to-show', () => {
        void windowsInstallNotice(app.getPath('userData')).then(result => {
          if (result && !quitting && !activePrompt) return showPrompt({ ...result, action: '확인' });
        }).catch(() => {});
      });
    }
    updater = createUpdater({
      version: releaseVersion, channel: updateChannel, publicKey: app.isPackaged ? updatePublicKey : null,
      repository: updateRepository, dataDirectory: app.getPath('userData'),
      async getToken() {
        const nas = db;
        const profile = current?.profile ?? nas?.profile;
        const account = profile && nas.workspaces[accountKey(profile)]?.github;
        if (wrapped(account?.token)) return githubToken({ profile }, account);
      },
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
