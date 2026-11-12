'use strict';

const origin = 'https://api.github.com';

function repositoryPath(repository) {
  if (typeof repository !== 'string' || !/^[\w-]+\/[\w.-]+$/u.test(repository) ||
      ['.', '..'].includes(repository.split('/')[1])) {
    throw new Error('GitHub 저장소를 선택하세요.');
  }
  return '/repos/' + repository.split('/').map(encodeURIComponent).join('/');
}

async function request(path, token, signal) {
  const response = await fetch(origin + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'sonac-launcher'
    },
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
  });
  return response;
}

async function checked(response) {
  if (response.ok) return response;
  await response.body?.cancel();
  const errors = {
    401: 'GitHub 토큰이 만료되었거나 올바르지 않습니다. 다시 연결하세요.',
    403: 'GitHub 저장소 읽기 권한과 API 사용 한도를 확인하세요.',
    404: 'GitHub 저장소나 브랜치를 찾을 수 없습니다. 토큰의 저장소 접근 권한을 확인하세요.',
    409: 'GitHub 저장소에 커밋이 없습니다.',
    429: 'GitHub API 사용 한도에 도달했습니다. 잠시 후 다시 시도하세요.'
  };
  throw new Error(errors[response.status] || 'GitHub 요청을 처리할 수 없습니다.');
}

async function identity(token, signal) {
  const { login } = await (await checked(await request('/user', token, signal))).json();
  if (typeof login !== 'string' || !login) throw new Error('GitHub 계정 정보를 읽을 수 없습니다.');
  return login;
}

async function repositories(token, signal) {
  const all = [];
  for (let page = 1; ; page++) {
    const response = await checked(await request(
      '/user/repos?affiliation=owner&sort=full_name&per_page=100&page=' + page, token, signal
    ));
    const rows = await response.json();
    all.push(...rows.map(row => ({
      name: row.full_name, branch: row.default_branch, private: row.private
    })));
    if (!response.headers.get('link')?.includes('rel="next"')) return all;
  }
}

async function latestCommit(repository, branch, token, signal) {
  const query = branch ? '?sha=' + encodeURIComponent(branch) : '';
  const data = await (await checked(await request(repositoryPath(repository) + '/commits' + query +
    (query ? '&' : '?') + 'per_page=1', token, signal))).json();
  const commit = data[0];
  if (!/^[\da-f]{40}$/u.test(commit?.sha || '')) throw new Error('GitHub 저장소에 커밋이 없습니다.');
  return {
    sha: commit.sha, message: commit.commit.message.split('\n')[0],
    author: commit.commit.author?.name || '', date: commit.commit.committer?.date || ''
  };
}

async function archive(repository, sha, token, signal) {
  const response = await request(repositoryPath(repository) + '/zipball/' + sha, token, signal);
  if (response.status !== 302) return checked(response);
  const location = response.headers.get('location');
  await response.body?.cancel();
  const url = location && new URL(location);
  if (!url || url.origin !== 'https://codeload.github.com' || url.username || url.password) {
    throw new Error('GitHub 압축 파일의 다운로드 주소를 확인할 수 없습니다.');
  }
  return checked(await fetch(url, { redirect: 'error', signal }));
}

module.exports = { repositoryPath, identity, repositories, latestCommit, archive };
