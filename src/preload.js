'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = ['state', 'login', 'logout', 'switchNas', 'list', 'listLocal', 'chooseLocal', 'settings', 'sync',
  'layout', 'upload', 'download', 'delete', 'mkdir', 'preview', 'closePreview', 'checkUpdate', 'installUpdate', 'openLink',
  'terminal', 'remoteWrites',
  'githubConnect', 'githubDisconnect', 'githubRepos', 'githubCommit', 'githubTrack',
  'areaGroupSave', 'areaGroupRemove', 'areaFolder', 'areaSave', 'areaRemove', 'areaRun'];
const launcher = Object.fromEntries(methods.map(name => [name, async (...args) => {
  const response = await ipcRenderer.invoke('launcher:' + name, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}]));
launcher.onState = (callback) => {
  const handler = (_event, state) => callback(state);
  ipcRenderer.on('launcher:state', handler);
  return () => ipcRenderer.removeListener('launcher:state', handler);
};
launcher.onTransfer = callback => {
  ipcRenderer.on('launcher:transfer', (_event, value) => callback(value));
};
launcher.platform = process.platform;

contextBridge.exposeInMainWorld('launcher', launcher);
