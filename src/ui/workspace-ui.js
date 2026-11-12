'use strict';

let githubOpen = false;
let githubRepos = [];
let githubCommits = new Map();
let githubRequest = 0;
let areaEditing = null;
let areaSignature = '';
const areaSources = { nas: 'NAS / 저장소', link: 'HTTPS 링크', github: 'GitHub' };

function drawAreas() {
  const { settings, runningAreas, sync } = state;
  const base = settings.remote && settings.local ? {
    id: 'base', source: 'nas', name: '기본 동기화', remote: settings.remote, local: settings.local,
    automatic: settings.automatic, last: settings.last, running: sync?.running || sync?.checking
  } : null;
  const areas = base ? [base, ...settings.areas] : settings.areas;
  const signature = JSON.stringify([areas, runningAreas]);
  if (areaSignature === signature) return;
  areaSignature = signature;
  const list = $('area-list');
  const expanded = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.area));
  notice('areas-empty', areas.length ? '' : 'NAS 폴더, HTTPS 파일 또는 GitHub 저장소를 연결하세요.');
  list.replaceChildren(...areas.map(area => {
    const running = area.running || runningAreas.includes(area.id);
    const card = make('article', '', 'work-card');
    const header = make('header', '', 'work-row');
    const label = make('div');
    const source = area.remote || area.repository || area.filename;
    const branch = area.branch ? ' · ' + area.branch : '';
    label.append(make('h3', area.name), make('p', areaSources[area.source] + ' · ' + source + branch, 'work-meta'));
    const actions = make('div', '', 'work-actions');
    const mode = make('span', area.automatic ? '자동' : '수동', 'work-meta');
    const run = button(area.source === 'github' ? '최신 파일 적용' : '지금 동기화', async () => {
      try {
        if (area.id === 'base') await api.sync();
        else await api.areaRun(area.id);
      } catch (error) {
        toast(error.message);
      }
    });
    const edit = button('설정', () => area.id === 'base' ? openSettings() : openArea(area));
    run.disabled = edit.disabled = running;
    actions.append(mode, run, edit);
    header.append(label, actions);
    const last = area.last;
    const status = running ? '동기화 중…' : last?.errors ? last.message :
      last?.pending ? '업데이트 있음' : last?.checkedAt ? '마지막 확인 ' + shortDate.format(last.checkedAt) : '동기화 기록 없음';
    const detail = make('p', status, 'work-meta');
    if (last?.errors && !running) detail.classList.add('work-error');
    if (last?.commit) detail.append(' · ' + last.commit.sha.slice(0, 7) + ' ' + last.commit.message);
    card.append(header, detail);
    if (last?.files?.length) {
      const files = make('details', '', 'work-files');
      files.dataset.area = area.id;
      files.open = expanded.has(area.id) || area.id === 'base' && !list.querySelector('[data-area="base"]');
      const total = last.fileCount ?? last.files.length;
      files.append(make('summary', '동기화된 파일 ' + total + '개'));
      const names = make('ul');
      names.append(...last.files.map(file => make('li', file)));
      if (last.files.length < total) names.append(make('li', '외 ' + (total - last.files.length) + '개', 'work-meta'));
      files.append(names);
      card.append(files);
    }
    return card;
  }));
}

function repoOptions(select, rows, current = '') {
  select.replaceChildren(new Option('저장소 선택', ''), ...rows.map(repo =>
    new Option(repo.name + (repo.private ? ' · 비공개' : ''), repo.name)));
  if (current && !rows.some(repo => repo.name === current)) select.add(new Option(current, current));
  select.value = current;
}

function drawGithub() {
  const account = state.github;
  $('github-connect').hidden = !!account;
  $('github-projects').hidden = !account;
  $('github-refresh').hidden = $('github-disconnect').hidden = !account;
  $('github-shortcut').hidden = !state.settings.layout.links.github;
  $('github-identity').textContent = account ? '@' + account.login : '';
  if (!account) return;
  const tracked = account.tracked;
  const select = elements('github-track').repository;
  const available = githubRepos.filter(repo => !tracked.includes(repo.name));
  repoOptions(select, available, available.some(repo => repo.name === select.value) ? select.value : '');
  $('github-empty').hidden = tracked.length > 0;
  $('github-list').replaceChildren(...tracked.map(repository => {
    const card = make('article', '', 'work-card');
    const header = make('header', '', 'work-row');
    const actions = make('div', '', 'work-actions');
    actions.append(button('동기화 영역 만들기', () => openArea(null, repository)),
      button('목록에서 제거', async () => {
        try { await api.githubTrack(repository, false); } catch (error) { notice('github-status', error.message, true); }
      }));
    header.append(make('h3', repository), actions);
    const entry = githubCommits.get(repository);
    card.append(header);
    if (entry?.commit) {
      const { sha, message, author, date } = entry.commit;
      const repo = githubRepos.find(item => item.name === repository);
      const timestamp = Date.parse(date);
      card.append(make('p', message, 'commit-message'),
        make('p', [repo?.branch, sha.slice(0, 7), author, Number.isFinite(timestamp) ? shortDate.format(timestamp) : '']
          .filter(Boolean).join(' · '), 'work-meta'));
    } else {
      card.append(make('p', entry?.error || '최신 커밋 확인 중…', entry?.error ? 'work-meta work-error' : 'work-meta'));
    }
    return card;
  }));
}

async function refreshGithub() {
  const account = state.github;
  if (!account) return;
  const request = ++githubRequest;
  notice('github-status', '저장소와 최신 커밋을 확인하는 중…');
  const repos = api.githubRepos();
  const commits = Promise.all(account.tracked.map(async repository => {
    try { return [repository, { commit: await api.githubCommit(repository) }]; }
    catch (error) { return [repository, { error: error.message }]; }
  }));
  const [listed, checked] = await Promise.allSettled([repos, commits]);
  if (request !== githubRequest || !githubOpen || state.github?.login !== account.login) return;
  if (listed.status === 'fulfilled') githubRepos = listed.value;
  if (checked.status === 'fulfilled') githubCommits = new Map(checked.value);
  drawGithub();
  notice('github-status', listed.status === 'rejected' ? listed.reason.message : '', true);
}

function openGithub() {
  githubOpen = true;
  showPage();
  drawGithub();
  notice('github-status');
  $('github-title').focus();
  void refreshGithub();
}

function workspaceChanged(previous) {
  if (!state.connected) {
    githubOpen = false;
    githubRequest++;
    githubRepos = [];
    githubCommits.clear();
    return;
  }
  drawAreas();
  if (githubOpen && JSON.stringify(previous?.github) !== JSON.stringify(state.github)) {
    if (previous?.github?.login !== state.github?.login) {
      githubRepos = [];
      githubCommits.clear();
    }
    drawGithub();
    if (state.github) void refreshGithub();
    else notice('github-status');
  }
}

function areaSourceChanged() {
  const form = elements('area-form');
  for (const source of Object.keys(areaSources)) $('area-' + source).hidden = source !== form.source.value;
  const githubSource = form.source.value === 'github';
  $('area-auto').hidden = githubSource;
  form.url.required = form.filename.required = form.source.value === 'link';
  form.url.disabled = form.filename.disabled = form.source.value !== 'link';
  form.repository.required = githubSource;
  if (githubSource && !state.github) notice('area-error', '먼저 GitHub 타일에서 계정을 연결하세요.', true);
  else notice('area-error');
}

function openArea(area = null, repository = '') {
  areaEditing = area;
  const form = elements('area-form');
  $('area-form').reset();
  $('area-title').textContent = area ? '동기화 영역 설정' : '동기화 영역 추가';
  $('area-remove').hidden = !area;
  form.name.value = area?.name || repository.split('/').at(-1);
  form.source.value = area?.source || (repository ? 'github' : 'nas');
  for (const field of ['remote', 'local', 'url', 'filename', 'branch']) form[field].value = area?.[field] || '';
  form.automatic.checked = !!area?.automatic;
  repoOptions(form.repository, githubRepos, area?.repository || repository);
  areaSourceChanged();
  $('area-dialog').showModal();
  if (!state.github) return;
  const login = state.github.login;
  void api.githubRepos().then(rows => {
    if (!$('area-dialog').open || areaEditing !== area || state.github?.login !== login) return;
    githubRepos = rows;
    repoOptions(form.repository, rows, form.repository.value);
  }).catch(error => {
    if ($('area-dialog').open && areaEditing === area && form.source.value === 'github') notice('area-error', error.message, true);
  });
}

function initWorkspace() {
  const reportGithub = error => notice('github-status', error.message, true);
  const reportArea = error => notice('area-error', error.message, true);
  $('github-home').addEventListener('click', () => {
    githubOpen = false;
    githubRequest++;
    showPage();
    document.querySelector('.tile .github')?.parentElement.focus();
  });
  $('github-shortcut').addEventListener('click', () => void api.openLink(state.settings.layout.links.github).catch(reportGithub));
  $('github-token-help').addEventListener('click', () => {
    void api.openLink('https://github.com/settings/personal-access-tokens/new?name=sonac%20launcher&contents=read&metadata=read').catch(reportGithub);
  });
  $('github-refresh').addEventListener('click', busy($('github-refresh'), refreshGithub, reportGithub));
  $('github-disconnect').addEventListener('click', busy($('github-disconnect'), () => api.githubDisconnect(), reportGithub));
  $('github-connect').addEventListener('submit', event => {
    event.preventDefault();
    const form = elements('github-connect');
    void busy(event.submitter, async () => {
      await api.githubConnect(form.token.value);
      form.token.value = '';
    }, reportGithub)();
  });
  $('github-track').addEventListener('submit', event => {
    event.preventDefault();
    void busy(event.submitter, () => api.githubTrack(elements('github-track').repository.value, true), reportGithub)();
  });
  $('area-add').addEventListener('click', () => openArea());
  const form = elements('area-form');
  form.source.addEventListener('change', areaSourceChanged);
  form.url.addEventListener('change', () => {
    if (form.filename.value) return;
    try { form.filename.value = decodeURIComponent(new URL(form.url.value).pathname.split('/').at(-1)); } catch { /* enter a file name manually */ }
  });
  $('area-pick-remote').addEventListener('click', () => openBrowser('picker', form.remote.value || '/', 'area-dialog'));
  $('area-pick-local').addEventListener('click', busy($('area-pick-local'), async () => {
    const local = await api.areaFolder();
    if (local) form.local.value = local;
  }, reportArea));
  $('area-form').addEventListener('submit', event => {
    event.preventDefault();
    void busy(event.submitter, async () => {
      const value = Object.fromEntries([...form].filter(field => field.name).map(field => [field.name, field.value]));
      await api.areaSave({ ...value, id: areaEditing?.id, automatic: form.automatic.checked });
      $('area-dialog').close();
    }, reportArea)();
  });
  $('area-remove').addEventListener('click', busy($('area-remove'), async () => {
    if (!window.confirm('동기화 영역을 삭제할까요? 이 PC에 저장된 파일은 유지됩니다.')) return;
    await api.areaRemove(areaEditing.id);
    $('area-dialog').close();
  }, reportArea));
}
