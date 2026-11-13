'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const call = async (name, ...args) => {
  const response = await ipcRenderer.invoke('launcher:' + name, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
};
contextBridge.exposeInMainWorld('terminal', {
  home: () => call('terminalHome'),
  start: (cols, rows) => call('terminalStart', cols, rows),
  write: data => call('terminalWrite', data),
  resize: (cols, rows) => call('terminalResize', cols, rows),
  commands: () => call('terminalCommands'),
  saveCommand: value => call('terminalCommandSave', value),
  removeCommand: id => call('terminalCommandRemove', id),
  onData(callback) {
    ipcRenderer.on('launcher:terminal', (_event, value) => callback(value));
  }
});
