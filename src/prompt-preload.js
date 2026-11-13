'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(name, ...args) {
  const response = await ipcRenderer.invoke('launcher:' + name, ...args);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

contextBridge.exposeInMainWorld('promptView', {
  details: () => call('promptDetails'),
  answer: accepted => call('promptAnswer', accepted)
});
