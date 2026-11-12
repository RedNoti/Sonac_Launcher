'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = ['state', 'savedPassword', 'login', 'logout', 'list', 'listLocal', 'chooseLocal', 'settings', 'sync',
  'layout', 'upload', 'download', 'delete', 'preview', 'closePreview', 'installUpdate', 'openLink',
  'terminal', 'terminalWrite', 'terminalResize', 'terminalClose',
  'githubConnect', 'githubDisconnect', 'githubRepos', 'githubCommit', 'githubTrack',
  'areaFolder', 'areaSave', 'areaRemove', 'areaRun'];
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
launcher.onTerminal = callback => {
  const handler = (_event, message) => callback(message);
  ipcRenderer.on('launcher:terminal', handler);
  return () => ipcRenderer.removeListener('launcher:terminal', handler);
};
launcher.platform = process.platform;

contextBridge.exposeInMainWorld('launcher', launcher);
