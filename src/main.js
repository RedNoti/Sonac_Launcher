'use strict';

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, powerMonitor, protocol, safeStorage, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { storage, endpoint, remotePath, openAsBlob } = require('./storage');
const { LAYOUT_FILE, cleanLayout, webLink, pullFiles, scanMissing, downloadFile, downloadSelection } = require('./sync');
const { origin, createPreview, clearPreview, serve } = require('./preview');
const { createUpdater } = require('./updater');
const github = require('./github');
const { httpsLink, fileName, syncExternal } = require('./areas');

const { productName, updatePublicKey, updateURL } = require('../package.json');
protocol.registerSchemesAsPrivileged([{
  scheme: 'sonac', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
app.setName(productName);
app.setAppUserModelId('kr.sonac.launcher');
if (tls.getCACertificates && tls.setDefaultCACertificates) {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
}

const page = origin + '/index.html';
const iconPath = path.join(__dirname, 'ui', 'app.png');
const defaultLayout = { version: 1, links: {}, shortcuts: [] };
const sessionErrors = new Set([106, 107, 119]);
const updateBlockingHandlers = new Set(['login', 'logout', 'settings', 'upload', 'download', 'delete',
  'githubConnect', 'githubDisconnect', 'githubTrack', 'areaSave', 'areaRemove', 'areaRun']);
const pendingOperations = new Set();
const areaJobs = new Map();
const device = computerName();
let window;
let tray;
let db;
let writeQueue = Promise.resolve();
let current = null;
let connecting = false;
let restoringLogin = false;
let loginError = '';
let syncJob = null;
let layoutJob = null;
let configuring = false;
let timer;
let areaTimer;
let quitting = false;
let pickedFolder = '';
let updater;
let update = null;
let applyingUpdate = false;
let restartForUpdate = false;
let terminalSession;

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
  const settings = db.workspaces[key];
  settings.areas ??= [];
  return settings;
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
  const { github: account, ...settings } = current ? workspace() : {};
  return {
    profile: current?.profile || db?.profile,
    connected: !!current,
    connecting: connecting || restoringLogin,
    hasRememberedLogin: !!db?.remembered,
    loginError,
    device,
    launchAtLogin: !!db?.launchAtLogin,
    settings: current ? settings : null,
    github: account ? { login: account.login, tracked: account.tracked } : null,
    runningAreas: [...areaJobs.keys()],
    sync: current?.sync || null,
    update
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
  window.on('closed', () => {
    window = undefined;
    void clearPreview();
    stopTerminal();
  });
  window.loadURL(page);
}

function installTray() {
  const settings = current && workspace();
  const shouldKeepRunning = settings && ((settings.automatic && settings.local && settings.remote) ||
    settings.areas.some(area => area.automatic));
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
    { label: '지금 동기화', click: () => { void runSync(true); void runAutomaticAreas(); } },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
  if (process.platform === 'win32') tray.on('double-click', showWindow);
}

function scheduleSync(immediate = false) {
  clearTimeout(timer);
  if (!current) return;
  const settings = workspace();
  if (!settings.remote || !settings.local) return;
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
    current = { profile, store, secret: renewed, remember, abort: new AbortController(), sync: null,
      reconnect: null, pickedAreaFolders: new Set() };
    workspace();
    await persist();
    installTray();
    scheduleSync(true);
    scheduleAreas(true);
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

async function decryptRememberedLogin(encrypted) {
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'));
  return JSON.parse(result);
}

async function restore() {
  if (!db.profile || !db.remembered) return;
  restoringLogin = true;
  try {
    await connect(db.profile, await decryptRememberedLogin(db.remembered), '', true, true);
  } catch (error) {
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

async function logout(forget = true) {
  const connection = current;
  if (!connection) return;
  current = null;
  connection.abort.abort(new Error('로그아웃했습니다.'));
  void clearPreview();
  stopTerminal();
  clearTimeout(timer);
  clearTimeout(areaTimer);
  pickedFolder = '';
  if (forget) db.remembered = null;
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
        await logout(renewError.dsmCode === 400);
        loginError = renewError.message;
        publish();
      }
      throw renewError;
    }
    signal.throwIfAborted();
    return action(connection.store, signal);
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
  syncJob = (async () => {
    try {
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
  })();
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

function separateFolder(local, others) {
  const normalized = value => {
    const resolved = path.resolve(value).normalize('NFC');
    return process.platform === 'linux' ? resolved : resolved.toLowerCase();
  };
  const inside = (parent, child) => {
    const relative = path.relative(normalized(parent), normalized(child));
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
  };
  if (others.some(other => other && (inside(local, other) || inside(other, local)))) {
    throw new Error('다른 동기화 영역과 겹치지 않는 저장 폴더를 선택하세요.');
  }
}

function githubAccount(connection, repository) {
  const account = workspace(connection).github;
  if (!account) throw new Error('GitHub 타일에서 계정을 연결하세요.');
  if (repository) {
    github.repositoryPath(repository);
    if (repository.split('/')[0].toLowerCase() !== account.login.toLowerCase()) {
      throw new Error('연결한 GitHub 계정의 저장소를 선택하세요.');
    }
  }
  return account;
}

async function githubToken(account) {
  const { result } = await safeStorage.decryptStringAsync(Buffer.from(account.token, 'base64'));
  return result;
}

function runArea(connection, area) {
  if (areaJobs.has(area.id)) return areaJobs.get(area.id);
  const job = Promise.resolve().then(async () => {
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
          return pullFiles(store, { remote: area.remote, local: root }, {
            signal: activeSignal, progress() {}, file(name) {
              fileCount++;
              if (files.length < 300) files.push(name);
            }
          });
        });
      } else {
        const token = area.source === 'github' ? await githubToken(githubAccount(connection, area.repository)) : undefined;
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
    } finally {
      areaJobs.delete(area.id);
      publish();
    }
  });
  areaJobs.set(area.id, job);
  publish();
  return job;
}

function scheduleAreas(immediate = false) {
  clearTimeout(areaTimer);
  if (!current || quitting || !workspace().areas.some(area => area.automatic)) return;
  areaTimer = setTimeout(() => { void runAutomaticAreas(); }, immediate ? 150 : workspace().interval * 60000);
}

async function runAutomaticAreas() {
  const connection = current;
  if (!connection || quitting || connection.automaticAreasRunning) return;
  clearTimeout(areaTimer);
  connection.automaticAreasRunning = true;
  try {
    const settings = workspace(connection);
    for (const area of [...settings.areas]) {
      if (current !== connection || quitting) return;
      if (area.automatic && area.source !== 'github' && settings.areas.includes(area)) await runArea(connection, area);
    }
  } finally {
    connection.automaticAreasRunning = false;
    if (current === connection) scheduleAreas();
  }
}

function bind(name, handler) {
  ipcMain.handle('launcher:' + name, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame?.url !== page ||
        event.senderFrame !== window.webContents.mainFrame) {
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
  const root = await fs.realpath(workspace(connection).local || app.getPath('downloads'));
  const directory = await fs.realpath(path.join(root, ...segments));
  const relative = path.relative(root, directory);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('다운로드 폴더 안의 경로를 선택하세요.');
  }
  const names = (await fs.readdir(directory)).filter(name => !/^\.sonac-[0-9a-f-]{36}\.part$/iu.test(name));
  const entries = await Promise.all(names.map(async name => {
    const info = await fs.lstat(path.join(directory, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!info) return null;
    return {
      name, path: (folder === '/' ? '' : folder) + '/' + name,
      directory: info.isDirectory(), size: info.isFile() ? info.size : null, modified: info.mtimeMs
    };
  }));
  connection.abort.signal.throwIfAborted();
  return { root, directory, entries: entries.filter(Boolean) };
}

async function selectedEntries(connection, source, folder, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(item => typeof item !== 'string')) {
    throw new Error('파일이나 폴더를 선택하세요.');
  }
  const selected = new Set(paths);
  const result = source === 'local' ? await listLocal(connection, folder) : {
    entries: await operate(connection, (store, signal) => store.list(remotePath(folder), signal))
  };
  const entries = result.entries.filter(entry => selected.has(entry.path) &&
    (source === 'local' || entry.name !== LAYOUT_FILE));
  if (entries.length !== selected.size) throw new Error('선택한 항목이 변경됐습니다. 목록을 새로고침해 주세요.');
  return { ...result, entries };
}

function terminalSize(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 500) {
    throw new Error('터미널 창 크기를 확인하세요.');
  }
}

function stopTerminal(id) {
  if (!terminalSession || (id && terminalSession.id !== id)) return;
  const { pty } = terminalSession;
  terminalSession = undefined;
  try { pty.kill(); } catch { /* process already ended */ }
}

function registerHandlers() {
  bind('state', status);
  bind('savedPassword', async ({ provider, url, user }) => {
    const { profile, remembered } = db;
    if (!remembered || current || connecting || restoringLogin ||
        profile?.provider !== provider || profile.url !== url || profile.user !== user) return '';
    const { password } = await decryptRememberedLogin(remembered);
    if (current || connecting || db.profile !== profile || db.remembered !== remembered) return '';
    return typeof password === 'string' ? password : '';
  });
  bind('installUpdate', async () => {
    if (applyingUpdate || quitting) return;
    if (!updater) throw new Error('설치할 업데이트가 없습니다.');
    applyingUpdate = true;
    try {
      await updater.prepare();
      while (!quitting && (syncJob || layoutJob || pendingOperations.size || areaJobs.size)) {
        await Promise.allSettled([syncJob, layoutJob, ...pendingOperations, ...areaJobs.values()]);
      }
      if (quitting) return;
      restartForUpdate = true;
      app.quit();
    } finally {
      applyingUpdate = false;
    }
  });
  bind('login', async (input) => {
    if (restoringLogin) throw new Error('이미 로그인 중입니다.');
    const { provider, user, password, otp, remember } = input;
    if (!['synology', 'webdav'].includes(provider) || typeof user !== 'string' || !user.trim() ||
        typeof password !== 'string' || !password || (otp && !/^\d{6}$/u.test(otp))) {
      throw new Error('사용자 이름, 비밀번호 및 OTP를 확인하세요.');
    }
    const profile = { provider, url: endpoint(input.url, provider), user: user.trim() };
    if (!current && areaJobs.size) await Promise.allSettled(areaJobs.values());
    await connect(profile, { password }, otp, remember === true);
    return status();
  });
  bind('logout', () => logout());
  bind('githubConnect', async input => {
    const connection = needConnection();
    const token = typeof input === 'string' ? input.trim() : '';
    if (!/^[\w-]{16,512}$/u.test(token)) throw new Error('GitHub 개인 액세스 토큰을 입력하세요.');
    const login = await github.identity(token, connection.abort.signal);
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('이 PC에서 GitHub 토큰을 암호화할 수 없습니다.');
    const encrypted = await safeStorage.encryptStringAsync(token);
    connection.abort.signal.throwIfAborted();
    const settings = workspace(connection);
    const tracked = settings.github?.login === login ? settings.github.tracked : [];
    settings.github = { login, token: encrypted.toString('base64'), tracked };
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
    return github.repositories(await githubToken(account), connection.abort.signal);
  });
  bind('githubCommit', async repository => {
    const connection = needConnection();
    const account = githubAccount(connection, repository);
    if (!account.tracked.includes(repository)) throw new Error('목록에 저장소를 추가하세요.');
    return github.latestCommit(repository, '', await githubToken(account), connection.abort.signal);
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
  bind('areaSave', async input => {
    const connection = needConnection();
    const settings = workspace(connection);
    const previous = input.id ? areaById(connection, input.id) : null;
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 60) throw new Error('영역 이름을 60자 이내로 입력하세요.');
    if (!input.local || (input.local !== previous?.local && !connection.pickedAreaFolders.has(input.local))) {
      throw new Error('이 PC의 저장 폴더를 선택하세요.');
    }
    if (previous && areaJobs.has(previous.id)) throw new Error('동기화가 끝난 뒤 수정하세요.');
    const area = { id: previous?.id || randomUUID(), name, source: input.source, local: input.local,
      automatic: input.automatic === true && input.source !== 'github' };
    if (area.source === 'nas') {
      area.remote = remotePath(input.remote);
      if (area.remote === '/' && connection.profile.provider === 'synology') throw new Error('NAS에서 공유 폴더를 선택하세요.');
      await operate(connection, (store, signal) => store.list(area.remote, signal));
    } else if (area.source === 'link') {
      area.url = httpsLink(input.url).href;
      area.filename = fileName(input.filename);
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
    if (previous && (!settings.areas.includes(previous) || areaJobs.has(previous.id))) {
      throw new Error('동기화가 끝난 뒤 다시 수정하세요.');
    }
    if (!previous && settings.areas.length >= 40) throw new Error('최대 40개 영역을 만들 수 있습니다.');
    separateFolder(area.local, [settings.local, ...settings.areas.filter(item => item !== previous).map(item => item.local)]);
    if (previous) {
      const fields = ['source', 'local', 'remote', 'url', 'filename', 'repository', 'branch'];
      if (fields.every(field => area[field] === previous[field])) area.last = previous.last;
      settings.areas.splice(settings.areas.indexOf(previous), 1, area);
    } else {
      settings.areas.push(area);
    }
    await persist();
    installTray();
    publish();
    scheduleAreas();
    if (area.automatic && current === connection && settings.areas.includes(area)) void runArea(connection, area);
  });
  bind('areaRemove', async id => {
    const connection = needConnection();
    const area = areaById(connection, id);
    if (areaJobs.has(id)) throw new Error('동기화가 끝난 뒤 영역을 삭제하세요.');
    const settings = workspace(connection);
    settings.areas = settings.areas.filter(item => item !== area);
    await persist();
    installTray();
    scheduleAreas();
    publish();
  });
  bind('areaRun', async id => {
    const connection = needConnection();
    const area = areaById(connection, id);
    if (areaJobs.has(id)) return;
    if (area.source === 'github') {
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: 'GitHub 최신 파일 적용', message: area.repository + '의 최신 커밋 파일을 적용할까요?',
        detail: area.local + '\n경로가 같은 파일의 로컬 수정 내용은 덮어씁니다.',
        buttons: ['취소', '최신 파일 적용'], defaultId: 0, cancelId: 0
      });
      if (result.response !== 1) return;
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
      separateFolder(input.local, settings.areas.map(area => area.local));
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
  bind('download', async (folder, paths) => {
    const connection = needConnection();
    const { entries } = await selectedEntries(connection, 'remote', folder, paths);
    const defaultPath = workspace(connection).local || app.getPath('downloads');
    const [file] = entries;
    if (entries.length === 1 && !file.directory) {
      if (path.basename(file.name) !== file.name || /[\\<>:"|?*]/u.test(file.name)) {
        throw new Error('다운로드할 수 없는 파일 이름입니다.');
      }
      const result = await dialog.showSaveDialog(window, {
        title: '다운로드 위치 선택', defaultPath: path.join(defaultPath, file.name)
      });
      if (result.canceled || !result.filePath) return null;
      await operate(connection, (store, signal) => downloadFile(store, file, result.filePath, { replace: true, signal }));
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
    return downloadSelection(store, entries, await fs.realpath(result.filePaths[0]), connection.abort.signal);
  });
  bind('delete', async (source, folder, paths) => {
    const connection = needConnection();
    if (!['local', 'remote'].includes(source) ||
        (source === 'remote' && connection.profile.provider === 'synology' && remotePath(folder) === '/')) {
      throw new Error('공유 폴더 안에서 삭제할 항목을 선택하세요.');
    }
    const { entries, directory } = await selectedEntries(connection, source, folder, paths);
    const names = entries.slice(0, 5).map(entry => entry.name).join('\n') +
      (entries.length > 5 ? '\n외 ' + (entries.length - 5) + '개' : '');
    const description = source === 'remote'
      ? '저장소에서 삭제합니다. 폴더를 선택하면 내부 파일도 함께 삭제됩니다.'
      : '이 PC의 휴지통으로 이동합니다.' + (workspace(connection).local ? ' 저장소에 남아 있는 파일은 다시 동기화될 수 있습니다.' : '');
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', title: '항목 삭제', message: '선택한 ' + entries.length + '개 항목을 삭제할까요?',
      detail: names + '\n\n' + description, buttons: ['취소', '삭제'], defaultId: 0, cancelId: 0
    });
    if (answer.response !== 1) return null;
    const result = { deleted: 0, errors: [] };
    for (const entry of entries) {
      connection.abort.signal.throwIfAborted();
      try {
        if (source === 'local') await shell.trashItem(path.join(directory, entry.name));
        else await operate(connection, (store, signal) => store.delete(entry, signal));
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
    const { entries: [entry], directory } = await selectedEntries(connection, source, folder, [item]);
    return createPreview(id, entry, {
      signal: connection.abort.signal,
      filename: directory ? path.join(directory, entry.name) : undefined,
      download: directory ? undefined : abort => operate(connection, (store, signal) =>
        store.download(entry.path, AbortSignal.any([abort, signal])))
    });
  });
  bind('closePreview', clearPreview);
  bind('openLink', async value => {
    needConnection();
    await shell.openExternal(webLink(value));
  });
  bind('terminal', (id, cols, rows) => {
    needConnection();
    if (!/^[\da-f-]{36}$/iu.test(id)) throw new Error('터미널 세션이 올바르지 않습니다.');
    terminalSize(cols, rows);
    stopTerminal();
    const native = require(app.isPackaged ? path.join(process.resourcesPath, 'node_modules', 'node-pty') : 'node-pty');
    const windows = process.platform === 'win32';
    const pty = native.spawn(windows ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh'),
      windows ? ['-NoLogo'] : ['-l'], {
        name: 'xterm-256color', cols, rows, cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    terminalSession = { id, pty };
    pty.onData(data => {
      if (terminalSession?.id === id) window?.webContents.send('launcher:terminal', { id, data });
    });
    pty.onExit(({ exitCode }) => {
      if (terminalSession?.id !== id) return;
      terminalSession = undefined;
      window?.webContents.send('launcher:terminal', { id, exitCode });
    });
  });
  bind('terminalWrite', (id, data) => {
    if (terminalSession?.id === id && typeof data === 'string') terminalSession.pty.write(data);
  });
  bind('terminalResize', (id, cols, rows) => {
    if (terminalSession?.id !== id) return;
    terminalSize(cols, rows);
    terminalSession.pty.resize(cols, rows);
  });
  bind('terminalClose', stopTerminal);
}

async function finishQuit() {
  try {
    if (restartForUpdate) await updater?.install(true);
  } catch {
    if (restartForUpdate) {
      quitting = false;
      restartForUpdate = false;
      dialog.showErrorBox('업데이트를 적용할 수 없습니다', '앱이 설치된 폴더의 쓰기 권한을 확인하세요.');
      return;
    }
  }
  updater?.stop();
  clearTimeout(timer);
  clearTimeout(areaTimer);
  current?.abort.abort();
  await Promise.allSettled(areaJobs.values());
  stopTerminal();
  await clearPreview();
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
    db = await readDB();
    if (process.platform === 'darwin') {
      const menu = Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]);
      Menu.setApplicationMenu(menu);
      if (!app.isPackaged) app.dock.setIcon(iconPath);
    }
    protocol.handle('sonac', serve);
    registerHandlers();
    showWindow();
    updater = createUpdater({
      version: app.getVersion(), publicKey: app.isPackaged ? updatePublicKey : null, baseURL: updateURL,
      publish(value) { update = value; publish(); }
    });
    updater.start();
    powerMonitor.on('resume', () => {
      scheduleSync(true);
      scheduleAreas(true);
      updater.check();
    });
    void restore();
  }).catch(error => {
    dialog.showErrorBox(productName, displayError(error));
    app.quit();
  });
}
