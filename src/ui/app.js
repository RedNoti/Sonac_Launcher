'use strict';

const api = window.launcher;
const $ = id => document.getElementById(id);
const elements = (id) => $(id).elements;
const serverTile = ['server-update', '서버 업데이터', 'sync'];
const groups = [
  { id: 'synology', title: 'SYNOLOGY', tiles: [['dsm', '파일 스테이션']] },
  { id: 'media', title: '미디어', tiles: [['video', '영상 플레이어'], ['audio', '음악 플레이어']] },
  { id: 'git', title: 'GIT', tiles: [['github', 'GitHub'], ['terminal', '터미널']] },
  { id: 'services', title: '서비스', tiles: [['ai-assistant', 'AI', 'sparkles']] }
];
const shortDate = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let state;
let loginPending = false;
let toastTimer;
let browserPath = '/';
let browserMode = null;
let browserTrigger;
let pickerDialog;
let mediaPicker;
let choosingAiAttachments = false;
let musicOpen = false;
let videoOpen = false;
let subtitleUrl;
let subtitleRequest;
const players = {
  audio: { entries: [], name: '음악' },
  video: { entries: [], subtitles: [], name: '영상' }
};
let settingsOpen = false;
let settingsTrigger;
let settingsSection = 'account';
const settingsSections = $('settings-nav').querySelectorAll('[data-settings-section]');
let browserFolders = {};
let browserView = 'grid';
let browserEntries = [];
let selected = new Set();
let nasClipboard;
let selectionAnchor = null;
let previewJob;
let menuTrigger;
let browseGeneration = 0;
let transferring = false;
let loadingFolder = false;
let updateRequested = false;
let signinCurrentTimer;
let pageTransition;
let pageChangePending = false;
let pendingPageState;

function navigate(change, browserMotion) {
  if (pageTransition) return;
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.visibilityState !== 'visible') {
    change();
    return;
  }
  if (browserMotion) document.documentElement.dataset.browserMotion = browserMotion;
  pageChangePending = true;
  const transition = document.startViewTransition(() => {
    pageChangePending = false;
    try {
      change();
    } finally {
      if (pendingPageState) {
        const next = pendingPageState;
        pendingPageState = undefined;
        apply(next, false);
      }
    }
  });
  pageTransition = transition;
  const finish = () => {
    pageTransition = undefined;
    delete document.documentElement.dataset.browserMotion;
  };
  void transition.finished.then(finish, finish);
  void transition.ready.catch(() => {});
}

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
  if (id === 'browser-status' && message && state && typeof fileTransferBar !== 'undefined') {
    finishFileTransfer('files', message, error);
    message = '';
  }
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
let serverLoginPending = false;
let servicePage;
let editingUsage = false;
let usageStep = 0;
let usageMoving = false;
let usageSaving = false;
let usageConnection;
let aiChats = [];
let activeAiChat;
let aiRequest;
let aiBackPage;
let aiLoginPending = false;
let aiStatusTimer;
let aiHistoryLoad;
let aiTitleTimer;
let selectedNas;

function showOtp(visible) {
  const form = elements('login-form');
  $('otp-label').hidden = !visible;
  form.otp.disabled = !visible;
  form.otp.required = visible;
  if (!visible) form.otp.value = '';
}

function selectNas(profile, { mode = profile ? 'login' : 'register', focus = false } = {}) {
  const changed = servicePage === 'server' || loginMode !== mode || selectedNas?.id !== profile?.id;
  if (servicePage === 'server') servicePage = undefined;
  loginMode = mode;
  selectedNas = profile;
  const form = elements('login-form');
  const configuring = mode === 'register' || mode === 'edit';
  form.name.value = profile?.name || '';
  form.url.value = profile?.url || '';
  form.user.value = profile?.user || '';
  form.password.value = '';
  form.pin.value = profile?.pin || '';
  form.remember.checked = !!profile?.saved;
  form.user.readOnly = mode === 'login';
  form.name.disabled = form.url.disabled = form.pin.disabled = !configuring;
  $('nas-name-label').hidden = $('address-label').hidden = $('pin-details').hidden = !configuring;
  $('pin-details').open = configuring && !!form.pin.value;
  $('nas-edit').setAttribute('aria-label', mode === 'edit' ? '수정 취소' : 'NAS 연결 수정');
  $('nas-edit').title = $('nas-edit').getAttribute('aria-label');
  showOtp(false);
  drawNasProfiles();
  savedLoginHint();
  drawLoginButton();
  drawConnectionForm();
  if (focus) {
    if (changed) animateSigninPanel();
    (configuring ? form.name : form.password).focus();
  }
}

function drawLoginButton() {
  const button = $('login-button');
  const updating = updateRequested || state.applyingUpdate;
  button.disabled = serverLoginPending || loginPending || state.connecting || updating;
  button.textContent = updating ? '업데이트 중…' : state.connecting ? '연결 중…' :
    loginMode === 'register' ? '등록하고 로그인' : loginMode === 'edit' ? '저장하고 로그인' : '로그인';
}

function drawConnectionForm() {
  const setupAccount = usageStep === 2 && usageConnection;
  const server = setupAccount ? usageConnection === 'server' : servicePage === 'server';
  const serverOnly = !setupAccount && state.usageMode === 'server';
  const showStatus = serverOnly && !server;
  $('signin').dataset.nasConfiguring = String(!server && !serverOnly && loginMode !== 'login');
  $('connection-card').hidden = showStatus;
  $('signin-service-status').hidden = !showStatus;
  if (showStatus) drawSigninServiceStatus();
  $('login-form').hidden = server || serverOnly;
  $('server-login').hidden = !server;
  $('nas-edit').hidden = server || !selectedNas;
  $('server-login-submit').disabled = serverLoginPending || !!state?.serverRestoring ||
    updateRequested || !!state?.applyingUpdate;
  $('server-login-back').hidden = !!setupAccount;
  $('login-title').textContent = server ? '서버 업데이터 로그인' : loginMode === 'edit' ? 'NAS 연결 수정' :
    selectedNas ? selectedNas.name || new URL(selectedNas.url).host : 'Synology NAS 등록';
}

let signinPanelMotion;
function animateSigninPanel() {
  if ($('signin').hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const panel = $('connection-card').hidden ? $('signin-service-status') : $('connection-card');
  signinPanelMotion?.cancel();
  signinPanelMotion = panel.animate([
    { opacity: 0, transform: 'translateY(7px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' });
}

function drawSigninServiceStatus() {
  const account = state.serverUpdaterAccount;
  const restoring = state.serverRestoring;
  $('signin-server-state').textContent = account ? '로그인됨' : restoring ? '자동 로그인 중…' : '로그인 필요';
  $('signin-server-dot').className = 'dot' + (account ? ' good' : restoring ? ' active' : '');
  const files = account ? '연결된 배포 파일 ' + account.files.length + '개' : state.serverAuthError;
  notice('signin-server-detail', files);
  const observed = account?.monitoring?.enabled ? account.monitoring.targets.filter(target => target.latest) : [];
  const unhealthy = observed.filter(target => target.latest.status !== 'healthy').length;
  const installed = account?.files.filter(file => file.installed) ?? [];
  const running = installed.filter(file => file.phase === 'running').length;
  $('signin-deployment-state').textContent = observed.length
    ? '최근 정상 ' + (observed.length - unhealthy) + '개 · 이상 ' + unhealthy + '개'
    : installed.length ? '실행 중 ' + running + '개 · 설치됨 ' + installed.length + '개' : '실행 상태 확인 안 됨';
  $('signin-deployment-dot').className = 'dot' + (observed.length ? unhealthy ? ' warn' : ' good' : running ? ' good' : '');

  const update = state.update;
  const tag = update?.tag || update?.version;
  const phases = {
    checking: ['확인 중…', 'active'],
    current: ['최신 버전 사용 중', 'good'],
    available: [tag ? tag + ' 업데이트 가능' : '업데이트 가능', 'warn'],
    downloading: ['다운로드 중 · ' + (update?.percent ?? 0) + '%', 'active'],
    ready: ['설치 준비 완료', 'warn'],
    missing: ['릴리스 파일 확인 필요', 'warn'],
    error: ['업데이트 확인 실패', 'warn'],
    unsupported: ['자동 업데이트 미지원', '']
  };
  const [label, tone] = updateRequested || state.applyingUpdate
    ? ['업데이트 진행 중…', 'active'] : phases[update?.phase] ?? ['아직 확인하지 않음', ''];
  $('signin-update-state').textContent = label;
  $('signin-update-dot').className = tone ? 'dot ' + tone : 'dot';
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
  $('nas-profiles').replaceChildren(...buttons, add);
}

function drawSigninLoading() {
  const updating = !state.connected && (updateRequested || state.applyingUpdate);
  const busy = updating || (!state.connected && (serverLoginPending || state.serverRestoring || loginPending || state.connecting));
  const message = updating ? '업데이트 중…' : state.serverRestoring ? '서버 업데이터 로그인 복원 중…' : '로그인 중…';
  const loadingStatus = $('signin-loading-status');
  if (busy && loadingStatus.textContent !== message) loadingStatus.textContent = message;
  $('signin-update').inert = busy;
  $('signin-sources').inert = busy;
  $('nas-profiles').inert = busy;
  $('nas-edit').disabled = busy;
  $('login-form').inert = busy;
  $('server-login').inert = busy;
  $('signin-loading').hidden = !busy;
}

function showPage() {
  const choosing = !state.usageMode || editingUsage;
  const showServer = !!state.serverUpdaterAccount && servicePage === 'server';
  const showSettings = settingsOpen && !choosing && !browserMode;
  const aiOpen = servicePage === 'ai' && (state.connected || state.serverUpdaterAccount);
  const showAi = aiOpen && !!state.aiEmail;
  const showAiLogin = aiOpen && !state.aiEmail;
  const aiBusy = aiLoginPending || state.serverRestoring || state.applyingUpdate;
  $('ai-login').hidden = choosing || showSettings || !showAiLogin;
  $('ai-login-form').inert = aiBusy;
  $('ai-login-submit').textContent = aiBusy ? '로그인 중…' : '로그인';
  const setup = $('usage-setup');
  if (!choosing) setup.hidden = true;
  else if (setup.hidden) {
    setup.hidden = false;
    drawUsage();
    setup.querySelectorAll('.usage-step h1')[usageStep].focus();
  }
  const signin = $('signin');
  signin.dataset.serverOnly = String(state.usageMode === 'server');
  signin.hidden = choosing || showSettings || !!(state.connected || showServer || aiOpen);
  $('nas-selection-title').textContent = state.usageMode === 'server' ? '서비스 선택' : '저장소 선택';
  $('nas-profiles').hidden = choosing && usageStep === 2 ? usageConnection === 'server' : state.usageMode === 'server';
  $('signin-services').hidden = state.usageMode === 'nas';
  $('server-home').hidden = choosing || showSettings || !showServer;
  if ($('server-home').hidden && logProject) closeServerLogs();
  $('settings-page').hidden = !showSettings;
  if (showSettings) drawSettings();
  $('ai-home').hidden = choosing || showSettings || !showAi;
  if ($('ai-home').hidden) $('ai-usage').open = false;
  drawSigninLoading();
  drawConnectionForm();
  $('signin-version').hidden = !state.versionLabel || ($('signin').hidden && api.browserPreview !== true);
  const home = $('home');
  const showVideo = videoOpen && state.connected && !choosing && !showSettings && !browserMode && !state.terminalOpen;
  $('video-page').hidden = !showVideo;
  const hideHome = showVideo || choosing || showSettings || !state.connected || !!showServer || !!aiOpen || !!browserMode || githubOpen || state.terminalOpen;
  if (home.hidden && !hideHome) home.style.setProperty('--tile-page-delay', pageTransition ? '260ms' : '0ms');
  home.hidden = hideHome;
  drawMusicPanel();
  $('github-page').hidden = !state.connected || !!browserMode || !githubOpen;
  $('browser').hidden = !state.connected || !browserMode;
}

function drawUsage() {
  const mode = elements('usage-choice').mode.value;
  const summaries = {
    nas: '시작 화면에서 NAS를 선택하고 연결할 수 있어요.',
    server: '시작 화면에서 서버 업데이터를 열 수 있어요.',
    both: '시작 화면에서 NAS를 연결하거나 서버 업데이터를 열 수 있어요.'
  };
  $('usage-summary').textContent = summaries[mode] ?? '';
  const busy = usageMoving || usageSaving || loginPending || serverLoginPending;
  $('usage-prev').hidden = usageStep === 0 || usageStep === 3;
  $('usage-prev').disabled = busy;
  $('usage-close').hidden = !editingUsage || usageStep === 3;
  $('usage-close').disabled = busy;
  $('usage-next').hidden = usageStep === 2;
  $('usage-next').disabled = usageMoving || usageSaving || (usageStep === 1 && !mode);
  $('usage-next').textContent = ['시작하기', '다음', '', '열기'][usageStep];
  $('usage-account-title').textContent = usageConnection === 'server' ? '서버 업데이터 계정 연결' : 'NAS 계정 연결';
  $('nas-profiles').hidden = usageStep === 2 ? usageConnection === 'server' : state?.usageMode === 'server';
  const total = mode === 'both' ? 5 : 4;
  const position = usageStep + (total === 5 && (usageStep === 3 || usageStep === 2 && usageConnection === 'nas') ? 1 : 0);
  const progress = $('usage-form').querySelector('.usage-progress');
  progress.setAttribute('aria-valuemax', String(total));
  progress.setAttribute('aria-valuenow', String(position + 1));
  for (const [index, dot] of Array.from(progress.children).entries()) {
    dot.hidden = index >= total;
    dot.className = index === position ? 'current' : index < position ? 'completed' : '';
  }
}

function placeUsageAccount(inSetup) {
  const profiles = $('nas-profiles');
  const form = $('connection-card');
  if (inSetup) {
    $('usage-account-slot').append(profiles, form);
  } else {
    $('signin-services').before(profiles);
    $('signin').append(form);
  }
}

async function moveUsageStep(index) {
  if (usageMoving || usageSaving || index === usageStep) return;
  const steps = $('usage-form').querySelectorAll('.usage-step');
  const from = steps[usageStep];
  const to = steps[index];
  const direction = Math.sign(index - usageStep);
  if (index === 2) placeUsageAccount(true);
  to.hidden = false;
  from.inert = to.inert = true;
  usageMoving = true;
  usageStep = index;
  drawUsage();
  drawConnectionForm();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && typeof to.animate === 'function') {
    const timing = { easing: 'cubic-bezier(.22, 1, .36, 1)' };
    const leaving = from.animate([{ opacity: 1, transform: 'translateX(0)' },
      { opacity: 0, transform: 'translateX(' + (-direction * 36) + 'px)' }], { ...timing, duration: 300, fill: 'forwards' });
    const entering = to.animate([{ opacity: 0, transform: 'translateX(' + (direction * 36) + 'px)' },
      { opacity: 1, transform: 'translateX(0)' }], { ...timing, duration: 450 });
    await Promise.allSettled([leaving.finished, entering.finished]);
    leaving.cancel();
  }
  from.hidden = true;
  if (index !== 2 && from.classList.contains('usage-account')) placeUsageAccount(false);
  to.inert = false;
  usageMoving = false;
  drawUsage();
  to.querySelector('h1').focus();
}

async function advanceUsageAccount(next) {
  apply(next, false);
  if (usageConnection === 'server' && elements('usage-choice').mode.value === 'both') {
    apply(await api.serverUpdaterLogout(false), false);
    usageConnection = 'nas';
    drawUsage();
    showPage();
    $('usage-account-title').focus();
    return;
  }
  await moveUsageStep(3);
  usageConnection = undefined;
}

const deploymentLabels = {
  new: '설치 전', downloading: '다운로드 중', extracting: '압축 해제 중', starting: '시작 중',
  running: '실행 중', stopping: '정지 중', stopped: '정지됨', failed: '실행 실패'
};
let deployProject;
let logProject;
let logTimer;

const serverPanelTimers = new Map();
function setServerPanel(id, control, open, duration) {
  const panel = $(id);
  clearTimeout(serverPanelTimers.get(id));
  $(control).setAttribute('aria-expanded', String(open));
  panel.inert = !open;
  if (open) {
    panel.hidden = false;
    void panel.offsetHeight;
    panel.dataset.open = '';
  } else {
    delete panel.dataset.open;
    if (reducedMotion.matches) panel.hidden = true;
    else serverPanelTimers.set(id, setTimeout(() => { panel.hidden = true; }, duration));
  }
}
function setServerMonitoringView(open) {
  setServerPanel('server-monitor-controls', 'server-monitor-options-button', open, 220);
}
function setServerRegistration(open) {
  setServerPanel('server-monitor-add', 'server-monitor-register', open, 500);
  if (open) elements('server-monitor-target').name.focus({ preventScroll: true });
}

async function showDeployment(file) {
  const assets = await api.serverAssets(file.id);
  if (!state.serverUpdaterAccount?.files.some(item => item.id === file.id) || $('server-home').hidden) return;
  deployProject = file.id;
  $('server-deploy-name').textContent = file.name;
  $('server-deploy-asset').replaceChildren(...assets.map(({ id, name, size, tag }) => {
    const option = make('option', tag + ' · ' + name + ' · ' + Math.ceil(size / 1024 ** 2) + ' MiB');
    option.value = id;
    return option;
  }));
  if (!$('server-deploy-dialog').open) $('server-deploy-dialog').showModal();
}

function closeServerLogs() {
  logProject = undefined;
  clearTimeout(logTimer);
  const panel = $('server-log-panel');
  panel.hidden = true;
  $('server-home').append(panel);
  for (const control of $('server-file-list').querySelectorAll('[aria-controls="server-log-panel"]')) {
    control.setAttribute('aria-expanded', 'false');
  }
}

async function refreshServerLogs(project) {
  if (logProject !== project) return;
  const output = $('server-log-output');
  const log = await api.serverLogs(project.id).catch(error => error.message);
  if (logProject !== project) return;
  const text = log || '아직 기록된 로그가 없습니다.';
  if (output.textContent !== text) {
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 35;
    output.textContent = text;
    if (follow) output.scrollTop = output.scrollHeight;
  }
  logTimer = setTimeout(() => void refreshServerLogs(project), 750);
}

function serverOverview(account) {
  const { files, monitoring } = account;
  const running = files.filter(file => file.phase === 'running').length;
  const failures = files.filter(file => file.phase === 'failed').length;
  const latest = files.filter(file => file.updatedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const targets = monitoring?.targets ?? [];
  const normal = targets.filter(target => target.latest?.status === 'healthy').length;
  const checked = Math.max(0, ...targets.map(target => target.latest?.at ?? 0));
  $('server-overview-running').textContent = running + ' / ' + files.length + ' 실행 중';
  $('server-overview-running-note').textContent = failures ? '실행 실패 ' + failures + '개' : files.length ? '등록된 프로젝트 기준' : '등록된 프로젝트 없음';
  $('server-overview-healthy').textContent = normal + ' / ' + targets.length + ' 정상';
  $('server-overview-healthy-note').textContent = checked ? shortDate.format(checked) : targets.length ? '상태 확인 대기' : '등록된 웹페이지 없음';
  $('server-overview-release').textContent = latest?.installed ?? '—';
  $('server-overview-release-note').textContent = latest ? latest.name + ' · ' + shortDate.format(latest.updatedAt) : '기록된 업데이트 없음';
}

function serverStatus(label, tone) {
  const status = make('span', '', 'server-state');
  status.dataset.tone = tone;
  status.append(make('span', '', 'dot'), make('span', label));
  return status;
}

function drawServerProjectTiles(files) {
  const tiles = $('server-home-tiles');
  const focused = tiles.contains(document.activeElement) ? document.activeElement.dataset.project : undefined;
  for (const shortcut of tiles.querySelectorAll('.server-project-shortcut')) shortcut.remove();
  const shortcuts = (files ?? []).map(file => {
    const shortcut = tile(file.name, 'dsm', () => {
      const card = [...$('server-file-list').children].find(item => item.dataset.project === file.id);
      card?.focus();
    });
    const phase = file.phase ?? 'new';
    const label = deploymentLabels[phase];
    shortcut.dataset.project = file.id;
    shortcut.append(make('span', label, 'server-tile-state'));
    shortcut.dataset.phase = phase;
    shortcut.title = file.name + ' · ' + label;
    return shortcut;
  });
  if (files && !files.length) shortcuts.push(tile('프로젝트 연결', 'dsm', openServerProjectForm, 'add'));
  for (const shortcut of shortcuts) shortcut.classList.add('server-project-shortcut');
  tiles.prepend(...shortcuts);
  if (focused) shortcuts.find(item => item.dataset.project === focused)?.focus({ preventScroll: true });
}

function drawServerHome(previous) {
  const account = state.serverUpdaterAccount;
  drawServerMonitoring(account?.monitoring, previous?.monitoring);
  if (account?.githubLogin !== previous?.githubLogin || !account) {
    $('server-github-repo-field').hidden = true;
    $('server-github-repo').replaceChildren(make('option', '저장소 선택'));
    $('server-github-repo').firstElementChild.value = '';
  }
  const githubLogin = account?.githubLogin;
  $('server-github-open').textContent = githubLogin ? 'GitHub · @' + githubLogin : 'GitHub 연결';
  $('server-github-account').textContent = githubLogin ? '연결된 계정 @' + githubLogin : '';
  $('server-github-disconnect').hidden = !githubLogin;
  if (!account) {
    if (previous) {
      closeServerLogs();
      setServerMonitoringView(false);
      setServerRegistration(false);
      setServerProjectForm(false);
      $('server-file-form').reset();
      $('server-file-list').replaceChildren();
      drawServerProjectTiles(null);
      $('server-home-account').textContent = '';
      notice('server-home-error');
    }
    return;
  }
  $('server-home-account').textContent = account.email;
  serverOverview(account);
  if (JSON.stringify(account.files) === JSON.stringify(previous?.files)) return;
  drawServerProjectTiles(account.files);
  const report = error => notice('server-home-error', error.message, true);
  const logPanel = $('server-log-panel');
  if (logProject && !account.files.some(file => file.id === logProject.id)) closeServerLogs();
  const activeElement = document.activeElement;
  const focusedAction = activeElement.closest('.server-project-card')?.dataset.project;
  const focusedLabel = activeElement.getAttribute('aria-label');
  const cards = account.files.map(file => {
    const card = make('article', '', 'server-project-card');
    card.dataset.project = file.id;
    card.tabIndex = -1;
    const row = make('div', '', 'work-row');
    const identity = make('div', '', 'server-project-identity');
    const badge = make('span', '', 'server-project-icon');
    badge.append(icon('dsm', '#a9c6f8'));
    identity.append(badge, make('h3', file.name));
    const phase = file.phase ?? 'new';
    const pending = ['downloading', 'extracting', 'starting', 'stopping'].includes(phase);
    const tone = phase === 'running' ? 'good' : phase === 'failed' ? 'bad' : pending ? 'warn' : 'idle';
    identity.append(serverStatus(deploymentLabels[phase], tone));
    row.append(identity);
    if (file.installed) row.append(make('span', file.installed, 'work-meta server-release-tag'));
    const actions = make('div', '', 'work-actions');
    const command = (label, action, { disabled = false, style, glyph } = {}) => {
      const control = make('button', glyph ? '' : label, style);
      control.type = 'button';
      control.disabled = disabled;
      if (glyph) {
        control.classList.add('server-icon-button');
        control.title = label;
        control.setAttribute('aria-label', label);
        control.append(icon(glyph, '#dbe7ff'));
      }
      control.addEventListener('click', busy(control, async () => {
        notice('server-home-error');
        await action();
      }, report));
      return control;
    };
    const logs = command('로그', () => {
      if (logProject?.id === file.id) {
        closeServerLogs();
        return;
      }
      closeServerLogs();
      logProject = file;
      $('server-log-output').textContent = '';
      logPanel.hidden = false;
      card.append(logPanel);
      logs.setAttribute('aria-expanded', 'true');
      void refreshServerLogs(file);
    }, { glyph: 'terminal' });
    logs.setAttribute('aria-controls', 'server-log-panel');
    logs.setAttribute('aria-expanded', String(logProject?.id === file.id));
    const more = make('details', '', 'server-project-more');
    const summary = make('summary', '', 'server-icon-button');
    summary.setAttribute('aria-label', '더보기');
    summary.title = '더보기';
    summary.append(icon('more', '#dbe7ff'));
    const options = make('div', '', 'server-project-menu');
    options.append(
      command('배포 폴더', () => api.serverDeploymentFolder(file.id), { disabled: !file.installed || pending }),
      command('설정 폴더', () => api.serverDataFolder(file.id)),
      command('연결 해제', () => api.serverFileRemove(file.id), { disabled: pending || phase === 'running', style: 'danger' })
    );
    options.addEventListener('click', () => { more.open = false; });
    more.append(summary, options);
    actions.append(
      command('업데이트', () => showDeployment(file), { disabled: pending, style: 'primary' }),
      phase === 'running' ? command('정지', () => api.serverStop(file.id), { glyph: 'stop' })
        : command('실행', () => api.serverRun(file.id), { glyph: 'play', disabled: pending || !file.installed }),
      logs,
      command('GitHub에서 열기', () => api.serverFileOpen(file.id), { glyph: 'github' }),
      more
    );
    card.append(row, make('p', file.url, 'work-meta server-project-url'));
    if (['downloading', 'extracting', 'starting'].includes(phase) && file.updating) {
      const steps = make('ol', '', 'server-update-steps');
      steps.setAttribute('aria-label', '업데이트 진행 단계');
      const phases = ['downloading', 'extracting', 'starting'];
      ['릴리스 다운로드', '압축 해제', '서버 실행'].forEach((label, index) => {
        const step = make('li', label);
        if (index < phases.indexOf(phase)) step.dataset.done = 'true';
        if (phases[index] === phase) step.setAttribute('aria-current', 'step');
        steps.append(step);
      });
      card.append(steps);
    }
    card.append(actions);
    return card;
  });
  $('server-file-list').replaceChildren(...cards);
  if (logProject) cards.find(card => card.dataset.project === logProject.id)?.append(logPanel);
  if (focusedAction && focusedLabel) cards.find(card => card.dataset.project === focusedAction)
    ?.querySelectorAll('[aria-label]').forEach(control => {
      if (control.getAttribute('aria-label') === focusedLabel && !control.disabled) control.focus({ preventScroll: true });
    });
}

function drawServerMonitoring(monitoring, previous) {
  $('server-monitor-toggle').hidden = !monitoring;
  $('server-monitor-check').disabled = !!monitoring?.checking || !monitoring?.targets.length;
  $('server-monitor-check').replaceChildren(icon('sync'), monitoring?.checking ? '확인 중…' : '전체 확인');
  const form = elements('server-monitor-settings');
  if (!monitoring) {
    if (previous) {
      $('server-monitor-settings').reset();
      $('server-monitor-target').reset();
    }
    return;
  }
  $('server-monitor-summary').textContent = (monitoring.enabled ? '모니터링 켜짐' : '모니터링 꺼짐') +
    ' · 등록된 서비스 ' + monitoring.targets.length + '개';
  $('server-monitor-summary').classList.toggle('monitoring-live', monitoring.enabled);
  if (!previous || monitoring.enabled !== previous.enabled || monitoring.time !== previous.time ||
      monitoring.hasWebhook !== previous.hasWebhook || monitoring.deliveryEnabled !== previous.deliveryEnabled) {
    form.enabled.checked = monitoring.enabled;
    form.deliveryEnabled.checked = monitoring.deliveryEnabled ?? monitoring.hasWebhook;
    form.time.value = monitoring.time;
    form.removeWebhook.checked = false;
    form.webhook.placeholder = monitoring.hasWebhook ? '저장됨 · 바꾸려면 새 주소 입력' : '선택 사항';
    $('server-monitor-remove-webhook').hidden = !monitoring.hasWebhook;
  }
  const container = $('server-monitor-targets');
  const existing = new Map([...container.querySelectorAll('.server-monitor-card')].map(row => [row.dataset.target, row]));
  container.querySelector('.server-sites-empty')?.remove();
  const ids = new Set(monitoring.targets.map(target => target.id));
  for (const [id, row] of existing) {
    if (!ids.has(id) && !row.hasAttribute('data-removing')) {
      row.dataset.removing = '';
      row.inert = true;
      clearTimeout(row.armTimer);
      setTimeout(() => row.remove(), reducedMotion.matches ? 0 : 350);
    }
  }
  const labels = { healthy: '정상', degraded: '느림', down: '응답 없음' };
  monitoring.targets.forEach((target, index) => {
    let row = existing.get(target.id);
    if (!row || row.hasAttribute('data-removing')) {
      row = make('article', '', 'server-monitor-card');
      row.dataset.target = target.id;
      row.style.setProperty('--site-index', index);
      const name = make('div', '', 'server-site-name');
      name.append(make('span', '', 'server-site-dot'), make('h3', target.name));
      const address = make('p', target.url, 'server-site-url');
      address.title = target.url;
      const latency = make('div', '', 'server-site-latency');
      latency.setAttribute('aria-hidden', 'true');
      latency.append(make('span'));
      const check = button('', () => void checkServerSites(target.id), 'server-icon-button');
      check.title = '다시 확인';
      check.setAttribute('aria-label', target.name + ' 다시 확인');
      check.append(icon('sync', 'currentColor'));
      const remove = button('', () => {
        if (!remove.classList.contains('armed')) {
          remove.classList.add('armed');
          remove.setAttribute('aria-label', target.name + ' 한 번 더 누르면 삭제');
          remove.title = '한 번 더 누르면 삭제';
          row.armTimer = setTimeout(() => {
            remove.classList.remove('armed');
            remove.setAttribute('aria-label', target.name + ' 제거');
            remove.title = '제거';
          }, 2500);
          return;
        }
        clearTimeout(row.armTimer);
        void busy(remove, async () => {
          apply(await api.serverMonitorTarget(target.id, true));
          toast('서비스를 삭제했습니다.');
        }, error => { remove.classList.remove('armed'); notice('server-monitor-error', error.message, true); })();
      }, 'server-icon-button server-site-remove');
      remove.setAttribute('aria-label', target.name + ' 제거');
      remove.title = '제거';
      remove.append(icon('fsDelete', 'currentColor'));
      const footer = make('div', '', 'server-site-footer');
      footer.append(make('span', '', 'server-site-result'), check, remove);
      row.append(name, address, latency, footer);
      container.append(row);
    }
    const { status, latencyMs } = target.latest ?? {};
    const checking = serverSiteChecks.has('*') || serverSiteChecks.has(target.id) || !!monitoring.checking && !serverSiteChecks.size;
    row.dataset.tone = checking ? 'checking' : ({ healthy: 'good', degraded: 'warn', down: 'bad' }[status] ?? 'idle');
    row.setAttribute('aria-busy', String(checking));
    const issue = { timeout: '응답 시간 초과', network: '연결 실패', dns: '도메인 확인 실패', refused: '연결 거부', tls: '인증서 오류' }[target.latest?.issue] ||
      (target.latest?.httpStatus && (target.latest.httpStatus < 200 || target.latest.httpStatus >= 300) ? 'HTTP ' + target.latest.httpStatus : '상태 점검 오류');
    row.querySelector('.server-site-result').textContent = checking ? '확인 중…' : status === 'down' ? issue :
      [labels[status] ?? '확인 대기', Number.isFinite(latencyMs) ? latencyMs + 'ms' : ''].filter(Boolean).join(' · ');
    row.querySelector('.server-site-latency span').style.width = (checking ? 0 : status === 'down' ? 100 :
      Number.isFinite(latencyMs) ? Math.min(100, Math.max(0, latencyMs / 15)) : 0) + '%';
    row.querySelector('.server-icon-button').disabled = !!monitoring.checking || !!serverSiteChecks.size;
  });
  if (!monitoring.targets.length && !container.querySelector('.server-sites-empty')) {
    container.append(make('p', '서비스를 등록하면 상태와 응답 시간을 확인할 수 있습니다.', 'work-meta server-sites-empty'));
  }
  for (const choice of $('server-monitor-times').querySelectorAll('button')) choice.setAttribute('aria-pressed', String(choice.dataset.time === form.time.value));
  if (monitoring.error !== previous?.error) notice('server-monitor-error', monitoring.error, true);
  drawServerReports(monitoring, previous);
}

function drawServerReports(monitoring, previous) {
  const time = monitoring.time || '09:00';
  const [hour, minute] = time.split(':');
  const timeLabel = (Number(hour) >= 12 ? '오후 ' : '오전 ') + (Number(hour) % 12 || 12) + ':' + minute;
  const deliveryOn = monitoring.hasWebhook && monitoring.deliveryEnabled !== false;
  $('server-report-schedule').textContent = '매일 ' + timeLabel + ' (한국 시간) · ' +
    (deliveryOn ? 'Discord 전송' : '런처에 저장');
  const list = $('server-report-list');
  const signature = JSON.stringify([monitoring.dailyReports, monitoring.latestReport]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const expanded = new Set([...list.querySelectorAll('.server-report-card.is-open')].map(card => card.dataset.report));
  const firstDraw = !list.querySelector('.server-report-card');
  const history = [...(monitoring.dailyReports ?? [])];
  if (monitoring.latestReport && !history.some(report => report.at === monitoring.latestReport.at)) history.unshift(monitoring.latestReport);
  const delivery = { local: '런처에 저장됨', sent: 'Discord 전송 완료', failed: 'Discord 전송 실패', unconfirmed: 'Discord 전송 확인 대기' };
  list.replaceChildren(...history.map((report, index) => {
    const observedDay = report.day || /\b(\d{4}-\d{2}-\d{2})$/u.exec(report.title)?.[1];
    const date = new Date(observedDay ? observedDay + 'T00:00:00+09:00' : report.at);
    const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', weekday: 'short' })
      .formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    const card = make('article', '', 'server-report-card');
    card.style.setProperty('--report-index', index);
    card.dataset.report = String(report.at);
    const open = expanded.has(card.dataset.report) || (firstDraw && index === 0);
    card.classList.toggle('is-open', open);
    const header = button('', null, 'server-report-toggle');
    header.setAttribute('aria-expanded', String(open));
    const body = make('div', '', 'server-report-body');
    body.id = 'server-report-body-' + index;
    body.inert = !open;
    header.setAttribute('aria-controls', body.id);
    header.addEventListener('click', () => {
      const expanded = card.classList.toggle('is-open');
      header.setAttribute('aria-expanded', String(expanded));
      body.inert = !expanded;
    });
    const dateTile = make('span', '', 'server-report-date');
    dateTile.append(make('strong', part('day')), make('small', part('month') + '월 · ' + part('weekday')));
    const info = make('span', '', 'server-report-meta');
    info.append(make('strong', report.title), make('small', shortDate.format(report.at) + ' · ' + delivery[report.delivery]));
    if (Number.isFinite(report.services)) {
      const counts = make('span', '', 'server-report-counts');
      counts.append(make('span', '서비스 ' + report.services), make('span', report.down ? '다운 ' + report.down + '건' : '정상 운영', report.down ? 'bad' : 'good'),
        make('span', '지연 ' + (report.degraded ?? 0) + '건'));
      info.append(counts);
    }
    header.append(dateTile, info, icon('chevron', '#9aa1ae'));
    const content = make('div');
    if (Array.isArray(report.sections) && report.sections.length) {
      const services = make('div', '', 'server-report-services');
      for (const section of report.sections) {
        const service = make('section', '', 'server-report-service');
        service.dataset.tone = section.tone;
        service.append(make('h4', section.name), make('p', section.text));
        services.append(service);
      }
      if (report.summary) content.append(make('p', report.summary, 'server-report-summary'));
      content.append(services);
    } else content.append(make('p', report.text, 'server-monitor-report-text'));
    body.append(content);
    card.append(header, body);
    return card;
  }));
  if (!history.length) list.append(make('p', '아직 생성된 보고서가 없습니다.', 'work-meta'));
}

const usagePercent = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 });

function drawAiUsage() {
  const { rateLimit, tokens } = state?.aiUsage ?? {};
  for (const row of $('ai-usage').querySelectorAll('[data-period]')) {
    const quota = rateLimit?.limits.find(item => item.window === row.dataset.period);
    const ratio = quota ? quota.remaining / quota.limit : 0;
    const percent = usagePercent.format(ratio);
    const meter = row.querySelector('meter');
    row.querySelector('span').textContent = quota ? percent + ' 남음' : '—';
    row.title = quota ? quota.remaining.toLocaleString('ko-KR') + ' / ' + quota.limit.toLocaleString('ko-KR') + '회 남음'
      : 'API 응답을 받으면 표시됩니다.';
    meter.value = ratio;
    meter.setAttribute('aria-hidden', String(!quota));
    meter.setAttribute('aria-valuetext', row.title);
    if (row.dataset.period === 'day') {
      const toggle = $('ai-usage-toggle');
      toggle.style.setProperty('--usage-remaining', percent);
      toggle.title = quota ? 'EXAONE 사용량 · 일일 한도 ' + percent + ' 남음' : 'EXAONE 사용량';
    }
  }
  $('ai-tokens').textContent = tokens === undefined ? '—' : tokens.toLocaleString('ko-KR') + '개';
  drawAiRequestStatus();
}

const aiPhaseLabels = {
  preparing: '이전 대화와 요청을 준비하는 중…',
  queued: '전송 대기 중 · 요청이 가능해지면 자동으로 보냅니다.',
  waiting: 'EXAONE에 요청을 보내고 응답을 기다리는 중…',
  connected: 'EXAONE에 연결됨 · 추론 또는 답변을 기다리는 중…',
  reasoning: 'EXAONE이 요청을 분석하고 답변을 구상하는 중…',
  writing: 'EXAONE 답변을 받아 표시하는 중…',
  saving: '이 PC에 대화를 저장하는 중…',
  stopping: '응답을 중지하는 중…'
};

function drawAiRequestStatus() {
  clearTimeout(aiStatusTimer);
  const pending = !!aiRequest;
  const visibleRequest = aiRequest && aiRequest.chat === activeAiChat ? aiRequest : undefined;
  const wait = (state?.aiUsage?.rateLimit?.retryAt ?? 0) - Date.now();
  const attachments = activeAiChat?.draftFiles?.length ?? 0;
  $('ai-send').disabled = pending || choosingAiAttachments || !!aiHistoryLoad || !activeAiChat ||
    (!attachments && !elements('ai-form').message.value.trim());
  $('ai-attach').disabled = pending || choosingAiAttachments || !!aiHistoryLoad || !activeAiChat || attachments >= 3;
  $('ai-send').title = wait > 0 ? '전송 대기에 추가' : '보내기';
  $('ai-send').setAttribute('aria-label', $('ai-send').title);
  $('ai-stop').title = aiRequest?.phase === 'queued' ? '전송 대기 취소' : '응답 중지';
  $('ai-stop').setAttribute('aria-label', $('ai-stop').title);
  $('ai-send').hidden = pending;
  $('ai-stop').hidden = !pending;
  $('ai-stop').disabled = aiRequest?.phase === 'stopping' || aiRequest?.phase === 'saving';
  $('ai-effort').disabled = pending;
  const seconds = Math.ceil(wait / 1000);
  const duration = seconds >= 60 ? Math.ceil(seconds / 60) + '분' : seconds + '초';
  let message = wait > 0 ? '요청 한도 대기 중 · 메시지 한 건을 예약할 수 있어요.' : '';
  if (visibleRequest) {
    message = visibleRequest.phase === 'queued' && wait > 0
      ? '전송 대기 중 · 약 ' + duration + ' 후 자동으로 보냅니다.' : aiPhaseLabels[visibleRequest.phase];
  } else if (pending) {
    message = aiRequest.phase === 'queued' ? '다른 대화의 메시지가 전송 대기 중…' : '다른 대화에서 답변을 받는 중…';
  }
  const feed = $('ai-messages');
  const follow = aiFeedAtBottom(feed);
  const progress = $('ai-progress');
  const status = $('ai-status');
  const elapsed = $('ai-elapsed');
  progress.hidden = !message;
  if (status.textContent !== message) status.textContent = message;
  elapsed.hidden = !visibleRequest;
  if (visibleRequest) {
    const total = Math.floor((performance.now() - visibleRequest.startedAt) / 1000);
    const minutes = Math.floor(total / 60);
    elapsed.textContent = (minutes ? minutes + '분 ' : '') + total % 60 + '초 경과';
  }
  if (follow) feed.scrollTop = feed.scrollHeight;
  if (visibleRequest || wait > 0) aiStatusTimer = setTimeout(drawAiRequestStatus, wait > 0 ? Math.min(wait, 1000) : 1000);
}

let aiManageTarget;

function showAiManage(chat, action) {
  aiManageTarget = { chat, action };
  const deleting = action === 'delete';
  $('ai-manage-title').textContent = deleting ? '대화 삭제' : '대화 이름 바꾸기';
  $('ai-manage-name').hidden = deleting;
  const input = elements('ai-manage-form').title;
  input.required = !deleting;
  input.value = chat.title;
  notice('ai-manage-confirm', deleting ? '“' + chat.title + '” 대화를 삭제할까요?' : '');
  notice('ai-manage-error');
  const submit = $('ai-manage-submit');
  submit.textContent = deleting ? '삭제' : '저장';
  submit.className = deleting ? 'danger' : 'primary';
  $('ai-manage-dialog').showModal();
  if (!deleting) input.select();
}

function drawAiChatList() {
  const list = $('ai-chat-list');
  const query = $('ai-search').value.trim().toLocaleLowerCase('ko');
  const matches = aiChats.filter(chat => !query || chat.title.toLocaleLowerCase('ko').includes(query));
  list.replaceChildren(...matches.map(chat => {
    const item = button(chat.title, () => {
      activeAiChat = chat;
      if (aiSidebarMedia.matches) setAiSidebar(false);
      notice('ai-error');
      drawAiChat(true);
      scheduleAiTitle();
    });
    item.title = chat.title;
    item.setAttribute('aria-pressed', String(chat === activeAiChat));
    if (!chat.messages.some(message => message.role === 'assistant')) return item;
    const row = make('div', '', 'ai-chat-row');
    const more = make('div', '', 'ai-chat-more');
    const summary = button('');
    summary.title = '대화 관리';
    summary.setAttribute('aria-label', chat.title + ' 관리');
    summary.append(icon('more'));
    const actions = make('div', '', 'ai-chat-menu');
    actions.id = 'ai-chat-menu-' + chat.id;
    actions.setAttribute('popover', 'auto');
    actions.setAttribute('aria-label', chat.title + ' 관리');
    summary.setAttribute('popovertarget', actions.id);
    summary.setAttribute('aria-expanded', 'false');
    actions.addEventListener('toggle', event => {
      summary.setAttribute('aria-expanded', String(event.newState === 'open'));
    });
    summary.addEventListener('click', event => {
      event.preventDefault();
      if (actions.matches(':popover-open')) return actions.hidePopover();
      actions.showPopover();
      const anchor = summary.getBoundingClientRect();
      const bounds = actions.getBoundingClientRect();
      actions.style.left = Math.max(8, Math.min(innerWidth - bounds.width - 8, anchor.right - bounds.width)) + 'px';
      const below = anchor.bottom + 6;
      actions.style.top = Math.max(8, below + bounds.height > innerHeight - 8
        ? anchor.top - bounds.height - 6 : below) + 'px';
    });
    for (const [action, label] of [['rename', '이름 바꾸기'], ['delete', '삭제']]) {
      actions.append(button(label, () => {
        actions.hidePopover();
        showAiManage(chat, action);
      }, action === 'delete' ? 'danger' : ''));
    }
    more.append(summary, actions);
    row.append(item, more);
    return row;
  }));
  if (query && !matches.length) list.append(make('p', '검색 결과가 없습니다.', 'work-meta ai-search-empty'));
  $('ai-title').textContent = activeAiChat?.messages.length ? activeAiChat.title : 'AI 채팅';
}

function aiFeedAtBottom(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 4;
}

function aiFileCard(file, onRemove) {
  const item = make('span', '', 'ai-attachment-chip');
  const extension = file.name.includes('.') ? file.name.split('.').at(-1).slice(0, 7).toUpperCase() : '파일';
  const meta = make('span', '', 'ai-file-meta');
  meta.append(make('strong', file.name));
  if (file.truncated) meta.append(make('small', '일부 첨부됨'));
  item.title = file.name;
  item.append(make('span', extension, 'ai-file-extension'), meta);
  if (onRemove) {
    const remove = button('×', onRemove);
    remove.setAttribute('aria-label', file.name + ' 첨부 제거');
    item.append(remove);
  }
  return item;
}

function drawAiAttachments() {
  const container = $('ai-attachments');
  const files = activeAiChat?.draftFiles ?? [];
  container.replaceChildren(...files.map(file => aiFileCard(file, () => {
    activeAiChat.draftFiles = activeAiChat.draftFiles.filter(other => other !== file);
    drawAiAttachments();
    drawAiRequestStatus();
    $('ai-attach').focus();
  })));
  container.hidden = !files.length;
}

function aiMessage(role, content, attachments, streaming = false) {
  const message = make('article', '', 'ai-message ' + role);
  const text = make('p', content, streaming ? 'ai-streaming' : '');
  if (role === 'user') {
    if (attachments?.length) {
      const files = make('div', '', 'ai-message-files');
      files.append(...attachments.map(file => aiFileCard(file)));
      message.append(files);
    }
    if (content) message.append(text);
    return message;
  }
  const avatar = make('span', '', 'ai-avatar');
  avatar.append(icon('sparkles'));
  const body = make('div', '', 'ai-answer');
  body.append(text);
  if (streaming) {
    const loading = make('span', '', 'ai-writing-dots');
    loading.setAttribute('aria-hidden', 'true');
    loading.append(make('i'), make('i'), make('i'));
    body.append(loading);
  } else {
    const copy = button('', async () => {
      try {
        await navigator.clipboard.writeText(content);
        toast('답변을 복사했습니다.');
      } catch {
        toast('답변을 복사할 수 없습니다.');
      }
    }, 'ai-copy');
    copy.title = '답변 복사';
    copy.setAttribute('aria-label', copy.title);
    copy.append(icon('copy'));
    body.append(copy);
  }
  message.append(avatar, body);
  return message;
}

function drawAiChat(resetScroll = false) {
  drawAiChatList();
  drawAiAttachments();
  const feed = $('ai-messages');
  const previousScroll = feed.scrollTop;
  const follow = resetScroll || aiFeedAtBottom(feed);
  const messages = activeAiChat?.messages ?? [];
  const pending = aiRequest && aiRequest.chat === activeAiChat;
  const empty = !messages.length && !pending;
  $('ai-welcome').hidden = !empty;
  $('ai-suggestions').hidden = !empty;
  $('ai-home').classList.toggle('ai-empty', empty);
  feed.replaceChildren(...messages.map(({ role, content, attachments }) => aiMessage(role, content, attachments)));
  if (pending) feed.append(aiMessage('assistant', aiRequest.answer, undefined, true));
  feed.scrollTop = follow ? feed.scrollHeight : previousScroll;
  drawAiRequestStatus();
}

function scheduleAiTitle() {
  clearTimeout(aiTitleTimer);
  const chat = activeAiChat;
  if (aiRequest || !chat || chat.summarized || !chat.messages.some(message => message.role === 'assistant')) return;
  aiTitleTimer = setTimeout(async () => {
    if (aiRequest || activeAiChat !== chat || $('ai-home').hidden) return;
    const title = await api.aiTitle(chat.id).catch(() => null);
    if (!title || !aiChats.includes(chat)) return;
    chat.title = title;
    chat.summarized = true;
    drawAiChatList();
  }, 1200);
}

function newAiChat() {
  if (aiHistoryLoad) return;
  activeAiChat = aiChats.find(chat => !chat.messages.length);
  if (!activeAiChat) {
    activeAiChat = { id: crypto.randomUUID(), title: '새 대화', messages: [] };
    aiChats.unshift(activeAiChat);
  }
  notice('ai-error');
  $('ai-search').value = '';
  if (aiSidebarMedia.matches) setAiSidebar(false);
  drawAiChat(true);
  scheduleAiTitle();
  elements('ai-form').message.focus();
}

async function restoreAiChats() {
  const load = aiHistoryLoad = Symbol();
  $('ai-new-chat').disabled = true;
  drawAiRequestStatus();
  try {
    const chats = await api.aiHistory();
    if (aiHistoryLoad !== load) return;
    aiChats = chats;
    activeAiChat = chats[0];
    aiHistoryLoad = undefined;
    if (activeAiChat) drawAiChat(true);
    else newAiChat();
    scheduleAiTitle();
    $('ai-title').focus();
  } catch (error) {
    if (aiHistoryLoad === load) notice('ai-error', error.message);
  } finally {
    if (aiHistoryLoad === load) aiHistoryLoad = undefined;
    if (!aiHistoryLoad) $('ai-new-chat').disabled = false;
  }
}

function savedLoginHint() {
  const form = elements('login-form');
  const available = form.remember.checked && state?.nasProfiles?.some(profile =>
    profile.saved && profile.url === form.url.value && profile.user === form.user.value &&
    (profile.pin || '') === form.pin.value.trim());
  form.password.required = !available;
  const usingSaved = !!available && !form.password.value;
  form.password.placeholder = usingSaved ? '••••••••••••' :
    api.browserPreview === true ? '미리보기에서는 입력하지 않아도 됩니다' : '';
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
const updateNowBar = $('update-now-bar');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let dismissedUpdate;
let restartingUpdate = false;

function nowNotice(element, detail, toggle) {
  let timers = [];
  let shown = false;
  let expanded = false;
  const clear = () => { timers.forEach(clearTimeout); timers = []; };
  const fit = () => {
    element.style.height = expanded ? 60 + detail.getBoundingClientRect().height + 'px' : '60px';
  };
  const setExpanded = value => {
    expanded = value;
    element.toggleAttribute('data-details-open', value);
    toggle.setAttribute('aria-expanded', String(value));
    detail.inert = !value;
    fit();
  };
  toggle.addEventListener('click', () => setExpanded(!expanded));
  const observer = new ResizeObserver(fit);
  observer.observe(detail);
  return {
    show() {
      if (shown) return;
      shown = true;
      clear();
      element.hidden = false;
      element.style.height = '60px';
      if (reducedMotion.matches) {
        element.dataset.visible = element.dataset.expanded = '';
      } else {
        timers.push(setTimeout(() => { element.dataset.visible = ''; }, 20),
          setTimeout(() => { element.dataset.expanded = ''; }, 550));
      }
    },
    hide() {
      if (!shown) return;
      shown = false;
      clear();
      setExpanded(false);
      delete element.dataset.expanded;
      if (reducedMotion.matches) {
        delete element.dataset.visible;
        element.hidden = true;
      } else {
        timers.push(setTimeout(() => { delete element.dataset.visible; }, 520),
          setTimeout(() => { element.hidden = true; }, 1000));
      }
    },
    collapse: () => setExpanded(false),
    fit,
    motionChanged() {
      clear();
      if (shown) element.dataset.visible = element.dataset.expanded = '';
      else {
        delete element.dataset.visible;
        delete element.dataset.expanded;
        element.hidden = true;
      }
      fit();
    }
  };
}

const updateNotice = nowNotice(updateNowBar, $('update-notice-detail'), $('update-notice-toggle'));
new ResizeObserver(entries => {
  const height = entries[0].borderBoxSize?.[0]?.blockSize ?? updateNowBar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--update-notice-height', height + 'px');
}).observe(updateNowBar);

function setNoticeLabel(element, value) {
  if (element.textContent === value) return;
  element.textContent = value;
  element.removeAttribute('data-change');
  void element.offsetWidth;
  element.dataset.change = '';
}

function setNoticeIcon(element, name) {
  if (element.dataset.glyph === name) return;
  element.dataset.glyph = name;
  element.replaceChildren(icon(name, 'currentColor'));
}

function hideLeavingUpdateBar() {
  if (updateBar.hasAttribute('data-leaving')) updateBar.hidden = true;
}
updateBar.addEventListener('animationend', event => {
  if (event.target === updateBar && event.animationName === 'update-out') hideLeavingUpdateBar();
});
reducedMotion.addEventListener('change', event => {
  if (event.matches) {
    pageTransition?.skipTransition();
    hideLeavingUpdateBar();
    updateNotice.motionChanged();
    fileNotice.motionChanged();
    if (state) drawUpdate();
  }
});

function drawUpdateBar(message, error) {
  if (!message) {
    if (reducedMotion.matches) updateBar.hidden = true;
    else if (!updateBar.hidden) updateBar.dataset.leaving = '';
    return;
  }
  const status = $('update-message');
  if (status.textContent !== message) status.textContent = message;
  updateBar.classList.toggle('bad', error);
  updateBar.removeAttribute('data-leaving');
  updateBar.hidden = false;
}

function drawUpdateNowBar(phase, tag, percent) {
  if (!phase) return updateNotice.hide();
  updateNotice.show();
  const downloading = phase === 'downloading';
  const applying = restartingUpdate || state.restartingUpdate;
  const value = downloading ? Math.min(100, Math.max(0, percent ?? 0)) : 100;
  const title = tag + (downloading ? ' 다운로드 중' : applying ? ' 업데이트 적용 중…' : ' 업데이트 준비 완료');
  setNoticeLabel($('update-notice-text'), title);
  setNoticeIcon($('update-mark'), downloading ? 'downloads' : 'check');
  updateNowBar.dataset.result = downloading ? '' : 'success';
  updateNowBar.style.setProperty('--notice-progress', value);
  $('update-percent').textContent = downloading ? value + '%' : '';
  $('update-download-message').textContent = tag;
  $('update-detail-percent').textContent = value + '%';
  $('update-progress').setAttribute('aria-valuenow', value);
  $('update-progress').style.setProperty('--progress', value + '%');
  $('update-ready-message').textContent = downloading ? '설치 파일을 내려받고 검증합니다.' :
    applying ? '업데이트를 적용하고 있습니다.' : '다운로드와 검증을 마쳤습니다. 다시 시작하면 새 버전이 적용됩니다.';
  $('update-restart').hidden = downloading;
  $('update-restart').disabled = applying || state.applyingUpdate || state.connecting;
  updateNotice.fit();
}

let updateButtonError = '';

function drawUpdate() {
  const update = state.update;
  const downloading = update?.phase === 'downloading';
  const ready = update?.phase === 'ready';
  const updating = updateRequested || state.applyingUpdate;
  const applying = ready && (restartingUpdate || state.restartingUpdate);
  const tag = update?.tag || update?.version;
  const label = applying ? '업데이트 적용 중…' : downloading ? tag + ' 다운로드 중…' : ready ? '다시 시작할까요?' :
    tag ? tag + ' 다운로드' : '업데이트 다운로드';
  for (const id of ['update-now', 'signin-update-check', 'account-update-check']) {
    const button = $(id);
    const home = id === 'update-now';
    if (home) button.hidden = !tag;
    button.disabled = updating || downloading || update?.phase === 'checking' || state.connecting;
    if (id === 'account-update-check') continue;
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
    rateLimit: update?.retryAt > Date.now()
      ? 'GitHub 요청 한도에 도달했습니다. ' + new Date(update.retryAt).toLocaleTimeString('ko-KR') + ' 이후 다시 확인하세요.'
      : 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 확인하세요.'
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
  const account = $('account-update-check');
  const accountLabel = {
    checking: '확인 중…',
    current: '최신 버전 사용 중',
    downloading: `다운로드 중 · ${percent}%`,
    ready: applying ? '업데이트 적용 중…' : '다시 시작하기',
    missing: '설치 파일 없음',
    error: '업데이트 확인 실패',
    unsupported: '자동 업데이트 미지원'
  }[update?.phase];
  const buttonText = updateButtonError ? '업데이트 실패 · 다시 시도' : accountLabel || (tag ? label : '업데이트 확인');
  if (account.textContent !== buttonText) account.textContent = buttonText;
  account.title = updateButtonError || message || buttonText;
  account.setAttribute('aria-label', buttonText);
  account.classList.toggle('danger', !!updateButtonError || error);
  const signinNotice = !$('signin').hidden && !state.connecting && update?.phase !== 'checking' &&
    (!current || signinCurrentTimer) && !ready;
  const showReady = ready && dismissedUpdate !== tag;
  drawUpdateNowBar(downloading ? 'downloading' : showReady ? 'ready' : undefined, tag, percent);
  drawUpdateBar(signinNotice && !downloading ? message : '', error);
  drawSigninLoading();
  drawLoginButton();
  drawConnectionForm();
}

function apply(next, animate = true) {
  if (pageChangePending) {
    pendingPageState = next;
    return;
  }
  if (state?.connected && !next.connected) {
    settingsOpen = false;
    settingsTrigger = undefined;
    servicePage = undefined;
  }
  if (animate && state && $('usage-setup').hidden &&
      (state.connected !== next.connected || !!state.serverUpdaterAccount !== !!next.serverUpdaterAccount)) {
    if (!pageTransition) {
      navigate(() => {
        const latest = pendingPageState ?? next;
        pendingPageState = undefined;
        apply(latest, false);
      });
      return;
    }
    pageTransition.skipTransition();
  }
  const previous = state;
  state = next;
  if (!previous && state.usageMode === 'both' && state.serverUpdaterAccount) {
    servicePage = 'server';
  }
  $('signin-version').textContent = state.versionLabel || '';
  if (state.connected) {
    clearTimeout(signinCurrentTimer);
    signinCurrentTimer = undefined;
  }
  if (previous?.connected && !state.connected) {
    for (const kind of Object.keys(players)) {
      stopMedia(kind);
      players[kind].folder = players[kind].loading = undefined;
      players[kind].entries = [];
      $(kind + '-list').replaceChildren();
      drawMediaList(kind);
    }
    players.video.subtitles = [];
    musicOpen = videoOpen = false;
    mediaPicker = undefined;
    clearTimeout(aiTitleTimer);
    if (servicePage === 'ai' && !state.serverUpdaterAccount) servicePage = undefined;
    notice('login-error');
  }
  if (previous && (previous.connected !== state.connected || previous.aiEmail !== state.aiEmail)) {
    clearTimeout(aiTitleTimer);
    aiChats = [];
    activeAiChat = aiRequest = aiHistoryLoad = undefined;
    $('ai-new-chat').disabled = false;
    $('ai-form').reset();
    drawAiChat();
  }
  if (!state.connected && browserMode) resetBrowser();
  if (!previous || previous.connected !== state.connected) {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  }
  if ((!previous && !state.serverUpdaterAccount) || (previous?.connected && !state.connected)) {
    const profile = state.nasProfiles?.find(item => item.url === state.profile?.url && item.user === state.profile?.user);
    selectNas(profile);
  }
  for (const id of ['home-sync', 'sync-indicator', 'sync-now', 'edit-button']) {
    $(id).hidden = !state.connected;
  }
  showPage();
  if (!state.serverUpdaterAccount && state.serverAuthError && state.serverAuthError !== previous?.serverAuthError) {
    notice('server-login-error', state.serverAuthError);
  }
  if (servicePage === 'ai' && previous &&
      (previous.aiEmail !== state.aiEmail || previous.connected !== state.connected) && !$('ai-home').hidden) {
    void restoreAiChats();
  }
  if (servicePage === 'ai' && state.serverAuthError && state.serverAuthError !== previous?.serverAuthError) {
    notice('ai-login-error', state.serverAuthError);
  }
  drawServerHome(previous?.serverUpdaterAccount);
  drawAiUsage();
  if (previous?.terminalOpen && !state.terminalOpen) {
    if (!$('server-home').hidden) $('server-terminal').focus();
    else if (!$('home').hidden) document.querySelector('.tile:has(.terminal)')?.focus();
  }
  workspaceChanged(previous);
  drawUpdate();
  if (!state.connected) {
    if (state.loginError) {
      notice('login-error', state.loginError);
      if (/\(DSM 40[34]\)/u.test(state.loginError)) showOtp(true);
    }
    savedLoginHint();
    return;
  }
  if (browserMode) { browseButtons(); updateSelection(); drawFavorites(); }
  const { settings, sync } = state;
  const results = syncAreas.map(area => area.id === 'base' ? sync || settings.last : area.last);
  const running = state.syncingAll || sync?.running || syncAreas.some(area => area.id !== 'base' && area.running);
  const failed = results.find(result => result?.errors);
  const pending = results.some(result => result?.pending);
  const completed = results.length > 0 && results.every(result => result?.checkedAt);
  $('sync-now').disabled = !!(running || sync?.checking);
  const status = !results.length ? '폴더 지정 필요' : running ? '동기화 중' : sync?.checking ? '확인 중' :
    failed ? '동기화 오류' : pending ? '업데이트 있음' : completed ? '완료' : '동기화 대기';
  $('sync-status').textContent = status;
  const lastChecked = Math.max(0, ...results.map(result => result?.checkedAt || 0));
  $('sync-status').title = failed?.message || (lastChecked ? shortDate.format(lastChecked) : '');
  $('sync-dot').className = 'dot' + (running || sync?.checking ? ' active' :
    failed || pending ? ' warn' : completed ? ' good' : '');
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
  if (pageTransition) return;
  try {
    if (id === 'dsm') return openBrowser('remote');
    if (Object.hasOwn(players, id)) return openMediaPlayer(id);
    if (id === 'server-update') {
      const changed = servicePage !== 'server';
      servicePage = 'server';
      notice('server-login-error');
      showPage();
      if (state.serverUpdaterAccount) {
        $('server-home-title').focus();
      } else {
        if (changed) animateSigninPanel();
        if (state.serverRemembered) {
          void api.serverUpdaterRestore().then(apply).catch(error => notice('server-login-error', error.message));
        }
        elements('server-login-form').email.focus();
      }
      return;
    }
    if (id === 'ai-assistant' && (state.connected || state.serverUpdaterAccount)) return navigate(() => {
      aiBackPage = servicePage;
      servicePage = 'ai';
      notice('ai-login-error');
      showPage();
      if (state.aiEmail) {
        if (!activeAiChat && !aiHistoryLoad) void restoreAiChats();
        else scheduleAiTitle();
        $('ai-title').focus();
      } else {
        $('ai-login-title').focus();
        if (state.serverRemembered) {
          void api.serverUpdaterRestore(true).then(apply).catch(error => notice('ai-login-error', error.message));
        }
      }
    });
    if (id === 'downloads') return openBrowser('local');
    if (id === 'sync') return openSettings('sync');
    if (id === 'terminal') return await api.terminal();
    if (id === 'github') return openGithub();
  } catch (error) {
    toast(error.message);
  }
}

function drawTiles() {
  const container = $('groups');
  container.replaceChildren();
  let index = 0;
  for (const group of groups) {
    const panel = make('section', '', 'panel');
    const heading = make('h2', group.title);
    heading.id = 'group-' + group.id;
    panel.setAttribute('aria-labelledby', heading.id);
    const grid = make('div', '', 'tiles');
    for (const [id, label, glyph] of group.tiles) {
      const item = tile(label, id, () => activate(id), glyph);
      item.style.setProperty('--tile-delay', 100 + index++ * 55 + 'ms');
      grid.append(item);
    }
    panel.append(heading, grid);
    container.append(panel);
  }
}

function drawSettings() {
  const { profile, settings, connected, github } = state;
  $('account-device').textContent = state.device || '—';
  $('account-server').textContent = connected ? profile.url : '연결 안 됨';
  $('account-user').textContent = connected ? profile.user : '';
  $('account-github').textContent = github ? '@' + github.login : '연결 안 됨';
  $('account-launcher-label').textContent = state.usageMode === 'nas' ? 'AI 채팅' : '서버 업데이터';
  $('account-server-updater').textContent = state.aiEmail || '로그인 안 됨';
  $('settings-version').textContent = state.versionLabel || '';
  $('settings-tray').checked = !!state.trayVisible;
  $('settings-launch').checked = !!state.launchAtLogin;
  $('settings-skip-file-confirmations').checked = !!state.skipFileConfirmations;
  $('settings-skip-extract-confirmation').checked = !!state.skipExtractConfirmation;
  $('settings-extract-destination').value = state.extractInPlace ? 'here' : 'folder';
  $('account-writes').checked = !!settings?.remoteWrites;
  $('settings-auto-sync').checked = !!settings?.automatic;
  for (const id of ['settings-media-nav', 'settings-sync-nav', 'nas-account-row', 'github-account-row', 'nas-write-setting',
    'account-github-open', 'account-switch', 'logout-button']) $(id).hidden = !connected;
  $('settings-server-logout').hidden = !state.aiEmail;
  $('settings-server-logout').textContent = state.usageMode === 'nas' ? 'AI 로그아웃' : '서버 업데이터 로그아웃';
  $('usage-edit').hidden = connected;
  $('uninstall-mac').hidden = api.platform !== 'darwin' || !state.packaged;
  for (const kind of Object.keys(players)) {
    $('settings-' + kind + '-folder').textContent = settings?.mediaFolders?.[kind] || '지정되지 않음';
  }
  if (!connected && ['sync', 'media'].includes(settingsSection)) settingsSection = 'account';
  for (const control of settingsSections) {
    const selected = control.dataset.settingsSection === settingsSection;
    if (selected) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
    $(control.getAttribute('aria-controls')).hidden = !selected;
  }
}

function openSettings(section = 'account') {
  navigate(() => {
    settingsTrigger = document.activeElement;
    settingsOpen = true;
    settingsSection = section;
    const { settings } = state;
    if (settings) {
      const form = elements('settings-form');
      form.remote.value = settings.remote;
      form.local.value = settings.local;
      form.interval.value = String(settings.interval);
    }
    notice('account-error');
    notice('settings-error');
    showPage();
    $('settings-content').scrollTop = 0;
    $('settings-' + settingsSection + '-title').focus({ preventScroll: true });
  });
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
  crumbs.append(button(rootName, () => navigateFolder('/')));
  let folder = '';
  for (const name of browserPath.split('/').slice(1).filter(Boolean)) {
    folder += '/' + name;
    const target = folder;
    crumbs.append(make('span', '/'), button(name, () => navigateFolder(target)));
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
  action.removeAttribute('title');
  action.setAttribute('aria-label', label);
  if (action.dataset.glyph === glyph && action.firstChild) {
    action.lastElementChild.textContent = label;
    return;
  }
  action.dataset.glyph = glyph;
  action.replaceChildren(icon(glyph, 'currentColor'), make('span', label));
  action.classList.remove('selection-icon-switch');
  void action.offsetWidth;
  action.classList.add('selection-icon-switch');
}

function updateSelection() {
  const files = selectedFiles();
  const single = files.length === 1;
  $('selection-bar').hidden = browserMode === 'picker' || !browserMode;
  const count = $('selection-number');
  const countText = files.length.toLocaleString('ko-KR');
  if (count.textContent !== countText) {
    count.textContent = countText;
    count.classList.remove('selection-bump');
    void count.offsetWidth;
    count.classList.add('selection-bump');
  }
  $('selection-count').classList.toggle('on', !!files.length);
  $('open-selection').disabled = !single || transferring || loadingFolder;
  const folder = single && files[0].directory;
  const foldersOnly = files.length > 0 && files.every(file => file.directory);
  const favorite = $('favorite-selection');
  favorite.hidden = browserMode !== 'remote';
  favorite.disabled = !foldersOnly || transferring || loadingFolder;
  const starred = foldersOnly && files.every(file => (state.settings.folderFavorites ?? []).includes(file.path));
  favorite.setAttribute('aria-pressed', String(starred));
  setSelectionIcon(favorite, starred ? '즐겨찾기 제거' : '즐겨찾기 추가', 'fsStar');
  setSelectionIcon($('open-selection'), folder ? '폴더 열기' : '미리보기', folder ? 'fsOpen' : 'fsEye');
  $('download-selection').hidden = browserMode !== 'remote';
  $('delete-selection').hidden = browserMode === 'remote' && (!state.settings.remoteWrites ||
    browserPath === '/' && state.profile.provider === 'synology');
  const remote = browserMode === 'remote';
  const writableSelection = remote && state.settings.remoteWrites && browserPath !== '/';
  $('rename-selection').hidden = !writableSelection;
  $('rename-selection').disabled = !single || transferring || loadingFolder;
  $('extract-selection').hidden = !writableSelection;
  $('extract-selection').disabled = !single || folder || !/\.zip$/iu.test(files[0]?.name ?? '') || transferring || loadingFolder;
  $('mkdir-button').hidden = !remote;
  $('mkdir-button').disabled = !state.settings.remoteWrites || browserPath === '/' || transferring || loadingFolder;
  for (const id of ['download-selection', 'delete-selection']) $(id).disabled = !files.length || transferring || loadingFolder;
  $('clear-selection').disabled = !browserEntries.length || transferring || loadingFolder;
  setSelectionIcon($('clear-selection'), files.length && files.length === browserEntries.length ? '선택 해제' : '전체 선택', files.length && files.length === browserEntries.length ? 'fsNone' : 'fsAll');
  for (const action of $('selection-bar').querySelectorAll('button')) action.setAttribute('aria-disabled', String(action.disabled));
  hideFileToolbarTip();
  for (const item of $('browser-results').querySelectorAll('[data-file-path]')) {
    const active = selected.has(item.dataset.filePath);
    item.setAttribute('aria-pressed', String(active));
    const card = item.closest('.file-card, tr');
    card.classList.toggle('selected', active);
    const cut = nasClipboard?.cut && browserMode === 'remote' &&
      nasClipboard.profile === state.profile.url + '\n' + state.profile.user && nasClipboard.paths.includes(item.dataset.filePath);
    card.classList.toggle('is-cut', !!cut);
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
    if (file.directory) navigateFolder(file.path);
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

let fileMenuCloseTimer;
function closeFileMenu(restoreFocus = false, immediate = false) {
  const menu = $('file-actions-menu');
  clearTimeout(fileMenuCloseTimer);
  const trigger = menuTrigger;
  menuTrigger = null;
  if (!menu.hidden && !immediate && !reducedMotion.matches) {
    menu.dataset.closing = '';
    menu.inert = true;
    fileMenuCloseTimer = setTimeout(() => { menu.hidden = true; menu.replaceChildren(); }, 150);
  } else {
    menu.hidden = true;
    menu.replaceChildren();
  }
  if (restoreFocus) (trigger?.isConnected ? trigger : $('browser-results')).focus({ preventScroll: true });
}

function openFileMenu(trigger, x, y) {
  if (!browserMode || browserMode === 'picker' || transferring || loadingFolder) return;
  closeFileMenu(false, true);
  hideFileToolbarTip();
  const file = trigger && browserEntries.find(entry => entry.path === trigger.dataset.filePath);
  if (file && !selected.has(file.path)) chooseFile(file, {});
  const menu = $('file-actions-menu');
  menu.inert = false;
  delete menu.dataset.closing;
  const heading = make('div', $('selection-count').textContent, 'file-menu-heading');
  heading.setAttribute('role', 'presentation');
  menu.append(heading);
  let index = 0;
  const groups = [...$('selection-bar').querySelectorAll('.selection-group'), $('clear-selection')];
  for (const group of groups) {
    const actions = (group.matches('button') ? [group] : [...group.querySelectorAll('button')]).filter(action => !action.hidden);
    if (!actions.length) continue;
    if (index) {
      const separator = make('div', '', 'file-menu-separator');
      separator.setAttribute('role', 'separator');
      menu.append(separator);
    }
    for (const action of actions) {
      const item = button('', () => {
        if (action.disabled) return;
        closeFileMenu(true);
        action.click();
      }, action.classList.contains('danger') ? 'danger' : '');
      item.setAttribute('role', 'menuitem');
      item.disabled = action.disabled;
      item.setAttribute('aria-disabled', String(item.disabled));
      item.tabIndex = -1;
      item.style.setProperty('--item-index', index++);
      if (action.hasAttribute('aria-pressed')) item.setAttribute('aria-pressed', action.getAttribute('aria-pressed'));
      item.append(icon(action.dataset.glyph, 'currentColor'), make('span', action.getAttribute('aria-label')));
      menu.append(item);
    }
  }
  menuTrigger = trigger;
  menu.hidden = false;
  const bounds = { width: menu.offsetWidth, height: menu.offsetHeight };
  const flipX = x + bounds.width > innerWidth - 8;
  const flipY = y + bounds.height > innerHeight - 8;
  menu.style.left = Math.max(8, Math.min(innerWidth - bounds.width - 8, flipX ? x - bounds.width : x)) + 'px';
  menu.style.top = Math.max(8, Math.min(innerHeight - bounds.height - 8, flipY ? y - bounds.height : y)) + 'px';
  menu.style.transformOrigin = (flipX ? '100%' : '0%') + ' ' + (flipY ? '100%' : '0%');
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

let fileTooltipTimer;
const fileToolbarHints = {
  'mkdir-button': ['폴더 만들기', '쓰기 가능한 NAS 폴더에서 사용'],
  'open-selection': ['선택한 항목 열기', '파일 또는 폴더 1개 선택'],
  'favorite-selection': ['추가 · 제거', '폴더만 선택'],
  'download-selection': ['PC에 저장', '항목 선택'],
  'rename-selection': ['이름 변경', '항목 1개 선택'],
  'extract-selection': ['ZIP 해제', 'ZIP 파일 1개 선택'],
  'delete-selection': ['선택 항목 삭제', '항목 선택'],
  'clear-selection': ['', '선택할 항목 없음']
};
function hideFileToolbarTip() {
  clearTimeout(fileTooltipTimer);
  const tip = $('file-toolbar-tip');
  delete tip.dataset.visible;
  for (const action of $('selection-bar').querySelectorAll('[aria-describedby]')) action.removeAttribute('aria-describedby');
}
function showFileToolbarTip(action) {
  const tip = $('file-toolbar-tip');
  const [description, condition] = fileToolbarHints[action.id] || [];
  tip.replaceChildren(make('strong', action.getAttribute('aria-label')));
  if (description) tip.append(make('small', description));
  if (action.disabled && condition) tip.append(make('em', transferring ? '파일 작업 완료 후 사용' : loadingFolder ? '폴더를 불러오는 중' : condition));
  tip.hidden = false;
  const bounds = action.getBoundingClientRect();
  const width = tip.offsetWidth;
  tip.style.left = Math.max(width / 2 + 8, Math.min(innerWidth - width / 2 - 8, bounds.left + bounds.width / 2)) + 'px';
  tip.style.top = Math.max(8, Math.min(innerHeight - tip.offsetHeight - 8, bounds.bottom + 10)) + 'px';
  tip.dataset.visible = '';
  action.setAttribute('aria-describedby', tip.id);
}
$('selection-bar').addEventListener('pointerover', event => {
  const action = event.target.closest('button');
  if (!action || action.contains(event.relatedTarget)) return;
  hideFileToolbarTip();
  fileTooltipTimer = setTimeout(() => showFileToolbarTip(action), 250);
});
$('selection-bar').addEventListener('pointerout', event => {
  const action = event.target.closest('button');
  if (action && !action.contains(event.relatedTarget)) hideFileToolbarTip();
});
$('selection-bar').addEventListener('focusin', event => {
  const action = event.target.closest('button');
  if (action) showFileToolbarTip(action);
});
$('selection-bar').addEventListener('focusout', hideFileToolbarTip);
$('selection-bar').addEventListener('click', hideFileToolbarTip);

async function openEntry(file) {
  if (!file || transferring || loadingFolder) return;
  if (file.directory) return navigateFolder(file.path);
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
    label.draggable = browserMode === 'remote' && browserPath !== '/' && !!state.settings.remoteWrites;
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
  if (file.directory) row.dataset.dropFolder = file.path;
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
  if (file.directory) card.dataset.dropFolder = file.path;
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

function navigateFolder(path) {
  if (path !== browserPath && !transferring) navigate(() => { void loadFolder(path); }, 'files');
}

function drawFavorites() {
  const section = $('browser-favorites');
  const list = $('browser-favorite-list');
  const folders = state.settings?.folderFavorites ?? [];
  section.hidden = browserMode === 'picker' || !folders.length;
  if (list.childElementCount !== folders.length ||
      folders.some((path, index) => list.children[index].dataset.path !== path)) {
    list.replaceChildren(...folders.map(path => {
      const item = button('', () => {
        if (browserMode === 'remote') navigateFolder(path);
        else openBrowser('remote', path);
      });
      const row = make('div', '', 'favorite-row');
      row.dataset.path = path;
      item.title = path;
      const name = path.split('/').at(-1);
      item.append(icon('star', '#a9c6f8'), make('span', name));
      const remove = button('×', () => {
        void api.folderFavorite(path, false).catch(error => toast(error.message));
      }, 'favorite-remove');
      remove.title = '즐겨찾기 제거';
      remove.setAttribute('aria-label', name + ' 즐겨찾기 제거');
      row.append(item, remove);
      return row;
    }));
  }
  for (const row of list.children) {
    const item = row.firstElementChild;
    if (browserMode === 'remote' && row.dataset.path === browserPath) item.setAttribute('aria-current', 'location');
    else item.removeAttribute('aria-current');
  }
}

async function loadFolder(path) {
  if (transferring || !browserMode || !state.connected) return;
  const generation = ++browseGeneration;
  const focusPath = $('browser-results').contains(document.activeElement) || $('breadcrumbs').contains(document.activeElement);
  browserPath = path;
  drawFavorites();
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

function openBrowser(mode, path = browserFolders[mode] || (mode === 'remote' && state.settings.remote) || '/', fromDialog) {
  if (transferring) return toast('파일 전송이 끝난 뒤 다시 열어 주세요.');
  navigate(() => enterBrowser(mode, path, fromDialog), browserMode ? 'files' : 'enter');
}

function enterBrowser(mode, path, fromDialog) {
  if (!browserMode) browserTrigger = document.activeElement;
  if (mode === 'picker') {
    pickerDialog = fromDialog;
    if (pickerDialog) $(pickerDialog).close();
  }
  browserMode = mode;
  const remoteTitle = state.profile.provider === 'synology' ? '파일 스테이션' : '클라우드 파일';
  $('browser-title').textContent = { local: '다운로드', picker: mediaPicker ? players[mediaPicker].name + ' 폴더 선택' : '동기화 폴더 선택', remote: remoteTitle }[mode];
  $('browser-label').textContent = mode === 'local' ? '' : new URL(state.profile.url).host;
  $('browser-home-label').textContent = mode === 'picker' ? mediaPicker ? '플레이어로 돌아가기' : '설정으로 돌아가기' : '홈';
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
  closeFileMenu(false, true);
  hideFileToolbarTip();
  browseGeneration++;
  browserMode = null;
  mediaPicker = undefined;
  browserTrigger = null;
  browserFolders = {};
  browserEntries = [];
  selected.clear();
  selectionAnchor = null;
}

function leaveBrowser() {
  const picker = browserMode === 'picker';
  const pickedMedia = mediaPicker;
  const trigger = browserTrigger;
  resetBrowser();
  showPage();
  if (picker && !pickedMedia && pickerDialog) $(pickerDialog).showModal();
  if (trigger?.isConnected) trigger.focus();
}

async function transfer(action, progress, direction) {
  if (transferring || loadingFolder) return;
  transferring = true;
  beginFileNotice();
  browseButtons();
  notice('browser-status');
  if (progress || direction === 'delete') {
    showFileTransfer(direction || 'files', progress || '삭제 중…', '');
    $('transfer-details').textContent = '';

  }
  try {
    const result = await action();
    if (direction && result) finishFileTransfer(direction, result.message, result.failed, result.details);
    else if (direction === 'delete' && !result) hideFileTransfer();
    if (progress && $('browser-status').textContent === progress) notice('browser-status');
    return result;
  } catch (error) {
    if (direction) finishFileTransfer(direction, error.message, true);
    else if (browserMode) notice('browser-status', error.message, true);
    else toast(error.message);
  } finally {
    transferring = false;
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
$('edit-button').append(icon('pencil', '#cbd8ef'));
$('account-button').append(icon('account', '#cbd8ef'));
$('signin-settings').append(icon('account', '#cbd8ef'));
if (api.platform !== 'darwin') $('settings-tray-label').textContent = '시스템 트레이 아이콘 표시';
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
for (const [index, glyph] of ['dsm', 'sync', 'grid'].entries()) {
  $('usage-form').querySelectorAll('.usage-option-icon')[index].append(icon(glyph));
}
$('usage-edit').addEventListener('click', () => {
  elements('usage-choice').mode.value = state.usageMode;
  editingUsage = true;
  const steps = $('usage-form').querySelectorAll('.usage-step');
  usageStep = 1;
  for (const [index, step] of steps.entries()) {
    step.hidden = index !== usageStep;
    step.inert = index !== usageStep;
  }
  notice('usage-error');
  showPage();
});
$('usage-close').addEventListener('click', busy($('usage-close'), async () => {
  await api.setUsageMode(null, true);
  placeUsageAccount(false);
  usageConnection = undefined;
  editingUsage = false;
  showPage();
  $('usage-edit').focus();
}, error => notice('usage-error', error.message)));
$('usage-prev').addEventListener('click', async () => {
  await moveUsageStep(usageStep - 1);
  usageConnection = undefined;
  drawUsage();
});
$('usage-choice').addEventListener('change', drawUsage);
$('usage-choice').addEventListener('submit', event => {
  event.preventDefault();
  $('usage-next').click();
});
$('usage-next').addEventListener('click', async () => {
  if ($('usage-next').disabled) return;
  if (usageStep === 0) return moveUsageStep(1);
  const mode = elements('usage-choice').mode.value;
  usageSaving = true;
  drawUsage();
  notice('usage-error');
  try {
    const preparing = usageStep === 1;
    if (preparing && editingUsage && state.aiEmail) {
      apply(await api.serverUpdaterLogout(false), false);
    }
    const next = await api.setUsageMode(mode, preparing);
    if (preparing) {
      usageConnection = mode === 'nas' ? 'nas' : 'server';
      usageSaving = false;
      await moveUsageStep(2);
    } else {
      editingUsage = false;
      settingsOpen = false;
      servicePage = mode === 'server' ? 'server' : undefined;
      apply(next);
    }
  } catch (error) {
    notice('usage-error', error.message);
  } finally {
    usageSaving = false;
    drawUsage();
  }
});
if (api.browserPreview === true) {
  $('login-form').noValidate = $('server-login-form').noValidate = true;
  const server = elements('server-login-form');
  server.email.placeholder = 'demo@example.test';
  server.password.placeholder = '미리보기에서는 입력하지 않아도 됩니다';
}
$('server-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || state.serverUpdaterAccount || $('server-login-submit').disabled) return;
  const { email, password, remember } = event.currentTarget.elements;
  const configuring = usageStep === 2 && usageConnection === 'server';
  const credentials = { email: email.value, password: password.value, remember: configuring || remember.checked };
  password.value = '';
  serverLoginPending = true;
  notice('server-login-error');
  showPage();
  if (configuring) drawUsage();
  try {
    const next = await api.serverUpdaterLogin(credentials);
    if (configuring) await advanceUsageAccount(next);
    else apply(next);
  } catch (error) {
    notice('server-login-error', error.message);
  } finally {
    serverLoginPending = false;
    showPage();
    drawLoginButton();
    if (configuring) drawUsage();
    if (!state.serverUpdaterAccount && !$('server-login').hidden) password.focus();
  }
});
function drawMusicPanel() {
  const panel = $('music-panel');
  const toggle = $('music-toggle');
  const visible = musicOpen && !$('home').hidden;
  panel.inert = !visible;
  panel.classList.toggle('is-open', visible);
  document.body.classList.toggle('music-player-open', visible);
  toggle.hidden = !state.connected;
  toggle.setAttribute('aria-expanded', String(visible));
  toggle.title = visible ? '음악 플레이어 접기' : '음악 플레이어 열기';
  toggle.setAttribute('aria-label', toggle.title);
}

function showMediaPlayer(kind) {
  if (kind === 'audio') musicOpen = true;
  else videoOpen = true;
  showPage();
  if (kind === 'audio' && !$('home').hidden) $('music-title').focus();
  if (kind === 'video' && !$('video-page').hidden) $('video-title').focus();
}

function pickMediaFolder(kind) {
  if (transferring) return toast('파일 전송이 끝난 뒤 다시 열어 주세요.');
  const start = players[kind].folder || state.settings.mediaFolders?.[kind] || '/';
  navigate(() => {
    mediaPicker = kind;
    pickerDialog = undefined;
    enterBrowser('picker', start);
  }, 'enter');
}

function openMediaPlayer(kind) {
  const folder = players[kind].folder || state.settings.mediaFolders?.[kind];
  if (!folder) return pickMediaFolder(kind);
  showMediaPlayer(kind);
  if (!players[kind].folder && !players[kind].loading) void loadMediaFolder(kind, folder);
}

function clearSubtitle() {
  subtitleRequest = undefined;
  const playback = $('video-playback');
  playback.querySelector('track')?.remove();
  for (const track of playback.textTracks) {
    if (track.kind === 'subtitles' || track.kind === 'captions') track.mode = 'disabled';
  }
  if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
  subtitleUrl = undefined;
  $('video-subtitle').value = '';
  notice('video-subtitle-status');
}

function stopMedia(kind) {
  const player = players[kind];
  if (kind === 'audio') return stopMusic();
  const id = player.id;
  player.id = player.selected = undefined;
  const playback = $(kind + '-playback');
  playback.pause();
  if (playback.hasAttribute('src')) {
    playback.removeAttribute('src');
    playback.load();
  }
  if (kind === 'video') { clearSubtitle(); showVideoLoading(); }
  if (id) void api.closePreview(id).catch(() => {});
}

function drawMediaList(kind) {
  const player = players[kind];
  const index = player.entries.indexOf(player.selected);
  $(kind + '-folder').textContent = player.folder || '';
  if (kind === 'audio') {
    for (const entry of player.entries) {
      if (!entry.control) continue;
      const selected = entry === player.selected;
      entry.control.setAttribute('aria-pressed', String(selected));
      if (selected) entry.control.closest('details').open = true;
    }
    $('audio-prev').disabled = index < 1;
    $('audio-next').disabled = index < 0 || index >= player.entries.length - 1;
    return;
  }
  $('video-current').textContent = player.selected?.name || '영상을 선택하세요';
  for (const entry of player.entries) {
    if (!entry.control) continue;
    entry.control.setAttribute('aria-pressed', String(entry === player.selected));
    if (entry === player.selected) entry.control.closest('details').open = true;
  }
  const enabled = player.selected && $('video-playback').hasAttribute('src');
  $('video-subtitle').disabled = !enabled;
  $('video-local-subtitle').disabled = !enabled;
  drawVideoTransport();
}

function drawVideoLibrary(player) {
  const folders = new Map();
  for (const entry of player.entries) {
    const folder = entry.folder || player.folder;
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(entry);
  }
  const groups = [];
  for (const [folder, entries] of folders) {
    const row = make('li');
    const group = make('details', '', 'video-folder-group');
    group.open = groups.length === 0;
    const display = folder === player.folder ? '기본 폴더' : folder.slice(player.folder === '/' ? 1 : player.folder.length + 1);
    const summary = make('summary');
    summary.append(make('span', display, 'video-folder-name'),
      make('span', String(entries.length), 'video-folder-count'));
    summary.title = folder;
    const list = make('ul');
    for (const entry of entries) {
      const item = make('li');
      const control = entry.control = button(entry.name, () => void playMedia('video', entry));
      control.title = entry.name;
      item.append(control);
      list.append(item);
    }
    group.append(summary, list);
    row.append(group);
    groups.push(row);
  }
  $('video-list').replaceChildren(...groups);
}

async function loadMediaFolder(kind, folder, fromSettings = false) {
  const player = players[kind];
  stopMedia(kind);
  player.entries = [];
  $(kind + '-list').replaceChildren();
  drawMediaList(kind);
  const request = player.loading = Symbol();
  const statusId = fromSettings ? 'settings-media-status' : kind + '-status';
  notice(statusId, 'NAS 폴더를 불러오는 중…');
  try {
    const { entries, subtitles, truncated, skipped } = await api.mediaFolder(kind, folder);
    if (player.loading !== request) return;
    player.folder = folder;
    const compare = (a, b) => a.localeCompare(b, 'ko', { numeric: true });
    player.entries = entries.sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name));
    if (kind === 'audio') drawMusicLibrary(player.entries);
    else drawVideoLibrary(player);
    if (kind === 'video') {
      player.subtitles = subtitles;
      drawVideoSubtitles();
    }
    drawMediaList(kind);
    const note = [truncated && '탐색 한도에 도달해 일부 ' + (kind === 'video' ? '영상' : '앨범') + '만 표시합니다.',
      skipped && '읽지 못한 하위 폴더 ' + skipped + '개가 있습니다.'].filter(Boolean).join(' ');
    const message = entries.length ? note : '이 폴더에 지원하는 ' + player.name + ' 파일이 없습니다. ' + note;
    notice(statusId, message || (fromSettings ? '기본 폴더를 저장했습니다.' : ''));
  } catch (error) {
    if (player.loading === request) {
      player.folder = undefined;
      drawMediaList(kind);
      notice(statusId, error.message, true);
    }
  } finally {
    if (player.loading === request) player.loading = undefined;
  }
}

async function loadVideoSubtitle(read, label) {
  clearSubtitle();
  const request = subtitleRequest = Symbol();
  const playback = $('video-playback');
  notice('video-subtitle-status', '자막을 불러오는 중…');
  try {
    const bytes = await read();
    const { subtitleVtt } = await import('./media-subtitles.mjs');
    if (subtitleRequest !== request) return;
    const content = subtitleVtt(bytes);
    subtitleUrl = URL.createObjectURL(new Blob([content], { type: 'text/vtt' }));
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.default = true;
    track.src = subtitleUrl;
    track.addEventListener('error', () => {
      if (subtitleRequest === request) notice('video-subtitle-status', '자막을 표시할 수 없습니다.', true);
    });
    playback.append(track);
    track.track.mode = 'showing';
    notice('video-subtitle-status', '적용된 자막 · ' + label);
  } catch (error) {
    if (subtitleRequest === request) notice('video-subtitle-status', error.message, true);
  }
}

function embeddedVideoSubtitles() {
  const media = $('video-playback');
  const added = media.querySelector('track')?.track;
  return [...media.textTracks].filter(track => track !== added && ['subtitles', 'captions'].includes(track.kind));
}

function drawVideoSubtitles() {
  const player = players.video;
  const current = player.selected;
  const files = current ? player.subtitles.slice().sort((a, b) =>
    Number(b.folder === current.folder) - Number(a.folder === current.folder) ||
    a.name.localeCompare(b.name, 'ko', { numeric: true })) : [];
  const select = $('video-subtitle');
  const selected = select.value;
  const builtIn = current ? embeddedVideoSubtitles().map((track, index) =>
    new Option('내장 · ' + (track.label || track.language || (index + 1)), 'embedded:' + index)) : [];
  select.replaceChildren(new Option('자막 끄기', ''), ...builtIn, ...files.map(file =>
    new Option(file.folder === current.folder ? file.name : (file.folder.split('/').at(-1) + ' / ' + file.name), file.path)));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function matchingVideoSubtitle(entry) {
  const stem = name => name.replace(/\.[^.]+$/u, '').normalize('NFC').toLowerCase();
  const video = stem(entry.name);
  const files = players.video.subtitles.filter(file => {
    if (file.folder !== entry.folder && !file.folder.startsWith(entry.folder === '/' ? '/' : entry.folder + '/')) return false;
    const name = stem(file.name);
    return name === video || (name.startsWith(video) && /^[. _-]/u.test(name.slice(video.length)));
  });
  return files.find(file => file.folder === entry.folder && stem(file.name) === video) ||
    files.find(file => /(?:[. _-](?:ko|kor|korean|한글|한국어))\.[^.]+$/iu.test(file.name)) || files[0];
}

function selectNasSubtitle(path) {
  if (path.startsWith('embedded:')) {
    clearSubtitle();
    const track = embeddedVideoSubtitles()[Number(path.slice(9))];
    if (track) {
      track.mode = 'showing';
      $('video-subtitle').value = path;
    }
    return;
  }
  const file = players.video.subtitles.find(item => item.path === path);
  if (!file) return clearSubtitle();
  void loadVideoSubtitle(() => api.mediaSubtitle(file.folder || players.video.folder, file.path), file.name);
  $('video-subtitle').value = file.path;
}

function showVideoLoading(message = '') {
  $('video-loading-text').textContent = message;
  $('video-loading').hidden = !message;
}

function drawVideoTransport() {
  const media = $('video-playback');
  const ready = media.hasAttribute('src');
  const duration = Number.isFinite(media.duration) ? media.duration : 0;
  const seek = $('video-seek');
  seek.disabled = !duration;
  seek.max = duration || 1;
  if (!seek.matches(':active')) seek.value = media.currentTime;
  $('video-time').textContent = musicTime(Number(seek.value)) + ' / ' + musicTime(duration);
  const control = $('video-play');
  const glyph = ready && !media.paused && !media.ended ? 'pause' : 'play';
  if (control.dataset.glyph !== glyph) {
    control.replaceChildren(icon(glyph));
    control.dataset.glyph = glyph;
  }
  control.title = glyph === 'pause' ? '일시 정지' : '재생';
  control.setAttribute('aria-label', control.title);
  control.disabled = !ready;
}

async function playMedia(kind, entry) {
  const player = players[kind];
  if (!player.entries.includes(entry)) return;
  if (kind === 'audio') return playMusic(entry);
  stopMedia(kind);
  const id = player.id = crypto.randomUUID();
  player.selected = entry;
  drawMediaList(kind);
  notice(kind + '-status');
  showVideoLoading('NAS에서 영상을 읽는 중…');
  drawVideoSubtitles();
  const playback = $(kind + '-playback');
  try {
    const { url } = await api.mediaPlay(id, kind, entry.folder || player.folder, entry.path);
    if (player.id !== id) {
      void api.closePreview(id).catch(() => {});
      return;
    }
    playback.src = url;
    drawMediaList(kind);
    const subtitle = matchingVideoSubtitle(entry);
    if (subtitle) selectNasSubtitle(subtitle.path);
    try {
      await playback.play();
    } catch (error) {
      if (player.id !== id || !/\.mkv$/iu.test(entry.name) || error.name === 'NotAllowedError') throw error;
      playback.removeAttribute('src');
      playback.load();
      notice('video-status');
      showVideoLoading('MKV 호환 재생을 준비하는 중…');
      const compatible = await api.mediaCompatible(id);
      if (player.id !== id) return;
      playback.src = compatible.url;
      drawMediaList(kind);
      await playback.play();
    }
  } catch (error) {
    if (player.id === id) {
      showVideoLoading();
      const message = error.name === 'NotAllowedError' ? '재생 버튼을 눌러 시작하세요.'
        : error.name === 'NotSupportedError' ? '이 영상의 코덱을 재생할 수 없습니다.' : error.message;
      notice(kind + '-status', message, true);
    }
  }
}

const audioElements = [$('audio-playback'), $('audio-preload')];
let musicCoverUrl;

function musicTime(seconds) {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}

function trackName(entry) {
  return entry.name.replace(/\.[^.]+$/u, '');
}

function drawMusicLibrary(entries) {
  const albums = new Map();
  const list = $('audio-list');
  list.replaceChildren();
  for (const entry of entries) {
    if (!albums.has(entry.folder)) albums.set(entry.folder, []);
    albums.get(entry.folder).push(entry);
  }
  for (const album of albums.values()) {
    const group = make('details', '', 'music-album');
    group.open = albums.size <= 3;
    const heading = make('summary');
    heading.append(make('span', album[0].album || '선택한 폴더'), make('small', album.length + '곡'));
    const tracks = make('ol');
    album.forEach((entry, index) => {
      const item = make('li');
      const control = entry.control = button('', () => void playMedia('audio', entry), 'music-track');
      const number = make('span', String(index + 1), 'music-track-number');
      const title = entry.titleLabel = make('strong', trackName(entry));
      const playing = make('span', '', 'music-equalizer');
      playing.setAttribute('aria-hidden', 'true');
      playing.append(make('i'), make('i'), make('i'));
      entry.durationLabel = make('span', '', 'music-track-duration');
      control.append(number, playing, title, entry.durationLabel);
      item.append(control);
      tracks.append(item);
    });
    group.append(heading, tracks);
    list.append(group);
  }
}

function renderMusicTrack(job) {
  const tags = job?.metadata;
  $('audio-current').textContent = job ? tags?.title || trackName(job.entry) : '곡을 선택하세요';
  $('music-track-detail').textContent = job
    ? [tags?.artist, tags?.album || job.entry.album].filter(Boolean).join(' · ') : '재생할 곡을 골라 주세요';
  const cover = $('music-cover');
  cover.hidden = true;
  cover.removeAttribute('src');
  if (musicCoverUrl) URL.revokeObjectURL(musicCoverUrl);
  musicCoverUrl = undefined;
  if (tags?.cover) {
    musicCoverUrl = URL.createObjectURL(new Blob([tags.cover.bytes], { type: tags.cover.type }));
    cover.src = musicCoverUrl;
    cover.hidden = false;
  }
}

function drawMusicTransport() {
  const job = players.audio.current;
  const media = job && audioElements[job.slot];
  const ready = media?.hasAttribute('src');
  const playing = ready && !media.paused && !media.ended;
  const control = $('music-play');
  const glyph = playing ? 'pause' : 'play';
  if (control.dataset.glyph !== glyph) {
    control.replaceChildren(icon(glyph));
    control.dataset.glyph = glyph;
  }
  control.title = playing ? '일시 정지' : '재생';
  control.setAttribute('aria-label', control.title);
  control.disabled = !ready;
  const duration = ready && Number.isFinite(media.duration) ? media.duration : 0;
  const elapsed = ready ? media.currentTime : 0;
  const seek = $('music-seek');
  seek.disabled = !duration;
  seek.max = duration || 1;
  if (!seek.matches(':active')) seek.value = elapsed;
  seek.style.setProperty('--music-progress', (duration ? elapsed / duration * 100 : 0) + '%');
  $('music-elapsed').textContent = musicTime(Number(seek.value));
  $('music-duration').textContent = musicTime(duration);
  $('music-toggle').classList.toggle('is-playing', playing);
  $('music-panel').classList.toggle('is-playing', playing);
}

function releaseMusic(job) {
  if (!job) return;
  const media = audioElements[job.slot];
  if (media.dataset.job === job.id) {
    delete media.dataset.job;
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  void api.closePreview(job.id).catch(() => {});
}

function stopMusic() {
  const player = players.audio;
  const { current, next } = player;
  player.current = player.next = player.selected = undefined;
  releaseMusic(current);
  releaseMusic(next);
  renderMusicTrack();
  drawMusicTransport();
}

function prepareMusic(entry, slot) {
  const player = players.audio;
  const media = audioElements[slot];
  const job = { id: crypto.randomUUID(), entry, slot };
  job.ready = api.mediaPlay(job.id, 'audio', entry.folder || player.folder, entry.path, slot, entry.cover)
    .then(({ url, metadata }) => {
      if (player.current !== job && player.next !== job) {
        releaseMusic(job);
        return;
      }
      job.metadata = metadata;
      if (metadata?.title && entry.titleLabel) entry.titleLabel.textContent = metadata.title;
      if (metadata?.duration && entry.durationLabel) entry.durationLabel.textContent = musicTime(metadata.duration);
      media.dataset.job = job.id;
      media.src = url;
      media.load();
    });
  return job;
}

function warmNextMusic() {
  const player = players.audio;
  const { current } = player;
  if (!current || player.next) return;
  const entry = player.entries[player.entries.indexOf(current.entry) + 1];
  if (!entry) return;
  const job = player.next = prepareMusic(entry, 1 - current.slot);
  void job.ready.catch(() => {
    if (player.next === job) {
      player.next = undefined;
      releaseMusic(job);
    }
  });
}

function showAudioLoading(message) {
  const status = $('audio-status');
  notice('audio-status', message);
  status.classList.toggle('audio-loading', !!message);
  if (message) {
    const spinner = make('span', '', 'signin-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    status.prepend(spinner);
  }
}

async function playMusic(entry, usePreload = true) {
  const player = players.audio;
  if (usePreload && player.current?.entry === entry) {
    const media = audioElements[player.current.slot];
    if (media.hasAttribute('src')) {
      void media.play().catch(error => notice('audio-status', error.message, true));
      return;
    }
  }
  const previous = player.current;
  const warm = usePreload && player.next?.entry === entry ? player.next : undefined;
  if (!warm) releaseMusic(player.next);
  player.next = undefined;
  releaseMusic(previous);
  const current = player.current = warm || prepareMusic(entry, previous?.slot ?? 0);
  player.selected = entry;
  renderMusicTrack(current);
  drawMediaList('audio');
  drawMusicTransport();
  showAudioLoading('NAS에서 곡을 준비하는 중…');
  try {
    await current.ready;
    if (player.current !== current) return;
    renderMusicTrack(current);
    drawMusicTransport();
    const playback = audioElements[current.slot].play();
    if (warm) {
      let timer;
      try {
        await Promise.race([playback, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('미리 불러온 곡의 재생이 지연되었습니다.')), 12000);
        })]);
      } finally { clearTimeout(timer); }
    } else await playback;
    if (player.current === current) showAudioLoading();
  } catch (error) {
    if (player.current !== current) return;
    if (warm && error.name !== 'NotAllowedError') {
      await playMusic(entry, false);
      return;
    }
    showAudioLoading();
    let message = error.message;
    if (error.name === 'NotAllowedError') message = '재생 버튼을 눌러 시작하세요.';
    if (error.name === 'NotSupportedError') message = '이 파일의 형식이나 코덱을 재생할 수 없습니다.';
    notice('audio-status', message, true);
  }
}

function moveMusic(offset) {
  const { entries, selected } = players.audio;
  if (!selected) return;
  const entry = entries[entries.indexOf(selected) + offset];
  if (entry) void playMedia('audio', entry);
}

for (const kind of Object.keys(players)) {
  drawMediaList(kind);
  $('settings-' + kind + '-pick').addEventListener('click', () => pickMediaFolder(kind));
}
const videoPlayback = $('video-playback');
videoPlayback.textTracks.addEventListener('addtrack', drawVideoSubtitles);
for (const event of ['loadstart', 'waiting', 'seeking', 'seeked', 'timeupdate', 'loadedmetadata', 'canplay', 'playing', 'pause', 'ended', 'error']) {
  videoPlayback.addEventListener(event, () => {
    drawVideoTransport();
    if (!videoPlayback.hasAttribute('src')) return;
    if (event === 'loadedmetadata') drawVideoSubtitles();
    if (['loadstart', 'waiting', 'seeking'].includes(event)) showVideoLoading('영상을 불러오는 중…');
    else if (['canplay', 'playing', 'seeked', 'error', 'ended'].includes(event)) showVideoLoading();
    if (event === 'error') {
      const message = videoPlayback.error?.code === 2
        ? 'NAS에서 영상 데이터를 읽는 중 연결이 끊겼습니다.' : '이 영상의 코덱을 재생할 수 없습니다.';
      notice('video-status', message, true);
    }
  });
}
$('video-play').addEventListener('click', () => {
  if (videoPlayback.paused) void videoPlayback.play().catch(error => notice('video-status', error.message, true));
  else videoPlayback.pause();
});
$('video-seek').addEventListener('change', event => { videoPlayback.currentTime = Number(event.currentTarget.value); });
$('video-volume').addEventListener('input', event => { videoPlayback.volume = Number(event.currentTarget.value) / 100; });
$('video-fullscreen').append(icon('fullscreen'));
$('video-fullscreen').addEventListener('click', () => {
  const action = document.fullscreenElement ? document.exitFullscreen() : $('video-stage').requestFullscreen();
  void action.catch(error => notice('video-status', error.message, true));
});
for (const [slot, media] of audioElements.entries()) {
  for (const event of ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ended', 'error', 'waiting', 'seeking', 'seeked', 'playing']) {
    media.addEventListener(event, () => {
      if (players.audio.current?.slot !== slot || media.dataset.job !== players.audio.current.id) return;
      drawMusicTransport();
      if (event === 'play') warmNextMusic();
      if (event === 'waiting' || event === 'seeking') showAudioLoading('재생 위치를 불러오는 중…');
      if (['playing', 'seeked', 'ended', 'error'].includes(event)) showAudioLoading();
      if (event === 'ended') moveMusic(1);
      if (event === 'error') notice('audio-status', '이 파일의 형식이나 코덱을 재생할 수 없습니다.', true);
    });
  }
}
$('music-art').prepend(icon('audio'));
$('music-cover').addEventListener('error', event => { event.currentTarget.hidden = true; });
$('audio-prev').append(icon('previous'));
$('audio-next').append(icon('next'));
$('music-play').addEventListener('click', () => {
  const job = players.audio.current;
  if (!job) return;
  const media = audioElements[job.slot];
  if (media.paused) void media.play().catch(error => notice('audio-status', error.message, true));
  else media.pause();
});
$('music-seek').addEventListener('change', event => {
  const job = players.audio.current;
  if (job) audioElements[job.slot].currentTime = Number(event.currentTarget.value);
});
$('music-seek').addEventListener('input', event => { $('music-elapsed').textContent = musicTime(Number(event.currentTarget.value)); });
$('music-volume').addEventListener('input', event => {
  for (const media of audioElements) media.volume = Number(event.currentTarget.value) / 100;
});
drawMusicTransport();
$('music-toggle').append(icon('audio', '#a9c6f8'));
const musicIndicator = make('span', '', 'music-equalizer');
musicIndicator.setAttribute('aria-hidden', 'true');
musicIndicator.append(make('i'), make('i'), make('i'));
$('music-toggle').append(musicIndicator);
$('music-toggle').addEventListener('click', () => {
  if (!musicOpen) return openMediaPlayer('audio');
  musicOpen = false;
  drawMusicPanel();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !musicOpen || $('home').hidden || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  musicOpen = false;
  drawMusicPanel();
  $('music-toggle').focus();
});
$('audio-prev').addEventListener('click', () => moveMusic(-1));
$('audio-next').addEventListener('click', () => moveMusic(1));
$('video-back').addEventListener('click', () => {
  videoOpen = false;
  stopMedia('video');
  drawMediaList('video');
  showPage();
  $('groups').querySelector('.tile:has(.video)')?.focus();
});
$('video-subtitle').addEventListener('change', event => selectNasSubtitle(event.currentTarget.value));
$('video-local-subtitle').addEventListener('click', () => $('video-subtitle-input').click());
$('video-subtitle-input').addEventListener('change', event => {
  const { files } = event.currentTarget;
  const file = files[0];
  event.currentTarget.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 ** 2 || !/\.(?:srt|vtt|ass|ssa|smi)$/iu.test(file.name)) {
    return notice('video-subtitle-status', '2 MiB 이하의 SRT, VTT, ASS, SSA 또는 SMI 자막을 선택하세요.', true);
  }
  void loadVideoSubtitle(async () => new Uint8Array(await file.arrayBuffer()), file.name);
});

function returnHome() {
  if (servicePage === 'server' && !$('signin').hidden) {
    servicePage = undefined;
    showPage();
    animateSigninPanel();
    $('signin-services').querySelector('.tile')?.focus({ preventScroll: true });
    return;
  }
  navigate(() => {
    const glyph = servicePage === 'ai' ? 'ai-assistant' : 'server-update';
    servicePage = servicePage === 'ai' ? aiBackPage : undefined;
    showPage();
    if (!$('server-home').hidden && glyph === 'ai-assistant') {
      $('server-ai').focus();
      return;
    }
    const source = state.connected ? $('groups') : $('signin-services');
    source.querySelector('.tile:has(.' + glyph + ')')?.focus();
  });
}
$('server-login-back').addEventListener('click', returnHome);
for (const id of ['server-home-back', 'server-home-logout']) {
  const control = $(id);
  control.addEventListener('click', busy(control, async () => {
    if (id === 'server-home-back') return returnHome();
    const next = await api.serverUpdaterLogout(true);
    servicePage = undefined;
    apply(next);
    showPage();
    $('signin-services').querySelector('.tile')?.focus();
  }, error => notice('server-home-error', error.message, true)));
}
$('ai-back').addEventListener('click', returnHome);
$('ai-login-icon').append(icon('sparkles'));
$('ai-login-back').addEventListener('click', returnHome);
$('ai-login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (aiLoginPending || state.serverRestoring || state.aiEmail) return;
  const { email, password, remember } = event.currentTarget.elements;
  const credentials = { email: email.value, password: password.value, remember: remember.checked, forAi: true };
  password.value = '';
  aiLoginPending = true;
  notice('ai-login-error');
  showPage();
  try {
    apply(await api.serverUpdaterLogin(credentials));
  } catch (error) {
    notice('ai-login-error', error.message);
  } finally {
    aiLoginPending = false;
    showPage();
    if (!$('ai-login').hidden) password.focus();
  }
});
const aiSidebarMedia = matchMedia('(max-width: 820px)');
let aiSidebarOpen = !aiSidebarMedia.matches;
function setAiSidebar(open) {
  aiSidebarOpen = open;
  $('ai-home').classList.toggle('ai-sidebar-closed', !open);
  $('ai-sidebar').inert = !open;
  const toggle = $('ai-sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '대화 목록 접기' : '대화 목록 열기');
}
setAiSidebar(aiSidebarOpen);
aiSidebarMedia.addEventListener('change', event => setAiSidebar(!event.matches));
$('ai-sidebar-toggle').append(icon('sidebar'));
$('ai-sidebar-toggle').addEventListener('click', () => setAiSidebar(!aiSidebarOpen));
$('ai-new-icon').append(icon('add'));
$('ai-search-icon').append(icon('search'));
$('ai-welcome-icon').append(icon('sparkles'));
$('ai-manage-form').addEventListener('submit', event => {
  event.preventDefault();
  const { chat, action } = aiManageTarget;
  void busy($('ai-manage-submit'), async () => {
    const title = await api.aiManageChat(chat.id, action, elements('ai-manage-form').title.value);
    $('ai-manage-dialog').close();
    if (!aiChats.includes(chat)) return;
    if (action === 'rename') {
      chat.title = title;
      chat.summarized = true;
    } else {
      aiChats = aiChats.filter(item => item !== chat);
      if (activeAiChat === chat) {
        activeAiChat = aiChats[0];
        if (!activeAiChat) return newAiChat();
      }
    }
    drawAiChat(true);
  }, error => notice('ai-manage-error', error.message, true))();
});
function closeAiChatMenus() {
  for (const menu of $('ai-chat-list').querySelectorAll('.ai-chat-menu:popover-open')) menu.hidePopover();
}
$('ai-chat-list').addEventListener('scroll', closeAiChatMenus);
window.addEventListener('resize', closeAiChatMenus);
$('ai-search').addEventListener('input', drawAiChatList);
$('ai-suggestions').addEventListener('click', event => {
  const control = event.target.closest('button');
  if (!control) return;
  const input = elements('ai-form').message;
  input.value = control.textContent + ' ';
  input.focus();
  drawAiRequestStatus();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || !aiSidebarMedia.matches || !aiSidebarOpen ||
      $('ai-home').hidden || $('ai-usage').open) return;
  setAiSidebar(false);
  $('ai-sidebar-toggle').focus();
});
$('ai-new-chat').addEventListener('click', newAiChat);
document.addEventListener('pointerdown', event => {
  const usage = $('ai-usage');
  if (usage.open && !usage.contains(event.target)) usage.open = false;
});
$('ai-usage').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !$('ai-usage').open) return;
  event.stopPropagation();
  $('ai-usage').open = false;
  $('ai-usage-toggle').focus();
});
$('ai-attach').append(icon('add'));
async function attachAiFiles(filesToAttach) {
  const chat = activeAiChat;
  if (!chat || $('ai-attach').disabled) return;
  choosingAiAttachments = true;
  drawAiRequestStatus();
  notice('ai-error');
  try {
    const { files, errors } = await (filesToAttach ? api.aiAttachDropped(filesToAttach) : api.aiPickFiles());
    if (!aiChats.includes(chat)) return;
    const drafts = chat.draftFiles ??= [];
    for (const file of files) {
      if (drafts.some(item => item.name === file.name && item.text === file.text)) continue;
      if (drafts.length === 3) {
        errors.push('파일은 최대 3개까지 첨부할 수 있습니다.');
        break;
      }
      drafts.push(file);
    }
    if (activeAiChat === chat && errors.length) notice('ai-error', errors.join(' · '), true);
  } catch (error) {
    if (activeAiChat === chat) notice('ai-error', error.message, true);
  } finally {
    choosingAiAttachments = false;
    drawAiAttachments();
    drawAiRequestStatus();
  }
}
$('ai-attach').addEventListener('click', () => void attachAiFiles());
const aiDropZone = $('ai-home');
aiDropZone.addEventListener('dragover', event => {
  if (!draggingLocalFiles(event)) return;
  event.preventDefault();
  const allowed = !aiDropZone.hidden && !$('ai-attach').disabled;
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
  $('ai-form').classList.toggle('file-drop-target', allowed);
});
aiDropZone.addEventListener('dragleave', event => {
  if (!aiDropZone.contains(event.relatedTarget)) $('ai-form').classList.remove('file-drop-target');
});
aiDropZone.addEventListener('drop', event => {
  if (!draggingLocalFiles(event)) return;
  event.preventDefault();
  $('ai-form').classList.remove('file-drop-target');
  if (!aiDropZone.hidden && !$('ai-attach').disabled) void attachAiFiles(Array.from(event.dataTransfer.files));
});
$('ai-send').append(icon('up'));
$('ai-stop').append(icon('stop'));
$('ai-stop').addEventListener('click', async () => {
  const request = aiRequest;
  if (!request) return;
  const previousPhase = request.phase;
  request.cancelledWhileQueued = previousPhase === 'queued';
  request.phase = 'stopping';
  drawAiRequestStatus();
  try {
    await api.aiCancel();
  } catch (error) {
    if (aiRequest !== request) return;
    request.phase = previousPhase;
    request.cancelledWhileQueued = false;
    drawAiRequestStatus();
    if (activeAiChat === request.chat) notice('ai-error', error.message);
  }
});
api.onAiPhase((id, phase) => {
  if (aiRequest?.id !== id || aiRequest.phase === 'stopping' || !Object.hasOwn(aiPhaseLabels, phase)) return;
  aiRequest.phase = phase;
  drawAiRequestStatus();
});
api.onAiText((id, text) => {
  if (aiRequest?.id !== id) return;
  const firstText = !aiRequest.answer;
  aiRequest.answer += text;
  if (firstText && aiRequest.phase !== 'stopping') {
    aiRequest.phase = 'writing';
    drawAiRequestStatus();
  }
  const feed = $('ai-messages');
  const output = feed.querySelector('.ai-streaming');
  if (output) {
    const follow = aiFeedAtBottom(feed);
    output.textContent = aiRequest.answer;
    if (follow) feed.scrollTop = feed.scrollHeight;
  }
});
$('ai-form').addEventListener('keydown', event => {
  if (event.target.name !== 'message' || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  event.currentTarget.requestSubmit();
});
$('ai-form').addEventListener('input', drawAiRequestStatus);
$('ai-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state?.aiEmail || aiRequest || !activeAiChat || $('ai-send').disabled) return;
  const input = event.currentTarget.elements.message;
  const content = input.value.trim();
  const chat = activeAiChat;
  const attachments = chat.draftFiles ?? [];
  if (!content && !attachments.length) return;
  chat.draftFiles = [];
  const message = { role: 'user', content, attachments };
  const request = aiRequest = { id: crypto.randomUUID(), chat, answer: '', phase: 'preparing', startedAt: performance.now() };
  chat.messages.push(message);
  if (chat.messages.length === 1) chat.title = (content || attachments[0].name).replace(/\s+/gu, ' ').slice(0, 45);
  clearTimeout(aiTitleTimer);
  input.value = '';
  notice('ai-error');
  drawAiChat(true);
  try {
    const answer = await api.aiChat(request.id, chat.id, content, $('ai-effort').value, attachments);
    if (aiRequest !== request) return;
    if (answer) chat.messages.push({ role: 'assistant', content: answer });
    else if (request.cancelledWhileQueued) {
      chat.draftFiles = attachments;
      if (activeAiChat === chat && !input.value) input.value = content;
    }
  } catch (error) {
    if (aiRequest !== request) return;
    chat.draftFiles = attachments;
    if (activeAiChat === chat) {
      notice('ai-error', error.message);
      if (!input.value) input.value = content;
    }
  } finally {
    if (aiRequest === request) {
      if (chat.messages.at(-1) === message) chat.messages.pop();
      if (!chat.messages.length) chat.title = '새 대화';
      aiRequest = undefined;
      drawAiChat();
      scheduleAiTitle();
    }
  }
});
for (const [id, feature, label, glyph] of [
  ['server-terminal', 'terminal', '터미널', 'terminal'], ['server-ai', 'ai-assistant', 'AI', 'sparkles']
]) {
  const shortcut = tile(label, feature, () => activate(feature), glyph);
  shortcut.id = id;
  $('server-home-tiles').append(shortcut);
}
$('server-monitor-toggle').append(icon('activity', '#a9c6f8'));
$('server-monitor-options-button').append(icon('sliders'));
$('server-monitor-register').prepend(icon('add'));
$('server-monitor-toggle').addEventListener('click', () => $('server-monitor-title').scrollIntoView({ block: 'start' }));
$('server-monitor-options-button').addEventListener('click', () => setServerMonitoringView($('server-monitor-options-button').getAttribute('aria-expanded') !== 'true'));
$('server-monitor-register').addEventListener('click', () => setServerRegistration($('server-monitor-register').getAttribute('aria-expanded') !== 'true'));
$('server-monitor-cancel').addEventListener('click', () => {
  setServerRegistration(false);
  $('server-monitor-register').focus();
});
document.addEventListener('click', event => {
  if (!$('server-monitor-controls').hidden && !event.target.closest('#server-monitor-controls, #server-monitor-options-button')) {
    setServerMonitoringView(false);
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('server-home').hidden && !$('server-monitor-controls').hidden && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    setServerMonitoringView(false);
    $('server-monitor-options-button').focus();
  }
});
$('server-deploy-form').addEventListener('submit', event => {
  event.preventDefault();
  const project = deployProject;
  const asset = Number($('server-deploy-asset').value);
  $('server-deploy-dialog').close();
  notice('server-home-error');
  void api.serverDeploy(project, asset).catch(error => notice('server-home-error', error.message, true));
});
function setServerProjectForm(open) {
  $('server-file-add').hidden = !open;
  $('server-file-toggle').setAttribute('aria-expanded', String(open));
}

function openServerProjectForm() {
  setServerProjectForm(true);
  elements('server-file-form').name.focus();
}

$('server-file-toggle').addEventListener('click', () => {
  if ($('server-file-add').hidden) openServerProjectForm();
  else setServerProjectForm(false);
});

const serverSiteChecks = new Set();
async function checkServerSites(id) {
  if (serverSiteChecks.size || state.serverUpdaterAccount?.monitoring?.checking) return;
  notice('server-monitor-error');
  serverSiteChecks.add(id ?? '*');
  drawServerMonitoring(state.serverUpdaterAccount?.monitoring);
  try { apply(await api.serverMonitorCheck(id)); }
  catch (error) { notice('server-monitor-error', error.message, true); }
  finally {
    serverSiteChecks.clear();
    drawServerMonitoring(state.serverUpdaterAccount?.monitoring);
  }
}
let serverMonitorSaving = false;
async function saveServerMonitorQuick() {
  if (serverMonitorSaving) return;
  const form = elements('server-monitor-settings');
  serverMonitorSaving = true;
  const controls = [...$('server-monitor-settings').querySelectorAll('input, button')];
  controls.forEach(control => { control.disabled = true; });
  notice('server-monitor-error');
  try {
    apply(await api.serverMonitorSettings({ enabled: form.enabled.checked,
      deliveryEnabled: form.deliveryEnabled.checked, time: form.time.value }));
  } catch (error) {
    drawServerMonitoring(state.serverUpdaterAccount?.monitoring);
    notice('server-monitor-error', error.message, true);
  } finally {
    serverMonitorSaving = false;
    controls.forEach(control => { control.disabled = false; });
  }
}
for (const name of ['enabled', 'deliveryEnabled']) {
  elements('server-monitor-settings')[name].addEventListener('change', () => void saveServerMonitorQuick());
}
$('server-monitor-times').addEventListener('click', event => {
  const choice = event.target.closest('[data-time]');
  if (!choice || serverMonitorSaving) return;
  elements('server-monitor-settings').time.value = choice.dataset.time;
  for (const button of $('server-monitor-times').children) button.setAttribute('aria-pressed', String(button === choice));
  void saveServerMonitorQuick();
});

$('server-monitor-check').addEventListener('click', () => void checkServerSites());
for (const mode of ['list', 'grid']) {
  $('server-sites-' + mode).addEventListener('click', () => {
    const targets = $('server-monitor-targets');
    const grid = mode === 'grid';
    if (targets.classList.contains('as-grid') === grid) return;
    const cards = [...targets.querySelectorAll('.server-monitor-card')];
    const animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const before = animate ? cards.map(card => card.getBoundingClientRect()) : [];
    targets.classList.toggle('as-grid', grid);
    $('server-sites-grid').parentElement.classList.toggle('as-list', !grid);
    for (const option of ['list', 'grid']) $('server-sites-' + option).setAttribute('aria-pressed', String(option === mode));
    if (!animate) return;
    cards.forEach((card, index) => {
      card.getAnimations().forEach(animation => animation.cancel());
      const after = card.getBoundingClientRect();
      card.animate([{ transform: `translate(${before[index].x - after.x}px, ${before[index].y - after.y}px)`, opacity: .55 },
        { transform: 'none', opacity: 1 }], { duration: 550, delay: index * 35, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    });
  });
}

$('server-github-open').addEventListener('click', () => {
  notice('server-github-error');
  $('server-github-dialog').showModal();
});
$('server-github-dialog').addEventListener('close', () => $('server-github-form').reset());
$('server-github-token-help').addEventListener('click', () => {
  void api.openLink('serverGitHubToken')
    .catch(error => notice('server-github-error', error.message, true));
});
$('server-github-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  void busy(event.submitter ?? form.querySelector('[type="submit"]'), async () => {
    notice('server-github-error');
    try {
      await api.serverGitHubConnect(form.elements.token.value);
      $('server-github-dialog').close();
      notice('server-home-error');
    } finally {
      form.reset();
    }
  }, error => notice('server-github-error', error.message, true))();
});
$('server-github-disconnect').addEventListener('click', busy($('server-github-disconnect'), async () => {
  await api.serverGitHubDisconnect();
  $('server-github-dialog').close();
}, error => notice('server-github-error', error.message, true)));
$('server-github-repos').addEventListener('click', busy($('server-github-repos'), async () => {
  notice('server-home-error');
  const account = state.serverUpdaterAccount;
  const repositories = await api.serverGitHubRepos();
  if (account?.email !== state.serverUpdaterAccount?.email ||
      account?.githubLogin !== state.serverUpdaterAccount?.githubLogin) return;
  if (!repositories.length) throw new Error('이 토큰으로 접근할 수 있는 저장소가 없습니다.');
  const mine = make('optgroup');
  const shared = make('optgroup');
  mine.label = '내 저장소';
  shared.label = '공유 및 조직 저장소';
  const placeholder = make('option', '저장소 선택');
  placeholder.value = '';
  for (const repository of repositories) {
    const option = make('option', repository.name + (repository.private ? ' · 비공개' : ''));
    option.value = repository.name;
    const group = repository.name.split('/')[0].toLowerCase() === account.githubLogin?.toLowerCase() ? mine : shared;
    group.append(option);
  }
  $('server-github-repo').replaceChildren(placeholder, ...[mine, shared].filter(group => group.childElementCount));
  $('server-github-repo-field').hidden = false;
  $('server-github-repo').focus();
}, error => notice('server-home-error', error.message, true)));
$('server-github-repo').addEventListener('change', event => {
  const repository = event.currentTarget.value;
  if (!repository) return;
  const form = elements('server-file-form');
  form.name.value = repository.split('/')[1].slice(0, 80);
  form.url.value = 'https://github.com/' + repository + '/releases';
});
$('server-file-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = elements('server-file-form');
  const submit = event.submitter ?? event.currentTarget.querySelector('button[type="submit"]');
  void busy(submit, async () => {
    notice('server-home-error');
    await api.serverFileAdd({ name: form.name.value, url: form.url.value });
    $('server-file-form').reset();
    $('server-github-repo').selectedIndex = 0;
    setServerProjectForm(false);
    $('server-file-toggle').focus();
  }, error => notice('server-home-error', error.message, true))();
});
for (const [id, save] of [['server-monitor-target', (input) => api.serverMonitorTarget(input)],
  ['server-monitor-settings', (input, form) => api.serverMonitorSettings({ ...input,
    enabled: form.elements.enabled.checked, deliveryEnabled: form.elements.deliveryEnabled.checked,
    removeWebhook: form.elements.removeWebhook.checked })]]) {
  $(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    void busy(event.submitter ?? form.querySelector('[type="submit"]'), async () => {
      notice('server-monitor-error');
      const next = await save(Object.fromEntries(new FormData(form)), form);
      if (id === 'server-monitor-target') {
        form.reset();
        setServerRegistration(false);
        $('server-monitor-register').focus();
      }
      else {
        form.elements.webhook.value = '';
        form.elements.removeWebhook.checked = false;
        setServerMonitoringView(false);
        $('server-monitor-options-button').focus();
      }
      apply(next);
    }, error => notice('server-monitor-error', error.message, true))();
  });
}
for (const field of [login.url, login.user, login.pin, login.password]) field.addEventListener('input', savedLoginHint);
login.remember.addEventListener('change', savedLoginHint);
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state || state.connected || $('login-form').hidden || $('login-form').inert || $('login-button').disabled) return;
  const form = elements('login-form');
  const configuring = usageStep === 2 && usageConnection === 'nas';
  let focus;
  notice('login-error');
  loginPending = true;
  showPage();
  drawLoginButton();
  if (configuring) drawUsage();
  try {
    const request = api.login({
      url: form.url.value, user: form.user.value, pin: form.pin.value,
      name: form.name.value, editId: loginMode === 'edit' ? selectedNas.id : undefined,
      password: form.password.value, otp: form.otp.value, remember: configuring || form.remember.checked
    });
    form.password.value = '';
    form.otp.value = '';
    const next = await request;
    if (configuring) await advanceUsageAccount(next);
    else apply(next);
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
    if (configuring) drawUsage();
    if (configuring || !$('signin').hidden) focus?.focus();
  }
});
$('sync-now').addEventListener('click', async () => {
  if (!syncAreas.length) return openSettings('sync');
  try { await api.syncAll(); } catch (error) { toast(error.message); }
});
$('edit-button').addEventListener('click', () => openEditor());
for (const id of ['account-button', 'signin-settings', 'server-settings']) {
  $(id).addEventListener('click', () => openSettings());
}
for (const control of settingsSections) {
  const glyphs = { account: 'account', launcher: 'grid', media: 'video', sync: 'sync' };
  control.prepend(icon(glyphs[control.dataset.settingsSection]));
  control.addEventListener('click', () => {
    if (settingsSection === control.dataset.settingsSection) return;
    settingsSection = control.dataset.settingsSection;
    notice('account-error');
    drawSettings();
    $('settings-content').scrollTop = 0;
  });
}
function closeSettings() {
  settingsOpen = false;
  showPage();
  if (settingsTrigger?.getClientRects().length) settingsTrigger.focus();
  else $('signin-settings').focus();
  settingsTrigger = undefined;
}
const uninstallMac = $('uninstall-mac');
uninstallMac.addEventListener('click', busy(uninstallMac, () => api.uninstallMac(), error => toast(error.message)));
$('settings-back').addEventListener('click', () => navigate(closeSettings));
const reportSettings = error => notice('account-error', error.message, true);
for (const [id, name] of [['settings-tray', 'trayVisible'], ['settings-launch', 'launchAtLogin'],
  ['settings-auto-sync', 'automaticSync'], ['settings-skip-file-confirmations', 'skipFileConfirmations'], ['settings-skip-extract-confirmation', 'skipExtractConfirmation'], ['account-writes', 'remoteWrites']]) {
  const control = $(id);
  control.addEventListener('change', busy(control, async () => {
    notice('account-error');
    const next = name === 'remoteWrites' ? await api.remoteWrites(control.checked) : await api.setPreference(name, control.checked);
    apply(next);
  }, error => { drawSettings(); reportSettings(error); }));
}
$('settings-extract-destination').addEventListener('change', busy($('settings-extract-destination'), async () => {
  apply(await api.setPreference('extractInPlace', $('settings-extract-destination').value === 'here'));
}, error => { drawSettings(); reportSettings(error); }));
for (const [id, action] of [['account-switch', () => api.switchNas()], ['logout-button', () => api.logout()]]) {
  $(id).addEventListener('click', busy($(id), action, error => {
    if (settingsOpen) reportSettings(error);
    else toast(error.message);
  }));
}
for (const [id, action] of [['settings-server-logout', async () => {
    const next = await api.serverUpdaterLogout(true);
    servicePage = undefined;
    apply(next);
  }]]) {
  $(id).addEventListener('click', busy($(id), async () => { await action(); closeSettings(); }, reportSettings));
}
$('account-github-open').addEventListener('click', () => {
  settingsOpen = false;
  openGithub();
});
async function requestUpdate(restart = false) {
  if (!state || updateRequested || state.applyingUpdate || state.connecting) return;
  dismissedUpdate = undefined;
  updateButtonError = '';
  if (!restart && state.update?.phase === 'ready') return drawUpdate();
  restartingUpdate = restart;
  updateRequested = true;
  const signinError = servicePage === 'server' ? 'server-login-error' : 'login-error';
  if (!state.connected) notice(signinError);
  drawUpdate();
  try {
    await api.installUpdate(restart);
  } catch (error) {
    if (!$('signin-service-status').hidden && !$('signin').hidden) toast(error.message);
    else if (!$('signin').hidden) notice(signinError, error.message);
    else if (settingsOpen) updateButtonError = error.message;
    else toast(error.message);
  } finally {
    updateRequested = false;
    restartingUpdate = false;
    drawUpdate();
  }
}
$('update-now').addEventListener('click', () => void requestUpdate());
$('update-restart').addEventListener('click', () => void requestUpdate(true));
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || state?.update?.phase !== 'ready' || restartingUpdate ||
      document.querySelector('dialog[open]')) return;
  dismissedUpdate = state.update.tag || state.update.version;
  drawUpdate();
});
const signinUpdateButton = $('signin-update-check');
signinUpdateButton.addEventListener('pointerenter', () => {
  if (!signinUpdateButton.disabled && state?.update?.phase === 'current') showSigninCurrent();
});
for (const id of ['signin-update-check', 'account-update-check']) {
  $(id).addEventListener('click', async () => {
    if (!state || $(id).disabled) return;
    if (['available', 'ready'].includes(state.update?.phase)) {
      return requestUpdate(id === 'account-update-check' && state.update.phase === 'ready');
    }
    updateButtonError = '';
    drawUpdate();
    try {
      const checked = await api.checkUpdate();
      if (id === 'signin-update-check' && !state.connected && !state.connecting &&
          checked.update?.phase === 'current' && state.update?.phase === 'current') {
        showSigninCurrent();
      }
    } catch (error) {
      if (id === 'signin-update-check' && !$('signin-service-status').hidden && !$('signin').hidden) toast(error.message);
      else if (id === 'account-update-check') {
        updateButtonError = error.message;
        drawUpdate();
      } else notice(servicePage === 'server' ? 'server-login-error' : 'login-error', error.message, true);
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
      remote: form.remote.value, local: form.local.value, interval: form.interval.value
    }));
    toast('동기화 설정을 저장했습니다.');
  }, error => notice('settings-error', error.message, true))();
});
$('browser-home').addEventListener('click', () => navigate(leaveBrowser));
$('favorite-selection').addEventListener('click', () => {
  const folders = selectedFiles();
  if (browserMode !== 'remote' || !folders.length || folders.some(file => !file.directory)) return;
  const enabled = !folders.every(folder => (state.settings.folderFavorites ?? []).includes(folder.path));
  void (async () => {
    for (const folder of folders) await api.folderFavorite(folder.path, enabled);
  })().catch(error => toast(error.message));
});
$('browser-remote').addEventListener('click', () => { if (browserMode !== 'remote') openBrowser('remote'); });
$('browser-local').addEventListener('click', () => { if (browserMode !== 'local') openBrowser('local'); });
$('browser-results').addEventListener('click', event => {
  if (!transferring && selected.size && !event.target.closest('.file-card, tr, button')) clearSelection();
});
$('browser-results').tabIndex = -1;
$('browser-count').addEventListener('contextmenu', event => {
  event.preventDefault();
  openFileMenu(null, event.clientX, event.clientY);
});
$('browser-results').addEventListener('contextmenu', event => {
  const trigger = event.target.closest('[data-file-path]') ||
    event.target.closest('tr, .file-card')?.querySelector('[data-file-path]');
  if (event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  openFileMenu(trigger, event.clientX, event.clientY);
});
document.addEventListener('pointerdown', event => {
  if (!$('file-actions-menu').contains(event.target)) closeFileMenu();
});
$('browser-results').addEventListener('scroll', () => closeFileMenu());
window.addEventListener('resize', () => { closeFileMenu(); hideFileToolbarTip(); });
document.addEventListener('scroll', event => {
  if (!$('file-actions-menu').contains(event.target)) { closeFileMenu(); hideFileToolbarTip(); }
}, true);
$('file-actions-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    closeFileMenu(true);
    return;
  }
  const items = [...$('file-actions-menu').querySelectorAll('button:not(:disabled)')];
  const index = items.indexOf(document.activeElement);
  let target;
  if (event.key === 'ArrowDown') target = (index + 1) % items.length;
  else if (event.key === 'ArrowUp') target = index <= 0 ? items.length - 1 : index - 1;
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
let renameTarget;
$('rename-selection').addEventListener('click', () => {
  const [entry] = selectedFiles();
  if (!entry) return;
  renameTarget = { folder: browserPath, path: entry.path };
  const input = elements('rename-form').name;
  input.value = entry.name;
  notice('rename-error');
  $('rename-dialog').showModal();
  const extension = entry.directory ? -1 : entry.name.lastIndexOf('.');
  input.setSelectionRange(0, extension > 0 ? extension : entry.name.length);
});
$('rename-form').addEventListener('submit', event => {
  event.preventDefault();
  const { folder, path } = renameTarget;
  void busy(event.submitter, async () => {
    await api.renameFile(folder, path, elements('rename-form').name.value);
    $('rename-dialog').close();
    if (browserMode === 'remote' && browserPath === folder) await loadFolder(folder);
    toast('이름을 바꿨습니다.');
  }, error => notice('rename-error', error.message, true))();
});
let extractTarget;
function extractSelectedFile(folder, path, destination) {
  void transfer(async () => {
    const name = await api.extractArchive(folder, path, destination);
    return { message: name ? name + ' 폴더에 압축을 풀었습니다.' : '현재 폴더에 압축을 풀었습니다.' };
  }, undefined, 'extract').then(async result => {
    if (result && browserMode === 'remote' && browserPath === folder) await loadFolder(folder);
  });
}
$('extract-selection').addEventListener('click', () => {
  const [entry] = selectedFiles();
  if (!entry) return;
  if (state.skipExtractConfirmation === true) return extractSelectedFile(browserPath, entry.path, state.extractInPlace ? 'here' : 'folder');
  extractTarget = { folder: browserPath, path: entry.path };
  $('extract-skip-confirmation').checked = false;
  $('extract-name').textContent = entry.name;
  $('extract-form').querySelector('button[value="folder"]').title = entry.name.slice(0, -4) + '/';
  $('extract-dialog').showModal();
});
$('extract-form').addEventListener('submit', event => {
  event.preventDefault();
  const { folder, path } = extractTarget;
  const destination = event.submitter.value;
  const remember = $('extract-skip-confirmation').checked;
  void busy(event.submitter, async () => {
    if (remember) {
      apply(await api.setPreference('extractInPlace', destination === 'here'));
      apply(await api.setPreference('skipExtractConfirmation', true));
    }
    $('extract-dialog').close();
    extractSelectedFile(folder, path, destination);
  }, error => toast(error.message))();
});
$('download-selection').addEventListener('click', () => {
  const items = selectedFiles().map(file => file.path);
  void transfer(async () => {
    const result = await api.download(browserPath, items);
    if (!result) return;
    return { failed: !!result.errors, message: `다운로드 ${result.downloaded}개` +
      (result.skipped ? ` · 기존 파일 ${result.skipped}개` : '') +
      (result.errors ? ` · 실패 ${result.errors}개 · ${result.message}` : '') };
  }, undefined, 'download');
});
$('delete-selection').addEventListener('click', () => {
  const mode = browserMode;
  const folder = browserPath;
  const items = selectedFiles().map(file => file.path);
  void transfer(async () => {
    const result = await api.delete(mode, folder, items);
    if (!result) return;
    return { failed: !!result.errors.length, message: `삭제 ${result.deleted}개` +
      (result.errors.length ? ` · 실패 ${result.errors.length}개` : ''), details: result.errors };
  }, undefined, 'delete').then(async result => {
    if (result && browserMode === mode && browserPath === folder) await loadFolder(folder);
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
    navigate(leaveBrowser);
  } else if (browserMode !== 'picker' && event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    selected = new Set(browserEntries.map(entry => entry.path));
    updateSelection();
  } else if (event.key === 'Escape' && nasClipboard?.cut) {
    event.preventDefault();
    nasClipboard = undefined;
    clearSelection();
  } else if (event.key === 'Escape' && selected.size) {
    event.preventDefault();
    clearSelection();
  } else if (event.key === 'Delete' && selected.size && !$('delete-selection').hidden && !$('delete-selection').disabled) {
    event.preventDefault();
    $('delete-selection').click();
  }
});
$('up-button').addEventListener('click', () => navigateFolder(parentOf(browserPath)));
$('refresh-button').addEventListener('click', () => loadFolder(browserPath));
$('pick-button').addEventListener('click', () => navigate(() => {
  if (mediaPicker) {
    const kind = mediaPicker;
    const folder = browserPath;
    leaveBrowser();
    if (!settingsOpen) showMediaPlayer(kind);
    void loadMediaFolder(kind, folder, settingsOpen);
    return;
  }
  elements(pickerDialog === 'area-dialog' ? 'area-form' : 'settings-form').remote.value = browserPath;
  leaveBrowser();
}));
function uploadNasFiles(folder, files, retryId) {
  if (transferring || loadingFolder) return;
  uploadRetry = undefined;
  void transfer(async () => {
    const result = await (files ? api.uploadDropped(folder, files) : api.upload(folder, undefined, retryId));
    if (!result) return;
    uploadRetry = result.retryId ? () => uploadNasFiles(folder, undefined, result.retryId) : undefined;
    return { failed: !!result.errors.length, message: `업로드 ${result.uploaded}개` +
      (result.skipped ? ` · 건너뛰기 ${result.skipped}개` : '') +
      (result.errors.length ? ` · 실패 ${result.errors.length}개 · 눌러서 상세 보기` : ''), details: result.errors };
  }, undefined, 'upload').then(async result => {
    if (result && browserMode === 'remote' && browserPath === folder) await loadFolder(folder);
  });
}
$('upload-button').addEventListener('click', () => uploadNasFiles(browserPath));

document.addEventListener('keydown', event => {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey ||
      $('browser').hidden || browserMode !== 'remote' || transferring || loadingFolder ||
      document.querySelector('dialog[open]') ||
      event.target.closest('input, textarea, select, [contenteditable="true"]') ||
      window.getSelection()?.toString()) return;
  const key = event.key.toLowerCase();
  if (['c', 'x'].includes(key) && selected.size && browserPath !== '/') {
    if (key === 'x' && !state.settings.remoteWrites) return;
    event.preventDefault();
    nasClipboard = { folder: browserPath, paths: selectedFiles().map(file => file.path), cut: key === 'x',
      profile: state.profile.url + '\n' + state.profile.user };
    updateSelection();
    finishFileTransfer(key === 'x' ? 'move' : 'copy', nasClipboard.paths.length +
      (key === 'x' ? '개 잘라내기 · 대상 폴더에서 붙여넣으세요.' : '개 복사 · 대상 폴더에서 붙여넣으세요.'));
  } else if (key === 'v' && nasClipboard && browserPath !== '/' && state.settings.remoteWrites) {
    event.preventDefault();
    const direction = nasClipboard.cut ? 'move' : 'copy';
    if (nasClipboard.profile !== state.profile.url + '\n' + state.profile.user) {
      finishFileTransfer(direction, '선택한 NAS에 다시 연결해 주세요.', true);
      return;
    }
    const clipboard = nasClipboard;
    const folder = browserPath;
    void transfer(async () => {
      const result = await api.moveNas(clipboard.folder, clipboard.paths, folder, !clipboard.cut);
      if (!result) return;
      if (clipboard.cut && nasClipboard === clipboard) {
        if (result.moved === result.total) nasClipboard = undefined;
        else if (result.moved > 0) {
          // Retain only unmoved paths for retry; never delete local clipboard data on cancellation.
          try {
            const remaining = new Set((await api.list(clipboard.folder)).map(file => file.path));
            clipboard.paths = clipboard.paths.filter(path => remaining.has(path));
            if (!clipboard.paths.length) nasClipboard = undefined;
          } catch { /* Keep the selection if the source cannot be checked. */ }
        }
      }
      return { failed: result.moved !== result.total,
        message: result.moved + (clipboard.cut ? '개 이동 · ' : '개 복사 · ') + folder };
    }, undefined, direction).then(async result => {
      updateSelection();
      if (result && browserMode === 'remote' && browserPath === folder) await loadFolder(folder);
    });
  }
});

const nasDragType = 'application/x-sonac-nas-entries';
const nasDropZone = $('browser').querySelector('.explorer-content');
let nasDrag;
let nasDropTarget;

function draggingLocalFiles(event) {
  return event.dataTransfer?.types.includes('Files');
}

function clearNasDropTarget() {
  nasDropTarget?.classList.remove('file-drop-target');
  nasDropTarget = undefined;
}

function canDropOnNas() {
  return !$('browser').hidden && browserMode === 'remote' && !!state.settings.remoteWrites && !transferring && !loadingFolder;
}

nasDropZone.addEventListener('dragstart', event => {
  const item = event.target.closest('[data-file-path]');
  if (!item || !canDropOnNas() || browserPath === '/') return event.preventDefault();
  const paths = selected.has(item.dataset.filePath) ? selectedFiles().map(file => file.path) : [item.dataset.filePath];
  nasDrag = { folder: browserPath, paths };
  event.dataTransfer.setData(nasDragType, 'move');
  event.dataTransfer.effectAllowed = 'move';
});

function nasDropDestination(event, local) {
  const folder = event.target.closest('[data-drop-folder]');
  if (folder) {
    const path = folder.dataset.dropFolder;
    if (local || !nasDrag.paths.some(source => path === source || path.startsWith(source + '/'))) {
      return { path, element: folder };
    }
    return;
  }
  if (local && browserPath !== '/') return { path: browserPath, element: $('browser-results') };
}

nasDropZone.addEventListener('dragover', event => {
  const local = draggingLocalFiles(event);
  const moving = nasDrag && event.dataTransfer.types.includes(nasDragType);
  if (!local && !moving) return;
  event.preventDefault();
  const target = canDropOnNas() && nasDropDestination(event, local);
  event.dataTransfer.dropEffect = target ? (local ? 'copy' : 'move') : 'none';
  if (target?.element === nasDropTarget) return;
  clearNasDropTarget();
  if (target) {
    nasDropTarget = target.element;
    nasDropTarget.classList.add('file-drop-target');
  }
});
nasDropZone.addEventListener('dragleave', event => {
  if (!nasDropZone.contains(event.relatedTarget)) clearNasDropTarget();
});
document.addEventListener('dragend', () => {
  nasDrag = undefined;
  clearNasDropTarget();
});
nasDropZone.addEventListener('drop', event => {
  const local = draggingLocalFiles(event);
  const moving = nasDrag && event.dataTransfer.types.includes(nasDragType);
  if (!local && !moving) return;
  event.preventDefault();
  clearNasDropTarget();
  if (!canDropOnNas()) return;
  const target = nasDropDestination(event, local);
  if (!target) return;
  if (local) {
    uploadNasFiles(target.path, Array.from(event.dataTransfer.files));
    return;
  }
  const { folder, paths } = nasDrag;
  nasDrag = undefined;
  void transfer(async () => {
    const result = await api.moveNas(folder, paths, target.path);
    if (!result) return;
    const failed = result.total - result.moved;
    return { failed: failed > 0, message: result.moved + '개 이동' +
      (failed ? ' · ' + failed + '개는 원래 폴더에 남았습니다.' : ' · ' + target.path) };
  }, undefined, 'move').then(async result => {
    if (result && browserMode === 'remote' && browserPath === folder) await loadFolder(folder);
  });
});
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, event => {
    if (draggingLocalFiles(event)) event.preventDefault();
    if (type === 'drop') {
      clearNasDropTarget();
      $('ai-form').classList.remove('file-drop-target');
    }
  });
}

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

const fileTransferBar = $('file-transfer-bar');
const fileNotice = nowNotice(fileTransferBar, $('transfer-failure-panel'), $('transfer-expand'));
let fileTransferTimer;
let fileTransferDirection;
let fileTransferItems = new Map();
let fileTransferRetry;
let uploadRetry;
const transferScroll = { activeKey: null, pausedUntil: 0, timer: null, frame: null, automaticUntil: 0, dragging: false };
const transferScrollPanel = $('transfer-failure-panel');
transferScrollPanel.tabIndex = 0;
function followTransferActive() {
  transferScroll.frame = null;
  if (!transferring || fileTransferDirection !== 'upload' ||
      $('transfer-expand').getAttribute('aria-expanded') !== 'true' || performance.now() < transferScroll.pausedUntil) return;
  const row = fileTransferItems.get(transferScroll.activeKey)?.element;
  if (!row?.isConnected) return;
  const panel = transferScrollPanel.getBoundingClientRect();
  const item = row.getBoundingClientRect();
  const padding = 12;
  let top;
  if (item.top < panel.top + padding) top = transferScrollPanel.scrollTop + item.top - panel.top - padding;
  else if (item.bottom > panel.bottom - padding) top = transferScrollPanel.scrollTop + item.bottom - panel.bottom + padding;
  if (top === undefined) return;
  transferScroll.automaticUntil = performance.now() + 2000;
  transferScrollPanel.scrollTo({ top: Math.max(0, top), behavior: reducedMotion.matches ? 'instant' : 'smooth' });
}
function queueTransferFollow() {
  if (!transferScroll.frame) transferScroll.frame = requestAnimationFrame(followTransferActive);
}
function pauseTransferFollow() {
  if (!transferring || fileTransferDirection !== 'upload') return;
  transferScroll.pausedUntil = performance.now() + 10000;
  clearTimeout(transferScroll.timer);
  transferScroll.timer = setTimeout(() => {
    if (transferScroll.dragging) return pauseTransferFollow();
    transferScroll.pausedUntil = 0;
    queueTransferFollow();
  }, 10000);
}
transferScrollPanel.addEventListener('wheel', pauseTransferFollow, { passive: true });
transferScrollPanel.addEventListener('touchmove', pauseTransferFollow, { passive: true });
transferScrollPanel.addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  transferScroll.dragging = true;
  pauseTransferFollow();
});
for (const name of ['pointerup', 'pointercancel']) document.addEventListener(name, () => {
  if (transferScroll.dragging) pauseTransferFollow();
  transferScroll.dragging = false;
});
transferScrollPanel.addEventListener('scroll', () => {
  if (transferScroll.dragging || performance.now() >= transferScroll.automaticUntil) pauseTransferFollow();
}, { passive: true });
transferScrollPanel.addEventListener('keydown', event => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !event.target.closest('button')) pauseTransferFollow();
});
$('transfer-expand').addEventListener('click', queueTransferFollow);
new ResizeObserver(queueTransferFollow).observe(transferScrollPanel);


const transferLabels = {
  upload: { title: '파일 업로드', glyph: 'up' },
  download: { title: '파일 다운로드', glyph: 'downloads' },
  extract: { title: 'ZIP 압축 풀기', glyph: 'extract' },
  move: { title: 'NAS 항목 이동', glyph: 'files' },
  copy: { title: '파일 복사', glyph: 'copy' },
  delete: { title: '파일 삭제', glyph: 'trash' },
  files: { title: '파일 스테이션', glyph: 'files' }
};

function beginFileNotice() {
  clearTimeout(transferScroll.timer);
  cancelAnimationFrame(transferScroll.frame);
  Object.assign(transferScroll, { activeKey: null, pausedUntil: 0, frame: null, automaticUntil: 0, dragging: false });
  transferScroll.automaticUntil = performance.now() + 2000;
  transferScrollPanel.scrollTop = 0;
  clearTimeout(fileTransferTimer);
  fileTransferItems = new Map();
  fileTransferDirection = undefined;
  fileTransferRetry = undefined;
  $('transfer-file-list').replaceChildren();
  $('transfer-failures').hidden = true;
  $('transfer-retry').hidden = true;
  fileNotice.collapse();
}

function showFileTransfer(direction, title, detail, result = '') {
  clearTimeout(fileTransferTimer);
  fileTransferDirection = direction;
  fileTransferBar.dataset.result = result;
  setNoticeIcon($('transfer-mark'), result === 'success' ? 'check' : result === 'error' ? 'activity' : transferLabels[direction].glyph);
  $('transfer-title').textContent = title;
  setNoticeLabel($('transfer-name'), result ? detail : detail || title);
  $('transfer-name').title = detail || title;
  fileNotice.show();
}

function drawTransferItems() {
  const list = $('transfer-file-list');
  for (const item of fileTransferItems.values()) {
    if (!item.element) {
      item.element = make('div', '', 'now-file');
      const line = make('div', '', 'now-detail-line');
      item.nameElement = make('strong');
      item.progressLabel = make('span');
      line.append(item.nameElement, item.progressLabel);
      item.meter = make('div', '', 'update-progress');
      item.meter.setAttribute('role', 'progressbar');
      item.meter.setAttribute('aria-valuemin', '0');
      item.meter.setAttribute('aria-valuemax', '100');
      item.meter.append(make('span'));
      item.note = make('p', '', 'now-detail-note');
      item.element.append(line, item.meter, item.note);
      list.append(item.element);
    }
    const status = item.status || 'transferring';
    const value = ['done', 'skipped'].includes(status) ? 100 :
      Number.isFinite(item.total) && item.total > 0 ? Math.min(100, Math.round(item.bytes / item.total * 100)) : null;
    item.element.dataset.status = status;
    item.nameElement.textContent = item.name;
    item.nameElement.title = item.name;
    item.meter.setAttribute('aria-label', item.name + ' 전송 진행률');
    if (value === null) item.meter.removeAttribute('aria-valuenow');
    else item.meter.setAttribute('aria-valuenow', value);
    item.meter.style.setProperty('--progress', (value ?? 0) + '%');
    item.progressLabel.textContent = status === 'done' ? '완료' : status === 'skipped' ? '건너뜀' :
      status === 'error' ? '실패' : status === 'queued' ? '대기' : (value === null ? bytes(item.bytes || 0) : value + '%');
    item.note.textContent = item.error || (status === 'transferring' && ['upload', 'download'].includes(fileTransferDirection)
      ? transferTimeRemaining(item) + (Number.isFinite(item.total) ? ' · ' + bytes(item.total) : '') :
      Number.isFinite(item.total) ? bytes(item.total) : '');
  }
  fileNotice.fit();
  queueTransferFollow();
}

function hideFileTransfer() {
  clearTimeout(fileTransferTimer);
  fileNotice.hide();
}

function finishFileTransfer(direction, message, failed, details) {
  clearTimeout(transferScroll.timer);
  if (!transferring || fileTransferDirection && fileTransferDirection !== direction) beginFileNotice();
  showFileTransfer(direction, transferLabels[direction].title + (failed ? ' 실패' : ' 완료'), message, failed ? 'error' : 'success');
  fileTransferBar.style.setProperty('--notice-progress', 100);
  $('transfer-details').textContent = '';
  for (const item of fileTransferItems.values()) {
    if (item.status === 'transferring' || item.status === 'queued') item.status = failed ? 'error' : 'done';
  }
  drawTransferItems();
  const failures = Array.isArray(details) && details.length ? details.join('\n\n') : failed ? message : '';
  $('transfer-failures').textContent = failures;
  $('transfer-failures').hidden = !failures;
  fileTransferRetry = failed && direction === 'upload' ? uploadRetry : undefined;
  $('transfer-retry').hidden = !fileTransferRetry;
  if (!fileTransferItems.size && !failures) {
    $('transfer-failures').textContent = message;
    $('transfer-failures').hidden = false;
  }
  fileNotice.fit();
  if (!failed) fileTransferTimer = setTimeout(hideFileTransfer, 3000);
}

$('transfer-retry').addEventListener('click', () => {
  if (transferring || !fileTransferRetry) return;
  const retry = fileTransferRetry;
  fileTransferRetry = undefined;
  retry();
});
$('transfer-close').addEventListener('click', hideFileTransfer);
for (const [element, controller] of [[fileTransferBar, fileNotice], [updateNowBar, updateNotice]]) {
  document.addEventListener('click', event => {
    if (!element.contains(event.target)) controller.collapse();
  });
  element.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    controller.collapse();
  });
}

function transferTimeRemaining(info) {
  if (Number.isFinite(info.total) && info.bytes >= info.total) return '전송 확인 중…';
  if (!Number.isFinite(info.total) || !Number.isFinite(info.rate) || info.rate <= 0 || info.elapsed < 1) {
    return '남은 시간 계산 중…';
  }
  const seconds = Math.max(1, Math.ceil((info.total - info.bytes) / info.rate));
  if (seconds < 60) return '이 파일 약 ' + seconds + '초 남음';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return '이 파일 약 ' + minutes + '분 남음';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return '이 파일 약 ' + hours + '시간' + (remainder ? ' ' + remainder + '분' : '') + ' 남음';
}

api.onTransfer(info => {
  if (!transferring) return;
  if (info.items) {
    for (const [index, item] of info.items.entries()) {
      const key = 'batch-' + index;
      if (!fileTransferItems.has(key)) fileTransferItems.set(key, { name: item.name, total: item.size, bytes: 0, status: 'queued' });
    }
  }
  const key = Number.isInteger(info.index) ? 'batch-' + info.index : info.name;
  const item = fileTransferItems.get(key) || {};
  Object.assign(item, info, { status: info.status || 'transferring' });
  fileTransferItems.set(key, item);
  transferScroll.activeKey = key;
  const count = fileTransferItems.size;
  const title = transferLabels[info.direction].title + ' 진행 중';
  showFileTransfer(info.direction, title, count > 1 ? '파일 ' + count + '개 ' + title.replace(/^파일 /u, '') : info.name);
  const items = [...fileTransferItems.values()];
  const known = items.every(file => Number.isFinite(file.total) && file.total >= 0);
  const total = known ? items.reduce((sum, file) => sum + file.total, 0) : null;
  const completed = items.reduce((sum, file) => sum + (['done', 'skipped'].includes(file.status) ? file.total || 0 : file.bytes || 0), 0);
  const percent = total === null ? null : total === 0 ? 100 : Math.min(100, Math.round(completed / total * 100));
  fileTransferBar.style.setProperty('--notice-progress', percent ?? 0);
  $('transfer-details').textContent = percent === null ? '' : percent + '%';
  drawTransferItems();
});


drawTiles();
const [serverId, serverLabel, serverGlyph] = serverTile;
$('signin-services').append(tile(serverLabel, serverId, () => activate(serverId), serverGlyph));
initWorkspace();
api.onState(apply);
api.state().then(apply).catch(error => {
  if (state) return;
  $('signin-loading').hidden = true;
  $('login-form').inert = false;
  $('login-button').disabled = true;
  notice('login-error', error.message);
});
