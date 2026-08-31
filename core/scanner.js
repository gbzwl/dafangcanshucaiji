/**
 * 磁盘扫描模块 - 检测系统所有可用磁盘分区
 */
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import fs from 'fs';

/**
 * 获取所有可用磁盘列表
 * 在 Windows 上通过 wmic 获取磁盘信息，在 Linux 上通过 df 获取
 */
export function getAvailableDisks() {
  const platform = os.platform();

  if (platform === 'win32') {
    return getWindowsDisks();
  }
  // Linux/macOS 开发环境兼容
  return getLinuxDisks();
}

function getWindowsDisks() {
  const disks = [];

  // 尝试用 wmic 获取卷标信息（Windows 11 24H2+ 可能没有 wmic）
  const volumeLabels = {};
  try {
    const output = execSync(
      'wmic logicaldisk get caption,volumename /format:csv',
      { encoding: 'utf-8', timeout: 5000 }
    );
    const lines = output.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(',');
      if (parts.length >= 3) {
        const caption = (parts[1] || '').trim();
        const volumename = (parts[2] || '').trim();
        if (caption && volumename) {
          volumeLabels[caption] = volumename;
        }
      }
    }
  } catch {
    // wmic 不可用，忽略
  }

  // 主要方案：遍历 A-Z 盘符，使用 fs.statfsSync 获取磁盘信息
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i) + ':';
    try {
      fs.accessSync(letter + '\\', fs.constants.F_OK);
      const stats = fs.statfsSync(letter + '\\');

      const totalBytes = stats.bsize * stats.blocks;
      const freeBytes = stats.bsize * stats.bfree;

      if (totalBytes === 0) continue;

      // 卷标：优先使用 wmic 获取的卷标，其次使用盘符
      let label = volumeLabels[letter] || '';
      if (!label) {
        label = letter;
      }

      // 系统盘标识
      if (letter === 'C:') {
        label = label ? `${label} (系统盘)` : '系统盘';
      }

      disks.push({
        letter,
        label,
        type: '本地磁盘',
        totalGB: roundGB(totalBytes),
        freeGB: roundGB(freeBytes),
        usedGB: roundGB(totalBytes - freeBytes),
        usedPercent: Math.round(((totalBytes - freeBytes) / totalBytes) * 100)
      });
    } catch {
      // 盘符不存在或无法访问，跳过
    }
  }

  return disks;
}

function getLinuxDisks() {
  const disks = [];
  try {
    const output = execSync("df -B1 --output=source,size,used,avail,target | tail -n +2", {
      encoding: 'utf-8',
      timeout: 10000
    });
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;

      const [source, totalBytes, usedBytes, availBytes, mountpoint] = parts;
      const total = parseInt(totalBytes) || 0;
      if (total === 0 || !source.startsWith('/')) continue;

      disks.push({
        letter: mountpoint,
        label: `${mountpoint} (${source})`,
        type: source.includes('sd') ? '本地磁盘' : source.includes('usb') ? '外部存储' : '系统分区',
        totalGB: roundGB(total),
        freeGB: roundGB(parseInt(availBytes) || 0),
        usedGB: roundGB(parseInt(usedBytes) || 0),
        usedPercent: total > 0 ? Math.round((parseInt(usedBytes) / total) * 100) : 0
      });
    }
  } catch (err) {
    console.error('获取Linux磁盘信息失败:', err.message);
  }
  return disks;
}

function roundGB(bytes) {
  return Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10;
}
