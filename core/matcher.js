/**
 * 文件匹配模块 - 在指定磁盘中按预设路径和规则搜索日志文件
 * 集成 SQLite 文件索引，支持增量扫描
 */
import fs from 'fs';
import path from 'path';
import { initFileIndex, updateFileIndex, queryFileIndex, isIndexFresh, getIndexStats, normalizePath } from './file-index.js';

// 预设扫描路径
const PRESET_DIRS = ['MedCom\\log', 'MedCom/log', 'MriSiteData', 'SysUtil'];

// 目标文件扩展名
const TARGET_EXTENSIONS = new Set(['.log', '.mrs', '.txt', '.xml']);

// 索引是否已初始化
let indexInitialized = false;
let indexDir = null;

/**
 * 初始化文件索引
 * @param {string} dirPath - 索引数据库存放目录
 */
export async function initIndex(dirPath) {
  indexDir = dirPath;
  await initFileIndex(dirPath);
  indexInitialized = true;
}

/**
 * 构建/更新磁盘文件索引
 * @param {string} diskRoot - 磁盘根路径
 * @param {function} onProgress - 进度回调
 * @returns {{total: number, inserted: number, updated: number, deleted: number}}
 */
export async function buildFileIndex(diskRoot, onProgress = null) {
  if (!indexInitialized) {
    throw new Error('索引未初始化，请先调用 initIndex()');
  }

  // 统一路径格式
  diskRoot = normalizePath(diskRoot);

  const allFiles = [];
  const visitedDirs = new Set();

  const excludeDirs = new Set([
    '$recycle.bin', 'system volume information', 'windows',
    'program files', 'program files (x86)', 'programdata',
    'node_modules', '.git', '__pycache__', '.cache',
    'appdata', 'perflogs', 'msocache', 'intel'
  ]);

  // 遍历磁盘，收集所有目标文件
  collectFiles(diskRoot, allFiles, visitedDirs, excludeDirs, onProgress);

  // 批量更新索引
  const stats = updateFileIndex(diskRoot, allFiles);

  return {
    total: allFiles.length,
    ...stats
  };
}

/**
 * 递归收集文件信息
 */
function collectFiles(dir, files, visited, excludeDirs, onProgress) {
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);

    if (excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      // Dirent objects don't have size/mtime, always use fs.statSync for file stats
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        collectFiles(fullPath, files, visited, excludeDirs, onProgress);
      } else if (stat.isFile()) {
        const ext = path.extname(entryName).toLowerCase();
        if (!TARGET_EXTENSIONS.has(ext)) continue;

        files.push({
          fullPath,
          fileName: entryName,
          fileSize: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          fileType: ext
        });
      }
    } catch {
      // 跳过无法访问的文件
    }
  }

  if (onProgress) {
    onProgress({ scannedDirs: visited.size, foundFiles: files.length, currentDir: dir });
  }
}

/**
 * 扫描磁盘中所有日志文件（不做文件名过滤）
 * @param {string} diskRoot - 磁盘根路径
 * @param {boolean} useIndex - 是否使用索引
 * @returns {string[]} 所有日志文件路径列表
 */
export function scanAllLogFiles(diskRoot, useIndex = true) {
  // 如果索引可用且是最新的，使用索引查询所有文件
  if (useIndex && indexInitialized && isIndexFresh(diskRoot)) {
    const indexedFiles = queryFileIndex(diskRoot, '');
    if (indexedFiles.length > 0) {
      return indexedFiles.map(f => f.fullPath);
    }
  }

  // 回退到直接扫描
  return directScanAll(diskRoot);
}

/**
 * 直接扫描磁盘所有日志文件（不使用索引）
 */
function directScanAll(diskRoot) {
  const matchedFiles = [];
  const visitedDirs = new Set();

  const excludeDirs = new Set([
    '$recycle.bin', 'system volume information', 'windows',
    'program files', 'program files (x86)', 'programdata',
    'node_modules', '.git', '__pycache__', '.cache',
    'appdata', 'perflogs', 'msocache', 'intel'
  ]);

  walkDirAll(diskRoot, matchedFiles, visitedDirs, excludeDirs);
  return matchedFiles;
}

/**
 * 递归遍历目录，收集所有日志文件
 */
function walkDirAll(dir, results, visited, excludeDirs = null) {
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);

    if (excludeDirs && excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      const stat = typeof entry === 'string' ? fs.statSync(fullPath) : entry;

      if (stat.isDirectory()) {
        walkDirAll(fullPath, results, visited, excludeDirs);
      } else if (stat.isFile()) {
        const ext = path.extname(entryName).toLowerCase();
        if (TARGET_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    } catch {
      // 跳过
    }
  }
}

/**
 * 在指定磁盘根目录下扫描匹配的文件（优先使用索引）
 * @param {string} diskRoot - 磁盘根路径
 * @param {string} filePattern - 文件路径模板
 * @param {boolean} useIndex - 是否使用索引（默认 true）
 * @returns {string[]} 匹配的文件完整路径列表
 */
export function scanDiskForFiles(diskRoot, filePattern, useIndex = true) {
  // 如果没有指定文件模式，返回空数组
  if (!filePattern || filePattern.trim() === '') {
    return [];
  }

  // 如果索引可用且是最新的，优先使用索引查询
  if (useIndex && indexInitialized && isIndexFresh(diskRoot)) {
    const indexedFiles = queryFileIndex(diskRoot, filePattern);
    if (indexedFiles.length > 0) {
      return indexedFiles.map(f => f.fullPath);
    }
  }

  // 回退到直接扫描
  return directScan(diskRoot, filePattern);
}

/**
 * 直接扫描磁盘（不使用索引）
 */
function directScan(diskRoot, filePattern) {
  const matchedFiles = [];
  const visitedDirs = new Set();

  const normalizedPattern = filePattern.replace(/\\/g, '/').toLowerCase();

  // 1. 优先在预设路径中搜索
  for (const presetDir of PRESET_DIRS) {
    const presetPath = path.join(diskRoot, presetDir);
    if (fs.existsSync(presetPath)) {
      walkDir(presetPath, normalizedPattern, matchedFiles, visitedDirs);
    }
  }

  // 2. 全盘搜索
  const excludeDirs = new Set([
    '$recycle.bin', 'system volume information', 'windows',
    'program files', 'program files (x86)', 'programdata',
    'node_modules', '.git', '__pycache__', '.cache',
    'appdata', 'perflogs', 'msocache', 'intel'
  ]);

  walkDir(diskRoot, normalizedPattern, matchedFiles, visitedDirs, excludeDirs);

  return matchedFiles;
}

/**
 * 递归遍历目录
 */
function walkDir(dir, pattern, results, visited, excludeDirs = null) {
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);

    if (excludeDirs && excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      const stat = typeof entry === 'string' ? fs.statSync(fullPath) : entry;

      if (stat.isDirectory()) {
        walkDir(fullPath, pattern, results, visited, excludeDirs);
      } else if (stat.isFile()) {
        const ext = path.extname(entryName).toLowerCase();
        if (!TARGET_EXTENSIONS.has(ext)) continue;

        if (fuzzyMatchFile(entryName, fullPath, pattern)) {
          results.push(fullPath);
        }
      }
    } catch {
      // 跳过
    }
  }
}

/**
 * 模糊匹配文件
 */
function fuzzyMatchFile(filename, fullPath, pattern) {
  const filenameLower = filename.toLowerCase();
  const fullPathLower = fullPath.toLowerCase().replace(/\\/g, '/');
  const dirLower = path.dirname(fullPathLower);

  if (pattern.includes('/')) {
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = dirLower.split('/').filter(Boolean);

    for (let i = 0; i <= pathParts.length - patternParts.length; i++) {
      let match = true;
      for (let j = 0; j < patternParts.length; j++) {
        if (!pathParts[i + j]?.includes(patternParts[j])) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    if (globMatch(filenameLower, pattern)) return true;
  }

  const patternBase = pattern.replace(/\.[^.]+$/, '');
  if (patternBase && filenameLower.includes(patternBase)) return true;

  const dirName = path.basename(dirLower);
  if (pattern && dirName.includes(pattern.replace(/\.[^.]+$/, ''))) return true;

  return false;
}

/**
 * glob 匹配
 */
function globMatch(str, pattern) {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`).test(str);
}

/**
 * 获取索引统计
 */
export function getIndexInfo(diskRoot) {
  if (!indexInitialized) return null;
  return getIndexStats(diskRoot);
}

/**
 * 检查索引是否可用
 */
export function checkIndexStatus(diskRoot) {
  if (!indexInitialized) return { available: false, fresh: false };
  return {
    available: true,
    fresh: isIndexFresh(diskRoot),
    stats: getIndexStats(diskRoot)
  };
}
