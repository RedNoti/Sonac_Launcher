'use strict';

const invokePreview = window.__TAURI__.core.invoke;
const previewOnly = () => Promise.reject(new Error('Tauri 미리보기에서 사용할 수 없는 기능입니다.'));
window.launcher = new Proxy({
  platform: /Mac/u.test(navigator.platform) ? 'darwin' : 'win32',
  state: () => invokePreview('preview_state'),
  list: folder => invokePreview('preview_files', { folder }),
  listLocal: async folder => ({ root: '미리보기', entries: await invokePreview('preview_files', { folder }) }),
  onState() {},
  onTransfer() {}
}, { get: (bridge, name) => bridge[name] ?? previewOnly });
