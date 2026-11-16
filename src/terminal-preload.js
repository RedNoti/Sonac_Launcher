'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const call = async (name, ...args) => {
  const response = await ipcRenderer.invoke('launcher:' + name, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
contextBridge.exposeInMainWorld('terminal', {
  home: () => call('terminalHome'),
  start: (id, cols, rows) => call('terminalStart', id, cols, rows),
  closeTab: id => call('terminalCloseTab', id),
  write: (id, data) => call('terminalWrite', id, data),
  resize: (id, cols, rows) => call('terminalResize', id, cols, rows),
  commands: () => call('terminalCommands'),
  saveCommand: value => call('terminalCommandSave', value),
  removeCommand: id => call('terminalCommandRemove', id),
  onData(callback) {
    ipcRenderer.on('launcher:terminal', (_event, value) => callback(value));
  }
});
