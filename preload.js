import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('deviceCollector', {
  version: '4.0.0',
  platform: process.platform,
  isElectron: true
});
