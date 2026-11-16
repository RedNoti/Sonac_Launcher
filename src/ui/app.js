'use strict';

const api = window.launcher;
const $ = id => document.getElementById(id);
const elements = (id) => $(id).elements;
const serverTile = ['server-update', '서버 업데이터', 'sync'];
const groups = [
  { id: 'synology', title: 'SYNOLOGY', tiles: [['dsm', '파일 스테이션']] },
  { id: 'files', title: '파일 관리', tiles: [['downloads', '다운로드'], ['sync', '백업 · 동기화']] },
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
let settingsOpen = false;
let settingsTrigger;
let settingsSection = 'account';
const settingsSections = $('settings-nav').querySelectorAll('[data-settings-section]');
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
  if (focus) (configuring ? form.name : form.password).focus();
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
  const intro = !server && loginMode === 'register' ? '연결 이름과 DSM 주소를 등록하세요.' : '';
  notice('signin-intro', intro);
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
  const showAi = state.connected && servicePage === 'ai';
  const showSettings = settingsOpen && !choosing && !browserMode;
  const setup = $('usage-setup');
  if (!choosing) setup.hidden = true;
  else if (setup.hidden) {
    setup.hidden = false;
    drawUsage();
    setup.querySelectorAll('.usage-step h1')[usageStep].focus();
  }
  const signin = $('signin');
  signin.dataset.serverOnly = String(state.usageMode === 'server');
  signin.hidden = choosing || showSettings || !!(state.connected || showServer || showAi);
  $('nas-selection-title').hidden = state.usageMode === 'server';
  $('nas-profiles').hidden = choosing && usageStep === 2 ? usageConnection === 'server' : state.usageMode === 'server';
  $('signin-services').hidden = state.usageMode === 'nas';
  $('server-home').hidden = choosing || showSettings || !showServer;
  $('settings-page').hidden = !showSettings;
  if (showSettings) drawSettings();
  $('ai-home').hidden = choosing || !showAi;
  if ($('ai-home').hidden) $('ai-usage').open = false;
  drawSigninLoading();
  drawConnectionForm();
  $('signin-version').hidden = !state.versionLabel || ($('signin').hidden && api.browserPreview !== true);
  const home = $('home');
  const hideHome = choosing || showSettings || !state.connected || !!showServer || !!showAi || !!browserMode || githubOpen || state.terminalOpen;
  if (home.hidden && !hideHome) home.style.setProperty('--tile-page-delay', pageTransition ? '260ms' : '0ms');
  home.hidden = hideHome;
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
  new: '배포 전', downloading: '다운로드 중', extracting: '압축 해제 중', starting: '시작 중',
  running: '실행 중', stopping: '정지 중', stopped: '정지됨', failed: '실행 실패'
};
let deployProject;
let logProject;
let logTimer;

function setServerMonitoringView(open) {
  $('server-monitor-toggle').setAttribute('aria-pressed', String(open));
  $('server-monitoring').hidden = !open;
  $('server-files').hidden = open;
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

async function refreshServerLogs(file) {
  if (file !== logProject || !$('server-log-dialog').open) return;
  const output = $('server-log-output');
  const log = await api.serverLogs(file.id).catch(error => error.message);
  if (file !== logProject || !$('server-log-dialog').open) return;
  const text = log || '아직 기록된 로그가 없습니다.';
  if (output.textContent !== text) {
    const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 35;
    output.textContent = text;
    if (follow) output.scrollTop = output.scrollHeight;
  }
  logTimer = setTimeout(() => void refreshServerLogs(file), 750);
}

function showServerLogs(file) {
  logProject = file;
  $('server-log-title').textContent = file.name + ' 로그';
  $('server-log-output').textContent = '';
  $('server-log-dialog').showModal();
  void refreshServerLogs(file);
}

function serverStatus(label, tone) {
  const status = make('span', '', 'server-state');
  status.dataset.tone = tone;
  status.append(make('span', '', 'dot'), make('span', label));
  return status;
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
      setServerMonitoringView(false);
      $('server-file-form').reset();
      $('server-file-list').replaceChildren();
      $('server-home-account').textContent = '';
      notice('server-home-error');
    }
    return;
  }
  $('server-home-account').textContent = account.email;
  if (JSON.stringify(account.files) === JSON.stringify(previous?.files)) return;
  const report = error => notice('server-home-error', error.message, true);
  $('server-file-list').replaceChildren(...account.files.map(file => {
    const card = make('article', '', 'server-project-card');
    const row = make('div', '', 'work-row');
    const identity = make('div', '', 'server-project-identity');
    identity.append(icon('dsm', '#a9c6f8'), make('h3', file.name));
    const phase = file.phase ?? 'new';
    const pending = ['downloading', 'extracting', 'starting', 'stopping'].includes(phase);
    const tone = phase === 'running' ? 'good' : phase === 'failed' ? 'bad' : pending ? 'warn' : 'idle';
    identity.append(serverStatus(deploymentLabels[phase], tone));
    row.append(identity);
    if (file.installed) row.append(make('span', file.installed, 'work-meta server-release-tag'));
    const actions = make('div', '', 'work-actions');
    const command = (label, action, disabled = false, style) => {
      const control = make('button', label, style);
      control.type = 'button';
      control.disabled = disabled;
      control.addEventListener('click', busy(control, async () => {
        notice('server-home-error');
        await action();
      }, report));
      return control;
    };
    const deploy = command(file.installed ? '다시 배포' : '배포', () => showDeployment(file), pending, 'primary');
    const toggle = phase === 'running' ? command('정지', () => api.serverStop(file.id))
      : command('실행', () => api.serverRun(file.id), pending);
    actions.append(deploy);
    if (file.installed || phase === 'running') actions.append(toggle);
    actions.append(
      button('로그', () => showServerLogs(file)),
      command('배포 폴더', () => api.serverDeploymentFolder(file.id), !file.installed || pending),
      command('설정 폴더', () => api.serverDataFolder(file.id)),
      button('GitHub에서 열기', () => void api.serverFileOpen(file.id).catch(report)),
      command('연결 해제', () => api.serverFileRemove(file.id), pending || phase === 'running')
    );
    card.append(row, make('p', file.url, 'work-meta'), actions);
    return card;
  }));
}

function drawServerMonitoring(monitoring, previous) {
  $('server-monitor-toggle').hidden = !monitoring;
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
  if (!previous || monitoring.enabled !== previous.enabled || monitoring.time !== previous.time ||
      monitoring.hasWebhook !== previous.hasWebhook) {
    form.enabled.checked = monitoring.enabled;
    form.time.value = monitoring.time;
    form.removeWebhook.checked = false;
    form.webhook.placeholder = monitoring.hasWebhook ? '저장됨 · 바꾸려면 새 주소 입력' : '선택 사항';
    $('server-monitor-remove-webhook').hidden = !monitoring.hasWebhook;
  }
  if (JSON.stringify(monitoring.targets) !== JSON.stringify(previous?.targets)) {
    const labels = { healthy: '정상', degraded: '경고', down: '장애' };
    $('server-monitor-targets').replaceChildren(...monitoring.targets.map(target => {
      const row = make('article', '', 'server-monitor-card');
      const header = make('div', '', 'work-row');
      const name = make('div', '', 'server-project-identity');
      name.append(icon('dsm', '#a9c6f8'), make('h3', target.name));
      const action = make('button', '', 'server-icon-button');
      action.type = 'button';
      action.setAttribute('aria-label', target.name + ' 제거');
      action.title = '제거';
      action.append(icon('trash', '#a9c6f8'));
      action.addEventListener('click', busy(action, async () => apply(await api.serverMonitorTarget(target.id, true)),
        error => notice('server-monitor-error', error.message, true)));
      header.append(name, action);
      const { status, latencyMs, at } = target.latest ?? {};
      const description = status ? [latencyMs === undefined ? '' : latencyMs + 'ms', shortDate.format(at)].filter(Boolean).join(' · ') : '';
      const tone = { healthy: 'good', degraded: 'warn', down: 'bad' };
      row.append(header, make('p', target.url, 'work-meta'),
        serverStatus(labels[status] ?? '확인 대기', tone[status] ?? 'idle'));
      if (description) row.append(make('p', description, 'work-meta'));
      return row;
    }));
  }
  if (monitoring.error !== previous?.error) notice('server-monitor-error', monitoring.error, true);
  const report = monitoring.latestReport;
  $('server-monitor-report').hidden = !report;
  if (!report) return;
  $('server-monitor-report-title').textContent = report.title;
  const delivery = { local: '런처에 저장됨', sent: 'Discord 전송 완료', failed: 'Discord 전송 실패', unconfirmed: 'Discord 전송 확인 대기' };
  $('server-monitor-report-info').textContent = shortDate.format(report.at) + ' · ' + delivery[report.delivery];
  $('server-monitor-report-text').textContent = report.text;
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
  $('ai-send').disabled = wait > 0 || !!aiHistoryLoad || !activeAiChat || !elements('ai-form').message.value.trim();
  $('ai-send').hidden = pending;
  $('ai-stop').hidden = !pending;
  $('ai-stop').disabled = aiRequest?.phase === 'stopping' || aiRequest?.phase === 'saving';
  $('ai-effort').disabled = pending;
  const seconds = Math.ceil(wait / 1000);
  const duration = seconds >= 60 ? Math.ceil(seconds / 60) + '분' : seconds + '초';
  const message = visibleRequest ? aiPhaseLabels[visibleRequest.phase]
    : pending ? '다른 대화에서 답변을 받는 중…'
      : wait > 0 ? '약 ' + duration + ' 후 다시 보낼 수 있어요.' : '';
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

function drawAiChatList() {
  const list = $('ai-chat-list');
  list.replaceChildren(...aiChats.map(chat => {
    const item = button(chat.title, () => {
      activeAiChat = chat;
      notice('ai-error');
      drawAiChat(true);
      scheduleAiTitle();
    });
    item.title = chat.title;
    item.setAttribute('aria-pressed', String(chat === activeAiChat));
    return item;
  }));
}

function aiFeedAtBottom(feed) {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= 4;
}

function drawAiChat(resetScroll = false) {
  drawAiChatList();
  const feed = $('ai-messages');
  const previousScroll = feed.scrollTop;
  const follow = resetScroll || aiFeedAtBottom(feed);
  feed.replaceChildren(...(activeAiChat?.messages ?? []).map(({ role, content }) => make('p', content, 'ai-message ' + role)));
  if (aiRequest && aiRequest.chat === activeAiChat) {
    feed.append(make('p', aiRequest.answer, 'ai-message assistant ai-streaming'));
  }
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
const updateDownloadFace = $('update-download-face');
const updateReadyFace = $('update-ready-face');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let nowBarTimers = [];
let nowBarOpenedAt;
let pendingReadyFace;
let dismissedUpdate;
let restartingUpdate = false;

function clearNowBarTimers() {
  for (const timer of nowBarTimers) clearTimeout(timer);
  nowBarTimers = [];
  pendingReadyFace = undefined;
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
    clearNowBarTimers();
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
  if (!phase) {
    if (nowBarOpenedAt !== undefined) {
      nowBarOpenedAt = undefined;
      clearNowBarTimers();
      updateNowBar.removeAttribute('data-expanded');
      updateDownloadFace.inert = updateReadyFace.inert = true;
      nowBarTimers = [setTimeout(() => updateNowBar.removeAttribute('data-visible'), 800),
        setTimeout(() => { updateNowBar.hidden = true; }, 1300)];
    }
    if (reducedMotion.matches) {
      clearNowBarTimers();
      updateNowBar.removeAttribute('data-visible');
      updateNowBar.hidden = true;
    }
    return;
  }

  const opening = nowBarOpenedAt === undefined;
  if (opening) {
    clearNowBarTimers();
    nowBarOpenedAt = performance.now();
    updateNowBar.hidden = false;
  }
  if (reducedMotion.matches) {
    updateNowBar.dataset.visible = updateNowBar.dataset.expanded = '';
  } else if (opening) {
    nowBarTimers = [setTimeout(() => { updateNowBar.dataset.visible = ''; }, 400),
      setTimeout(() => { updateNowBar.dataset.expanded = ''; }, 1000)];
  }

  const downloading = phase === 'downloading';
  const progress = $('update-progress');
  if (downloading || !updateDownloadFace.inert) {
    notice('update-download-message', tag + ' 버전을 다운받고 있습니다');
    const value = downloading ? percent : 100;
    progress.hidden = false;
    progress.setAttribute('aria-valuenow', value);
    progress.style.setProperty('--progress', value + '%');
    $('update-percent').textContent = value + '%';
  }
  if (!downloading) {
    const message = restartingUpdate || state.restartingUpdate ? '업데이트 적용 중…' : tag + ' 업데이트가 준비되었습니다';
    if ($('update-ready-message').textContent !== message) $('update-ready-message').textContent = message;
    $('update-restart').disabled = restartingUpdate || state.applyingUpdate || state.connecting;
    if (!reducedMotion.matches && !updateDownloadFace.inert) {
      if (!pendingReadyFace) {
        const delay = Math.max(500, 2200 - (performance.now() - nowBarOpenedAt));
        pendingReadyFace = setTimeout(() => {
          updateDownloadFace.inert = true;
          updateReadyFace.inert = false;
          pendingReadyFace = undefined;
        }, delay);
        nowBarTimers.push(pendingReadyFace);
      }
      return;
    }
  }
  updateDownloadFace.inert = !downloading;
  updateReadyFace.inert = downloading;
}

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
    button.title = tag ? label : '앱 업데이트 확인';
    button.setAttribute('aria-label', button.title);
    if (id === 'account-update-check') {
      button.textContent = tag ? label : update?.phase === 'checking' ? '확인 중…' : '업데이트 확인';
      continue;
    }
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
  const accountMessage = current ? '' : downloading ? message + ' ' + percent + '%' : message;
  if ($('update-status').textContent !== accountMessage) notice('update-status', accountMessage, error);
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
    clearTimeout(aiTitleTimer);
    if (servicePage === 'ai') servicePage = undefined;
    aiChats = [];
    activeAiChat = aiRequest = aiHistoryLoad = undefined;
    $('ai-new-chat').disabled = false;
    $('ai-form').reset();
    drawAiChat();
    notice('login-error');
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
  drawServerHome(previous?.serverUpdaterAccount);
  drawAiUsage();
  if (previous?.terminalOpen && !state.terminalOpen && !$('home').hidden) {
    document.querySelector('.tile:has(.terminal)')?.focus();
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
    if (id === 'server-update') return navigate(() => {
      servicePage = 'server';
      notice('server-login-error');
      showPage();
      if (state.serverRemembered && !state.serverUpdaterAccount) {
        void api.serverUpdaterRestore().then(apply).catch(error => notice('server-login-error', error.message));
      }
      if (state.serverUpdaterAccount) $('server-home-title').focus();
      else elements('server-login-form').email.focus();
    });
    if (id === 'ai-assistant' && state.connected) return navigate(() => {
      servicePage = 'ai';
      showPage();
      if (!activeAiChat && !aiHistoryLoad) void restoreAiChats();
      else scheduleAiTitle();
      $('ai-title').focus();
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
  const { profile, settings, connected, github, serverUpdaterAccount } = state;
  $('account-device').textContent = state.device || '—';
  $('account-server').textContent = connected ? profile.url : '연결 안 됨';
  $('account-user').textContent = connected ? profile.user : '';
  $('account-github').textContent = github ? '@' + github.login : '연결 안 됨';
  $('account-server-updater').textContent = serverUpdaterAccount?.email || '로그인 안 됨';
  $('settings-version').textContent = state.versionLabel || '';
  $('settings-tray').checked = !!state.trayVisible;
  $('settings-launch').checked = !!state.launchAtLogin;
  $('account-writes').checked = !!settings?.remoteWrites;
  $('settings-auto-sync').checked = !!settings?.automatic;
  for (const id of ['settings-sync-nav', 'nas-account-row', 'github-account-row', 'nas-write-setting',
    'account-github-open', 'account-switch', 'logout-button']) $(id).hidden = !connected;
  $('settings-server-logout').hidden = !serverUpdaterAccount;
  $('usage-edit').hidden = connected;
  if (!connected && settingsSection === 'sync') settingsSection = 'account';
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
  const favorite = $('favorite-selection');
  favorite.hidden = browserMode !== 'remote';
  favorite.disabled = !folder || transferring || loadingFolder;
  const starred = !!folder && (state.settings.folderFavorites ?? []).includes(files[0].path);
  favorite.setAttribute('aria-pressed', String(starred));
  setSelectionIcon(favorite, starred ? '즐겨찾기 제거' : '즐겨찾기 추가', 'star');
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
  if (picker && pickerDialog) $(pickerDialog).showModal();
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
$('update-ready-mark').append(icon('check'));
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
    if (preparing && editingUsage && state.serverUpdaterAccount) {
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
function returnHome() {
  navigate(() => {
    const glyph = servicePage === 'ai' ? 'ai-assistant' : 'server-update';
    servicePage = undefined;
    showPage();
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
$('ai-send').append(icon('up'));
$('ai-stop').append(icon('stop'));
$('ai-stop').addEventListener('click', async () => {
  const request = aiRequest;
  if (!request) return;
  const previousPhase = request.phase;
  request.phase = 'stopping';
  drawAiRequestStatus();
  try {
    await api.aiCancel();
  } catch (error) {
    if (aiRequest !== request) return;
    request.phase = previousPhase;
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
  if (!state?.connected || aiRequest || !activeAiChat || $('ai-send').disabled) return;
  const input = event.currentTarget.elements.message;
  const content = input.value.trim();
  if (!content) return;
  const chat = activeAiChat;
  const message = { role: 'user', content };
  const request = aiRequest = { id: crypto.randomUUID(), chat, answer: '', phase: 'preparing', startedAt: performance.now() };
  chat.messages.push(message);
  if (chat.messages.length === 1) chat.title = content.replace(/\s+/gu, ' ').slice(0, 45);
  clearTimeout(aiTitleTimer);
  input.value = '';
  notice('ai-error');
  drawAiChat(true);
  try {
    const answer = await api.aiChat(request.id, chat.id, content, $('ai-effort').value);
    if (aiRequest !== request) return;
    if (answer) chat.messages.push({ role: 'assistant', content: answer });
  } catch (error) {
    if (aiRequest !== request) return;
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
$('server-monitor-toggle').append(icon('activity', '#a9c6f8'));
$('server-monitor-toggle').addEventListener('click', () => {
  setServerMonitoringView($('server-monitoring').hidden);
});
$('server-deploy-form').addEventListener('submit', event => {
  event.preventDefault();
  const project = deployProject;
  const asset = Number($('server-deploy-asset').value);
  $('server-deploy-dialog').close();
  notice('server-home-error');
  void api.serverDeploy(project, asset).catch(error => notice('server-home-error', error.message, true));
});
$('server-log-dialog').addEventListener('close', () => {
  logProject = undefined;
  clearTimeout(logTimer);
});
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
    $('server-file-add').open = false;
  }, error => notice('server-home-error', error.message, true))();
});
for (const [id, save] of [['server-monitor-target', (input) => api.serverMonitorTarget(input)],
  ['server-monitor-settings', (input, form) => api.serverMonitorSettings({ ...input,
    enabled: form.elements.enabled.checked, removeWebhook: form.elements.removeWebhook.checked })]]) {
  $(id).addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    void busy(event.submitter ?? form.querySelector('[type="submit"]'), async () => {
      notice('server-monitor-error');
      const next = await save(Object.fromEntries(new FormData(form)), form);
      if (id === 'server-monitor-target') {
        form.reset();
        $('server-monitor-add').open = false;
      }
      else {
        form.elements.webhook.value = '';
        form.elements.removeWebhook.checked = false;
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
  const glyphs = { account: 'account', launcher: 'grid', sync: 'sync' };
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
$('settings-back').addEventListener('click', () => navigate(closeSettings));
const reportSettings = error => notice('account-error', error.message, true);
for (const [id, name] of [['settings-tray', 'trayVisible'], ['settings-launch', 'launchAtLogin'],
  ['settings-auto-sync', 'automaticSync'], ['account-writes', 'remoteWrites']]) {
  const control = $(id);
  control.addEventListener('change', busy(control, async () => {
    notice('account-error');
    const next = name === 'remoteWrites' ? await api.remoteWrites(control.checked) : await api.setPreference(name, control.checked);
    apply(next);
  }, error => { drawSettings(); reportSettings(error); }));
}
for (const [id, action] of [['account-switch', () => api.switchNas()], ['logout-button', () => api.logout()],
  ['settings-server-logout', async () => {
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
    else if (settingsOpen) reportSettings(error);
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
  if (event.key !== 'Escape' || event.defaultPrevented || updateReadyFace.inert || restartingUpdate ||
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
    if (['available', 'ready'].includes(state.update?.phase)) return requestUpdate();
    try {
      const checked = await api.checkUpdate();
      if (id === 'account-update-check' && checked.update?.phase === 'current') {
        notice('update-status', '최신 버전을 사용 중입니다.');
      }
      if (id === 'signin-update-check' && !state.connected && !state.connecting &&
          checked.update?.phase === 'current' && state.update?.phase === 'current') {
        showSigninCurrent();
      }
    } catch (error) {
      if (id === 'signin-update-check' && !$('signin-service-status').hidden && !$('signin').hidden) toast(error.message);
      else notice(id === 'signin-update-check' ? (servicePage === 'server' ? 'server-login-error' : 'login-error') : 'account-error', error.message, true);
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
  const [folder] = selectedFiles();
  if (browserMode !== 'remote' || selected.size !== 1 || !folder?.directory) return;
  const enabled = !(state.settings.folderFavorites ?? []).includes(folder.path);
  void api.folderFavorite(folder.path, enabled).catch(error => toast(error.message));
});
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
    navigate(leaveBrowser);
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
$('up-button').addEventListener('click', () => navigateFolder(parentOf(browserPath)));
$('refresh-button').addEventListener('click', () => loadFolder(browserPath));
$('pick-button').addEventListener('click', () => navigate(() => {
  elements(pickerDialog === 'area-dialog' ? 'area-form' : 'settings-form').remote.value = browserPath;
  leaveBrowser();
}));
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
