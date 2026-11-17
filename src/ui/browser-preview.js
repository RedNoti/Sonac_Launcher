'use strict';

(() => {
  if (window.launcher || !['http:', 'https:', 'file:'].includes(location.protocol)) return;

  const profile = { id: 'preview-nas', name: '메인 나스', provider: 'synology',
    url: 'https://nas.example.test', user: 'demo', saved: false };
  const account = { email: 'demo@example.test', files: [] };
  const aiUsage = { tokens: 256, rateLimit: { retryAt: 0, limits: [
    { window: 'second', remaining: 1, limit: 1 },
    { window: 'minute', remaining: 44, limit: 60 },
    { window: 'day', remaining: 71712, limit: 86400 }
  ] } };
  const settings = { remote: '', local: '', interval: 5, automatic: false, remoteWrites: false,
    layout: { version: 1, links: {}, shortcuts: [] }, areas: [], syncGroups: [] };
  const files = {
    '/': [{ name: '공유 폴더', path: '/Shared', directory: true }],
    '/Shared': [{ name: 'README.txt', path: '/Shared/README.txt', directory: false, size: 128 }]
  };
  let session = { versionLabel: '웹 미리보기 · 예제 데이터', device: '브라우저',
    profile, nasProfiles: [profile], connected: false, runningAreas: [] };
  let onState;
  function setSession(changes) {
    session = { ...session, ...changes };
    return session;
  }
  async function disconnect() {
    onState?.(setSession({ connected: false, settings: null }));
  }
  const unavailable = async () => { throw new Error('설치된 런처에서 사용할 수 있는 기능입니다.'); };
  window.launcher = new Proxy({
    browserPreview: true,
    platform: /Mac/u.test(navigator.platform) ? 'darwin' : 'win32',
    state: async () => session,
    setUsageMode: async (usageMode, preparing) => preparing ? session : setSession({ usageMode }),
    setPreference: async (name, enabled) => name === 'automaticSync'
      ? setSession({ settings: { ...session.settings, automatic: enabled } }) : setSession({ [name]: enabled }),
    remoteWrites: async enabled => setSession({ settings: { ...session.settings, remoteWrites: enabled } }),
    onState(callback) { onState = callback; },
    onTransfer() {},
    onAiText() {},
    onAiPhase() {},
    serverUpdaterLogin: async () => setSession({ aiEmail: account.email, serverUpdaterAccount: session.usageMode === 'nas' ? null : account }),
    serverUpdaterLogout: async () => setSession({ aiEmail: undefined, serverUpdaterAccount: null }),
    login: async () => setSession({ connected: true, settings, aiUsage }),
    logout: disconnect,
    switchNas: disconnect,
    list: async folder => files[folder] ?? [],
    listLocal: async folder => ({ root: '미리보기', entries: files[folder] ?? [] }),
    aiHistory: async () => []
  }, { get: (bridge, name) => bridge[name] ?? unavailable });
})();
