'use strict';

let githubOpen = false;
let githubRepos = [];
let githubCommits = new Map();
let githubRequest = 0;
let areaEditing = null;
let areaSignature = '';
let syncAreas = [];
let areaGroups = [];
let areaFolderId = null;
let areaGroupId = null;
let groupEditing = null;
let groupRepository = '';
let returnToAreaGroup = null;
let areaFormRequest = 0;
const areaSources = { nas: 'NAS / 저장소', github: 'GitHub' };

function drawAreas() {
  const { settings, runningAreas, sync } = state;
  const base = settings.remote && settings.local ? {
    id: 'base', source: 'nas', name: '기본 동기화', remote: settings.remote, local: settings.local,
    automatic: settings.automatic, last: settings.last,
    running: !!(sync?.running || sync?.checking)
  } : null;
  const areas = settings.areas.filter(area => Object.hasOwn(areaSources, area.source))
    .map(area => ({ ...area, running: runningAreas.includes(area.id) }));
  if (base) areas.unshift(base);
  const signature = JSON.stringify([settings.syncGroups, areas]);
  if (areaSignature === signature) return;
  areaSignature = signature;
  syncAreas = areas;
  areaGroups = settings.syncGroups.map(group => ({ ...group, items: areas.filter(area => area.groupId === group.id) }));
  $('areas-empty').hidden = !!base || areaGroups.length > 0;
  const focused = document.activeElement.dataset.areaId;
  const tiles = areaGroups.map(drawGroupTile);
  if (base) tiles.unshift(drawAreaTile(base));
  $('area-list').replaceChildren(...tiles);
  if ($('area-group').open) {
    const group = areaGroups.find(item => item.id === areaGroupId);
    if (group) drawAreaGroup(group);
    else $('area-group').close();
  }
  if (focused) areaTile(focused)?.focus();
  if ($('area-folder').open) {
    const area = areas.find(item => item.id === areaFolderId);
    if (area) drawAreaFolder(area);
    else $('area-folder').close();
  }
}

function areaTile(id) {
  const list = $('area-group').open ? $('area-group-list') : $('area-list');
  return [...list.children].find(item => item.dataset.areaId === id);
}

function areaFolderIcon(file) {
  return file ? fileIcon({ name: file.split('/').at(-1) }) : 'files';
}

function fillFolderPreview(item, glyphs, total) {
  const preview = make('span', '', 'folder-preview');
  preview.setAttribute('aria-hidden', 'true');
  for (const glyph of glyphs.slice(0, total > 4 ? 3 : 4)) {
    const cell = make('span');
    cell.append(icon(glyph));
    preview.append(cell);
  }
  if (total > preview.childElementCount) preview.append(make('span', '+' + (total - preview.childElementCount)));
  item.firstElementChild.replaceChildren(preview);
}

function drawAreaTile(area) {
  const files = area.last?.files || [];
  const total = area.last?.fileCount ?? files.length;
  const item = tile(area.name, 'sync-folder', () => openAreaFolder(area.id), areaFolderIcon(files[0]));
  item.dataset.areaId = area.id;
  item.setAttribute('aria-haspopup', 'dialog');
  if (total > 1 && files.length) fillFolderPreview(item, files.slice(0, 4).map(areaFolderIcon), total);
  const summary = area.running ? '동기화 중…' : area.last?.errors ? '동기화 오류' :
    area.last?.pending ? '업데이트 있음' : '파일 ' + total + '개';
  item.append(make('span', summary, 'tile-summary'));
  return item;
}

function drawGroupTile(group) {
  const { id, name, items } = group;
  const item = tile(name, 'sync-folder', () => openAreaGroup(id), 'files');
  item.dataset.areaId = id;
  item.setAttribute('aria-haspopup', 'dialog');
  if (items.length > 1) {
    fillFolderPreview(item, items.slice(0, 4).map(area => areaFolderIcon(area.last?.files?.[0])), items.length);
  }
  const summary = items.some(area => area.running) ? '동기화 중…' : '항목 ' + items.length + '개';
  item.append(make('span', summary, 'tile-summary'));
  return item;
}

function openAreaGroup(id) {
  const group = areaGroups.find(item => item.id === id);
  if (!group) return;
  areaGroupId = id;
  drawAreaGroup(group);
  if (!$('area-group').open) $('area-group').showModal();
}

function drawAreaGroup(group) {
  $('area-group-title').textContent = group.name;
  $('area-group-empty').hidden = group.items.length > 0;
  $('area-group-list').replaceChildren(...group.items.map(area => {
    const item = drawAreaTile(area);
    const source = area.remote || area.repository;
    const localName = area.local.split(/[\\/]/u).filter(Boolean).at(-1) || area.local;
    const detail = make('span', source + ' → ' + localName, 'tile-summary group-source');
    detail.title = source + ' → ' + area.local;
    item.append(detail);
    return item;
  }));
}

function openGroupEditor(group = null, repository = '') {
  groupEditing = group;
  groupRepository = repository;
  elements('area-group-form').name.value = group?.name || repository.split('/').at(-1);
  $('area-group-editor-title').textContent = group ? '영역 설정' : '영역 추가';
  $('area-group-remove').hidden = !group || group.items.length > 0;
  notice('area-group-error');
  $('area-group-editor').showModal();
}

function openAreaFolder(id) {
  const area = syncAreas.find(item => item.id === id);
  if (!area) return;
  areaFolderId = id;
  notice('area-folder-error');
  drawAreaFolder(area);
  $('area-folder').showModal();
}

function drawAreaFolder(area) {
  const { last, running } = area;
  const files = last?.files || [];
  const total = last?.fileCount ?? files.length;
  const source = area.remote || [area.repository, area.branch].filter(Boolean).join(' · ');
  $('area-folder-title').textContent = area.name;
  $('area-folder-source').textContent = [areaSources[area.source], source, area.automatic ? '자동' : '수동']
    .filter(Boolean).join(' · ');
  const status = $('area-folder-status');
  status.textContent = running ? '동기화 중…' : last?.errors ? last.message || '동기화 오류' :
    last?.pending ? '업데이트 있음' : last?.checkedAt ? '마지막 확인 ' + shortDate.format(last.checkedAt) : '동기화 기록 없음';
  status.classList.toggle('work-error', !!last?.errors && !running);
  if (last?.commit) status.append(' · ' + last.commit.sha.slice(0, 7) + ' ' + last.commit.message);
  $('area-folder-count').textContent = total ? '동기화된 파일 ' + total + '개' +
    (files.length < total ? ' 중 ' + files.length + '개 표시' : '') : '동기화된 파일이 없습니다.';
  const list = $('area-folder-files');
  list.hidden = !files.length;
  list.replaceChildren(...files.map(file => {
    const entry = make('li');
    entry.append(icon(areaFolderIcon(file), '#a9c6f8'), make('span', file));
    return entry;
  }));
  $('area-folder-run').textContent = area.source === 'github' ? '최신 파일 적용' : '지금 동기화';
  $('area-folder-run').disabled = $('area-folder-settings').disabled = running;
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
    actions.append(button('동기화 항목 만들기', () => openArea({ repository })),
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
    areaSignature = '';
    returnToAreaGroup = null;
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
  form.repository.required = githubSource;
  if (githubSource && !state.github) notice('area-error', '먼저 GitHub 타일에서 계정을 연결하세요.', true);
  else notice('area-error');
}

function openArea({ area = null, repository = '', groupId = area?.groupId } = {}) {
  if (!areaGroups.length) return openGroupEditor(null, repository);
  returnToAreaGroup = $('area-group').open ? areaGroupId : null;
  $('area-group').close();
  areaEditing = area;
  const form = elements('area-form');
  $('area-form').reset();
  $('area-title').textContent = area ? '동기화 항목 설정' : '동기화 항목 추가';
  $('area-remove').hidden = !area;
  form.name.value = area?.name || repository.split('/').at(-1);
  form.groupId.replaceChildren(...areaGroups.map(group => new Option(group.name, group.id)));
  form.groupId.value = groupId || areaGroups[0].id;
  form.source.value = area?.source || (repository ? 'github' : 'nas');
  for (const field of ['remote', 'local', 'branch']) form[field].value = area?.[field] || '';
  form.automatic.checked = !!area?.automatic;
  repoOptions(form.repository, githubRepos, area?.repository || repository);
  areaSourceChanged();
  $('area-dialog').showModal();
  const request = ++areaFormRequest;
  if (!state.github) return;
  const login = state.github.login;
  void api.githubRepos().then(rows => {
    if (!$('area-dialog').open || areaFormRequest !== request || state.github?.login !== login) return;
    githubRepos = rows;
    repoOptions(form.repository, rows, form.repository.value);
  }).catch(error => {
    if ($('area-dialog').open && areaFormRequest === request && form.source.value === 'github') notice('area-error', error.message, true);
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
  $('github-shortcut').addEventListener('click', () => void api.openLink('githubShortcut').catch(reportGithub));
  $('github-token-help').addEventListener('click', () => {
    void api.openLink('githubToken').catch(reportGithub);
  });
  $('github-refresh').addEventListener('click', busy($('github-refresh'), refreshGithub, reportGithub));
  $('github-disconnect').addEventListener('click', busy($('github-disconnect'), () => api.githubDisconnect(), reportGithub));
  $('github-connect').addEventListener('submit', event => {
    event.preventDefault();
    const form = elements('github-connect');
    void busy(event.submitter, async () => {
      const connection = api.githubConnect(form.token.value);
      form.token.value = '';
      await connection;
    }, reportGithub)();
  });
  $('github-track').addEventListener('submit', event => {
    event.preventDefault();
    void busy(event.submitter, () => api.githubTrack(elements('github-track').repository.value, true), reportGithub)();
  });
  for (const [id, glyph] of [['area-add', 'add'], ['area-group-add', 'add'], ['area-group-edit', 'pencil']]) {
    $(id).append(icon(glyph));
  }
  $('area-add').addEventListener('click', () => openGroupEditor());
  $('area-group-add').addEventListener('click', () => openArea({ groupId: areaGroupId }));
  $('area-group-edit').addEventListener('click', () => {
    const group = areaGroups.find(item => item.id === areaGroupId);
    if (group) openGroupEditor(group);
  });
  $('area-group-form').addEventListener('submit', event => {
    event.preventDefault();
    void busy(event.submitter, async () => {
      const id = await api.areaGroupSave({ id: groupEditing?.id, name: elements('area-group-form').name.value });
      $('area-group-editor').close();
      if (!$('home').hidden) openAreaGroup(id);
      else if (githubOpen) openArea({ groupId: id, repository: groupRepository });
    }, error => notice('area-group-error', error.message, true))();
  });
  $('area-group-remove').addEventListener('click', busy($('area-group-remove'), async () => {
    await api.areaGroupRemove(groupEditing.id);
    $('area-group-editor').close();
    $('area-add').focus();
  }, error => notice('area-group-error', error.message, true)));
  $('area-group').addEventListener('close', () => {
    if ($('area-group').open) return;
    if (!$('home').hidden && !document.querySelector('dialog[open]')) {
      (areaTile(areaGroupId) || $('area-add')).focus();
    }
    areaGroupId = null;
  });
  $('area-folder').addEventListener('close', () => {
    if ($('area-folder').open) return;
    if (!$('home').hidden && ($('area-group').open || !document.querySelector('dialog[open]'))) {
      (areaTile(areaFolderId) || $('area-add')).focus();
    }
    areaFolderId = null;
  });
  $('area-folder-settings').addEventListener('click', () => {
    const area = syncAreas.find(item => item.id === areaFolderId);
    if (!area || area.running) return;
    $('area-folder').close();
    if (area.id === 'base') openSettings();
    else openArea({ area });
  });
  $('area-folder-run').addEventListener('click', busy($('area-folder-run'), async () => {
    const area = syncAreas.find(item => item.id === areaFolderId);
    if (!area || area.running) return;
    notice('area-folder-error');
    if (area.id === 'base') await api.sync();
    else await api.areaRun(area.id);
  }, error => notice('area-folder-error', error.message, true)));
  const form = elements('area-form');
  $('area-dialog').addEventListener('close', () => {
    if ($('area-dialog').open || browserMode === 'picker') return;
    if (state.connected && returnToAreaGroup) openAreaGroup(returnToAreaGroup);
    returnToAreaGroup = null;
  });
  form.source.addEventListener('change', areaSourceChanged);
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
    if (await api.areaRemove(areaEditing.id)) $('area-dialog').close();
  }, reportArea));
}
