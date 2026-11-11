'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const methods = ['state', 'login', 'logout', 'list', 'chooseLocal', 'settings', 'sync',
  'layout', 'upload', 'download', 'openFolder', 'openLink', 'terminal'];
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
launcher.platform = process.platform;

contextBridge.exposeInMainWorld('launcher', launcher);
