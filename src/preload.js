'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const methods = ['state', 'setUsageMode', 'setPreference', 'login', 'logout', 'switchNas', 'list', 'listLocal', 'chooseLocal', 'settings', 'sync', 'syncAll',
  'layout', 'upload', 'download', 'delete', 'mkdir', 'renameFile', 'extractArchive', 'moveNas', 'preview', 'mediaFolder', 'mediaPlay', 'mediaCompatible', 'mediaSubtitle', 'closePreview', 'checkUpdate', 'installUpdate', 'openLink',
  'uninstallMac', 'terminal', 'remoteWrites', 'serverUpdaterLogin', 'serverUpdaterLogout', 'serverUpdaterRestore',
  'serverFileAdd', 'serverFileRemove', 'serverFileOpen', 'serverMonitorSettings', 'serverMonitorTarget', 'serverMonitorCheck', 'aiHistory', 'aiManageChat', 'aiPickFiles', 'aiChat', 'aiTitle', 'aiCancel',
  'serverAssets', 'serverDeploy', 'serverRun', 'serverStop', 'serverLogs', 'serverDeploymentFolder', 'serverDataFolder',
  'serverGitHubConnect', 'serverGitHubDisconnect', 'serverGitHubRepos',
  'githubConnect', 'githubDisconnect', 'githubRepos', 'githubCommit', 'githubTrack',
  'areaGroupSave', 'areaGroupRemove', 'areaGroupMove', 'folderFavorite', 'areaFolder', 'areaSave', 'areaRemove', 'areaRun'];
const launcher = Object.fromEntries(methods.map(name => [name, async (...args) => {
  const response = await ipcRenderer.invoke('launcher:' + name, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}]));
function droppedPaths(files) {
  if (!Array.isArray(files) || !files.length || files.length > 1000) throw new Error('놓은 파일을 확인하세요.');
  const paths = files.map(file => webUtils.getPathForFile(file));
  if (paths.some(path => !path)) throw new Error('Finder 또는 파일 탐색기에서 파일을 끌어오세요.');
  return paths;
}

launcher.uploadDropped = (folder, files) => launcher.upload(folder, droppedPaths(files));
launcher.aiAttachDropped = files => launcher.aiPickFiles(droppedPaths(files));
launcher.onState = (callback) => {
  const handler = (_event, state) => callback(state);
  ipcRenderer.on('launcher:state', handler);
  return () => ipcRenderer.removeListener('launcher:state', handler);
};
launcher.onTransfer = callback => {
  ipcRenderer.on('launcher:transfer', (_event, value) => callback(value));
};
launcher.onAiText = callback => {
  ipcRenderer.on('launcher:aiText', (_event, requestId, text) => callback(requestId, text));
};
launcher.onAiPhase = callback => {
  ipcRenderer.on('launcher:aiPhase', (_event, requestId, phase) => callback(requestId, phase));
};
launcher.platform = process.platform;

contextBridge.exposeInMainWorld('launcher', launcher);
