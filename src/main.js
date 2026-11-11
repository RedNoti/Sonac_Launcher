'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, safeStorage, shell } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { pathToFileURL } = require('node:url');
const { storage, endpoint, remotePath, openAsBlob } = require('./storage');
const { LAYOUT_FILE, cleanLayout, webLink, pullFiles, downloadFile } = require('./sync');

const { productName } = require('../package.json');
app.setName(productName);
app.setAppUserModelId('kr.sonac.launcher');
if (tls.getCACertificates && tls.setDefaultCACertificates) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

const page = path.join(__dirname, 'ui', 'index.html');
const iconPath = path.join(__dirname, 'ui', 'app.png');
const defaultLayout = { version: 1, links: {}, shortcuts: [] };
const sessionErrors = new Set([106, 107, 119]);
const device = computerName();
let window;
let tray;
let db;
let writeQueue = Promise.resolve();
let current = null;
let connecting = false;
let loginError = '';
let syncJob = null;
let layoutJob = null;
let configuring = false;
let timer;
let quitting = false;
let showNextProgress = 0;
let pickedFolder = '';

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
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

function workspace(connection = current) {
  const key = accountKey(connection.profile);
  db.workspaces[key] ??= { remote: '', local: '', interval: 5, automatic: true, layout: defaultLayout, last: null };
  return db.workspaces[key];
}

async function readDB() {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    if (parsed.version === 1 && parsed.workspaces && typeof parsed.workspaces === 'object') return parsed;
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  return { version: 1, profile: null, remembered: null, launchAtLogin: false, workspaces: {} };
}

function persist() {
  const filename = path.join(app.getPath('userData'), 'settings.json');
  const temp = filename + '.tmp';
  const data = JSON.stringify(db);
  const save = async () => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, filename);
  };
  writeQueue = writeQueue.catch(() => {}).then(save);
  return writeQueue;
}

function status() {
  return {
    profile: current?.profile || db?.profile,
    connected: !!current,
    connecting,
    loginError,
    device,
    launchAtLogin: !!db?.launchAtLogin,
    settings: current ? workspace() : null,
    sync: current?.sync || null
  };
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('launcher:state', status());
}

function showWindow() {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1250, height: 860, minWidth: 460, minHeight: 550, show: false,
    backgroundColor: '#101115', title: productName, icon: iconPath, autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.on('close', event => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => { window = undefined; });
  window.loadFile(page);
}

function installTray() {
  const shouldKeepRunning = !!current && workspace().automatic && !!workspace().local && !!workspace().remote;
  if (!shouldKeepRunning) {
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
    { label: '지금 동기화', click: () => { void runSync(); } },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
  if (process.platform === 'win32') tray.on('double-click', showWindow);
}

function scheduleSync(immediate = false) {
  clearTimeout(timer);
  if (!current) return;
  const settings = workspace();
  if (!settings.automatic || !settings.remote || !settings.local) return;
  timer = setTimeout(() => { void runSync(); }, immediate ? 150 : settings.interval * 60 * 1000);
}

async function connect(profile, secret, otp, remember, restoring = false) {
  if (connecting || current) throw new Error('이미 로그인 중입니다.');
  connecting = true;
  loginError = '';
  publish();
  const store = storage(profile);
  let remembered = null;
  try {
    const renewed = await store.connect(secret, otp, remember);
    if (remember) {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) {
        throw new Error('운영체제에서 로그인 정보를 보호할 수 없습니다. 로그인 유지 체크를 해제하고 다시 로그인하세요.');
      }
      remembered = (await safeStorage.encryptStringAsync(JSON.stringify(renewed))).toString('base64');
    }
    db.profile = profile;
    db.remembered = remembered;
    current = { profile, store, secret: renewed, remember, abort: new AbortController(), sync: null, reconnect: null };
    workspace();
    await persist();
    installTray();
    scheduleSync(true);
  } catch (error) {
    current = null;
    await store.logout();
    if (restoring) loginError = error.message;
    throw error;
  } finally {
    connecting = false;
    publish();
  }
}

async function restore() {
  if (!db.profile || !db.remembered) return;
  try {
    const result = await safeStorage.decryptStringAsync(Buffer.from(db.remembered, 'base64'));
    await connect(db.profile, JSON.parse(result.result), '', true, true);
  } catch (error) {
    loginError ||= error.message || '저장된 로그인을 복원할 수 없습니다.';
    publish();
  }
}

function needConnection() {
  if (!current) throw new Error('저장소에 다시 로그인하세요.');
  return current;
}

async function logout() {
  const connection = current;
  if (!connection) return;
  current = null;
  connection.abort.abort(new Error('로그아웃했습니다.'));
  clearTimeout(timer);
  pickedFolder = '';
  db.remembered = null;
  installTray();
  publish();
  await persist();
  await connection.store.logout();
}

async function operate(connection, action) {
  const signal = connection.abort.signal;
  try {
    return await action(connection.store, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!sessionErrors.has(error.dsmCode)) throw error;
    connection.reconnect ??= connection.store
      .connect(connection.secret, '', connection.remember, signal)
      .then(secret => { connection.secret = secret; })
      .finally(() => { connection.reconnect = null; });
    try {
      await connection.reconnect;
    } catch (renewError) {
      if ([400, 403, 404].includes(renewError.dsmCode) && current === connection) {
        await logout();
        loginError = renewError.message;
        publish();
      }
      throw renewError;
    }
    signal.throwIfAborted();
    return action(connection.store, signal);
  }
}

function runSync() {
  if (syncJob) return syncJob;
  if (!current || !workspace().remote || !workspace().local) return Promise.resolve(null);
  if (layoutJob || configuring) {
    scheduleSync();
    return Promise.resolve(null);
  }
  clearTimeout(timer);
  const connection = current;
  const settings = workspace(connection);
  connection.sync = { running: true, downloaded: 0, skipped: 0, errors: 0, message: '' };
  showNextProgress = 0;
  publish();
  syncJob = (async () => {
    try {
      const counts = await operate(connection, (store, signal) => pullFiles(store, settings, {
        signal,
        progress(counts) {
          if (current !== connection) return;
          connection.sync = { ...counts, running: true };
          if (Date.now() >= showNextProgress) {
            publish();
            showNextProgress = Date.now() + 250;
          }
        },
        async layout(value) { settings.layout = value; }
      }));
      if (current !== connection) return null;
      const result = { ...counts, checkedAt: Date.now(), running: false };
      settings.last = result;
      connection.sync = result;
      await persist();
      return result;
    } catch (error) {
      if (current !== connection) return null;
      connection.sync = { ...connection.sync, running: false, errors: 1, message: displayError(error) };
      return connection.sync;
    } finally {
      syncJob = null;
      publish();
      scheduleSync();
    }
  })();
  return syncJob;
}

function displayError(error) {
  if (typeof error?.code === 'string' && /^E[A-Z_]+$/u.test(error.code)) {
    return `파일 또는 시스템에 접근할 수 없습니다. (${error.code})`;
  }
  return error?.message || '작업을 완료할 수 없습니다.';
}

function bind(name, handler) {
  ipcMain.handle('launcher:' + name, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pathToFileURL(page).href ||
        event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: '이 화면에서 작업을 실행할 수 없습니다.' };
    }
    try {
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      return { ok: false, error: displayError(error) };
    }
  });
}

function registerHandlers() {
  bind('state', status);
  bind('login', async (input) => {
    const { provider, user, password, otp, remember } = input;
    if (!['synology', 'webdav'].includes(provider) || typeof user !== 'string' || !user.trim() ||
        typeof password !== 'string' || !password || (otp && !/^\d{6}$/u.test(otp))) {
      throw new Error('사용자 이름, 비밀번호 및 OTP를 확인하세요.');
    }
    const profile = { provider, url: endpoint(input.url, provider), user: user.trim() };
    await connect(profile, { password }, otp, remember === true);
    return status();
  });
  bind('logout', logout);
  bind('list', folder => {
    const location = remotePath(folder);
    return operate(needConnection(), (store, signal) => store.list(location, signal));
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
      const changed = settings.remote !== remote || settings.local !== input.local;
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
        settings.last = null;
        connection.sync = null;
      }
      await persist();
      installTray();
      scheduleSync(true);
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
    return runSync();
  });
  bind('layout', async input => {
    const connection = needConnection();
    const settings = workspace(connection);
    const value = cleanLayout(input);
    if (syncJob || layoutJob || configuring) throw new Error('진행 중인 작업이 끝난 뒤 런처 구성을 저장하세요.');
    layoutJob = (async () => {
      if (settings.remote) {
        await operate(connection, (store, signal) => store.upload(settings.remote, LAYOUT_FILE,
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
    const location = remotePath(folder);
    if (location === '/' && connection.profile.provider === 'synology') throw new Error('업로드할 공유 폴더를 선택하세요.');
    const result = await dialog.showOpenDialog(window, { title: '업로드할 파일 선택', properties: ['openFile', 'multiSelections'] });
    if (result.canceled) return null;
    const errors = [];
    let uploaded = 0;
    for (const filename of result.filePaths) {
      connection.abort.signal.throwIfAborted();
      const name = path.basename(filename);
      try {
        if (name === LAYOUT_FILE) throw new Error('런처 구성은 런처 편집에서 저장하세요.');
        const blob = await openAsBlob(filename);
        await operate(connection, (store, signal) => store.upload(location, name, blob, { signal }));
        uploaded++;
      } catch (error) {
        errors.push(name + ' · ' + displayError(error));
      }
    }
    return { uploaded, errors };
  });
  bind('download', async file => {
    const connection = needConnection();
    const location = remotePath(file.path);
    const name = location.split('/').at(-1);
    const settings = workspace(connection);
    if (!name || file.directory || path.basename(name) !== name || /[\\<>:"|?*]/u.test(name)) {
      throw new Error('다운로드할 수 없는 파일 이름입니다.');
    }
    const result = await dialog.showSaveDialog(window, {
      title: '다운로드 위치 선택', defaultPath: path.join(settings.local || app.getPath('downloads'), name)
    });
    if (result.canceled || !result.filePath) return false;
    await operate(connection, (store, signal) => downloadFile(store,
      { path: location, size: file.size }, result.filePath, { replace: true, signal }));
    return true;
  });
  bind('openFolder', async () => {
    needConnection();
    const error = await shell.openPath(workspace().local || app.getPath('downloads'));
    if (error) throw new Error('다운로드 폴더를 열 수 없습니다.');
  });
  bind('openLink', async value => {
    needConnection();
    await shell.openExternal(webLink(value));
  });
  bind('terminal', () => {
    needConnection();
    const command = process.platform === 'darwin' ? '/usr/bin/open' : 'cmd.exe';
    const args = process.platform === 'darwin' ? ['-a', 'Terminal'] : ['/d'];
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => reject(new Error('터미널을 실행할 수 없습니다.')));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !tray) app.quit(); });
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(timer);
    current?.abort.abort();
  });
  app.whenReady().then(async () => {
    db = await readDB();
    if (process.platform === 'darwin') {
      const menu = Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
      Menu.setApplicationMenu(menu);
      if (!app.isPackaged) app.dock.setIcon(iconPath);
    }
    registerHandlers();
    showWindow();
    powerMonitor.on('resume', () => scheduleSync(true));
    void restore();
  }).catch(error => {
    dialog.showErrorBox(productName, displayError(error));
    app.quit();
  });
}
