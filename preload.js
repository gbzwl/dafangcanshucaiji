/**
 * Electron preload 脚本 - 安全地暴露 API 给前端
 */
import { contextBridge } from 'electron';

// 暴露应用信息到前端
contextBridge.exposeInMainWorld('mriCollector', {
  version: '1.0.0',
  platform: process.platform,
  isElectron: true
});
