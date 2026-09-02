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
const TARGET_EXTENSIONS = new Set(['.log', '.mrs', '.txt', '.xml', '.csv', '.ini', '.cfg', '.conf']);
const DEFAULT_EXCLUDE_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows',
  'program files', 'program files (x86)', 'programdata',
  'node_modules', '.git', '__pycache__', '.cache',
  'appdata', 'perflogs', 'msocache', 'intel',
  'coze', 'versions', 'cache', 'dist', 'build',
  'resources', 'certs', 'lang'
]);

// 索引是否已初始化
let indexInitialized = false;
let indexDir = null;

const YIELD_EVERY = 50;
const waitForYield = () => new Promise(resolve => setImmediate(resolve));

function normalizeDiskRoot(diskRoot) {
  if (/^[a-z]:$/i.test(diskRoot)) return diskRoot + '\\';
  return diskRoot;
}

function shouldAbort(options = {}) {
  return !!options.signal?.aborted;
}

function getExcludeDirs(options = {}) {
  return options.excludeDirs || DEFAULT_EXCLUDE_DIRS;
}

function isTargetFile(filePath) {
  return TARGET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

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

export async function scanAllLogFilesWithProgress(diskRoot, onProgress = null) {
  diskRoot = normalizeDiskRoot(diskRoot);
  return scanAllLogFilesWithProgressOptions(diskRoot, onProgress);
}

export async function scanAllLogFilesWithProgressOptions(diskRoot, onProgress = null, options = {}) {
  diskRoot = normalizeDiskRoot(diskRoot);
  const matchedFiles = [];
  const visitedDirs = new Set();
  const counters = { checkedFiles: 0, matchedFiles: 0 };

  const excludeDirs = getExcludeDirs(options);

  await walkDirAllWithProgress(diskRoot, matchedFiles, visitedDirs, excludeDirs, onProgress, counters, options);
  return matchedFiles;
}

export async function scanReferenceFilesWithProgress(diskRoot, referencePattern, onProgress = null, options = {}) {
  diskRoot = normalizeDiskRoot(diskRoot);
  const files = [];
  const visitedDirs = new Set();
  const counters = { checkedFiles: 0, matchedFiles: 0 };
  const references = splitPatterns(referencePattern);

  for (const ref of references) {
    if (shouldAbort(options)) break;
    const targetPath = path.isAbsolute(ref) ? ref : path.join(diskRoot, ref);

    if (!fs.existsSync(targetPath)) continue;

    let stat;
    try {
      stat = fs.statSync(targetPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      await walkDirAllWithProgress(targetPath, files, visitedDirs, getExcludeDirs(options), onProgress, counters, options);
    } else if (stat.isFile() && isTargetFile(targetPath)) {
      counters.checkedFiles++;
      files.push(targetPath);
      counters.matchedFiles++;
      if (onProgress) {
        await onProgress({ type: 'file_check', file: targetPath, checkedFiles: counters.checkedFiles, matchedFiles: counters.matchedFiles, target: true });
        await onProgress({ type: 'file_match', file: targetPath, checkedFiles: counters.checkedFiles, matchedFiles: counters.matchedFiles });
      }
    }
  }

  return [...new Set(files)];
}

export async function scanFileGlobsWithProgress(diskRoot, patterns, onProgress = null, options = {}) {
  diskRoot = normalizeDiskRoot(diskRoot);
  const files = [];
  const visitedDirs = new Set();
  const counters = { checkedFiles: 0, matchedFiles: 0 };
  const normalizedPatterns = splitPatterns(patterns).map(p => p.replace(/\\/g, '/').toLowerCase());

  if (normalizedPatterns.length === 0) return [];

  await walkDirWithPredicate(diskRoot, files, visitedDirs, getExcludeDirs(options), onProgress, counters, options, (entryName, fullPath) => {
    if (!isTargetFile(fullPath)) return false;
    const filename = entryName.toLowerCase();
    const normalizedPath = fullPath.replace(/\\/g, '/').toLowerCase();
    return normalizedPatterns.some(pattern => matchFilePattern(filename, normalizedPath, pattern));
  });

  return [...new Set(files)];
}

export function buildFileGlobCandidates(rule = {}) {
  const candidates = [];
  const filePattern = rule.filePattern || rule.file_pattern || '';
  for (const pattern of splitPatterns(filePattern)) {
    if (pattern.includes('*') || pattern.includes('?') || /\.[a-z0-9]{1,8}$/i.test(pattern)) {
      candidates.push(pattern);
    }
  }

  const words = [
    rule.keyword,
    ...(Array.isArray(rule.synonyms) ? rule.synonyms : []),
    rule.indicator
  ].flatMap(value => String(value || '').split(/[\s_;,./\\:-]+/))
    .map(value => value.trim())
    .filter(value => /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(value));

  for (const word of words.slice(0, 8)) {
    candidates.push(`*${word}*.log`, `*${word}*.txt`, `*${word}*.csv`);
  }

  candidates.push('*History*.log', '*Status*.log', '*Event*.log', '*Error*.log', '*Service*.log');
  return [...new Set(candidates)];
}

function splitPatterns(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map(item => String(item || '').trim()).filter(Boolean);
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

async function walkDirAllWithProgress(dir, results, visited, excludeDirs = null, onProgress = null, counters = null, options = {}) {
  if (shouldAbort(options) || (options.maxFiles && counters.checkedFiles >= options.maxFiles)) return;
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  if (onProgress) {
    await onProgress({ type: 'dir_enter', dir, scannedDirs: visited.size });
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    if (onProgress) {
      await onProgress({ type: 'dir_skip', dir });
    }
    return;
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);

    if (excludeDirs && excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      const stat = typeof entry === 'string' ? fs.statSync(fullPath) : entry;

      if (stat.isDirectory()) {
        await walkDirAllWithProgress(fullPath, results, visited, excludeDirs, onProgress, counters, options);
      } else if (stat.isFile()) {
        counters.checkedFiles++;
        const ext = path.extname(entryName).toLowerCase();

        if (onProgress && counters.checkedFiles % (options.progressEvery || 100) === 0) {
          await onProgress({
            type: 'file_check',
            file: fullPath,
            checkedFiles: counters.checkedFiles,
            matchedFiles: counters.matchedFiles,
            target: TARGET_EXTENSIONS.has(ext)
          });
        }

        if (TARGET_EXTENSIONS.has(ext)) {
          results.push(fullPath);
          counters.matchedFiles++;
          if (onProgress) {
            await onProgress({
              type: 'file_match',
              file: fullPath,
              checkedFiles: counters.checkedFiles,
              matchedFiles: counters.matchedFiles
            });
          }
        }

        if (counters.checkedFiles % YIELD_EVERY === 0) {
          await waitForYield();
        }

        if (options.maxFiles && counters.checkedFiles >= options.maxFiles) return;
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

export async function scanDiskForFilesWithProgress(diskRoot, filePattern, onProgress = null) {
  if (!filePattern || filePattern.trim() === '') {
    return [];
  }

  diskRoot = normalizeDiskRoot(diskRoot);
  const matchedFiles = [];
  const visitedDirs = new Set();
  const counters = { checkedFiles: 0, matchedFiles: 0 };
  const normalizedPattern = filePattern.replace(/\\/g, '/').toLowerCase();

  for (const presetDir of PRESET_DIRS) {
    const presetPath = path.join(diskRoot, presetDir);
    if (fs.existsSync(presetPath)) {
      await walkDirWithProgress(presetPath, normalizedPattern, matchedFiles, visitedDirs, null, onProgress, counters);
    }
  }

  const excludeDirs = new Set([
    '$recycle.bin', 'system volume information', 'windows',
    'program files', 'program files (x86)', 'programdata',
    'node_modules', '.git', '__pycache__', '.cache',
    'appdata', 'perflogs', 'msocache', 'intel'
  ]);

  await walkDirWithProgress(diskRoot, normalizedPattern, matchedFiles, visitedDirs, excludeDirs, onProgress, counters);
  return matchedFiles;
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

async function walkDirWithProgress(dir, pattern, results, visited, excludeDirs = null, onProgress = null, counters = null, options = {}) {
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  if (onProgress) {
    await onProgress({ type: 'dir_enter', dir, scannedDirs: visited.size });
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    if (onProgress) {
      await onProgress({ type: 'dir_skip', dir });
    }
    return;
  }

  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);

    if (excludeDirs && excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      const stat = typeof entry === 'string' ? fs.statSync(fullPath) : entry;

      if (stat.isDirectory()) {
        await walkDirWithProgress(fullPath, pattern, results, visited, excludeDirs, onProgress, counters, options);
      } else if (stat.isFile()) {
        counters.checkedFiles++;
        const ext = path.extname(entryName).toLowerCase();

        if (onProgress && counters.checkedFiles % (options.progressEvery || 100) === 0) {
          await onProgress({
            type: 'file_check',
            file: fullPath,
            checkedFiles: counters.checkedFiles,
            matchedFiles: counters.matchedFiles,
            target: TARGET_EXTENSIONS.has(ext)
          });
        }

        if (TARGET_EXTENSIONS.has(ext) && fuzzyMatchFile(entryName, fullPath, pattern)) {
          results.push(fullPath);
          counters.matchedFiles++;
          if (onProgress) {
            await onProgress({
              type: 'file_match',
              file: fullPath,
              checkedFiles: counters.checkedFiles,
              matchedFiles: counters.matchedFiles
            });
          }
        }

        if (counters.checkedFiles % YIELD_EVERY === 0) {
          await waitForYield();
        }
      }
    } catch {
      // 跳过
    }
  }
}

async function walkDirWithPredicate(dir, results, visited, excludeDirs = null, onProgress = null, counters = null, options = {}, predicate = () => false) {
  if (shouldAbort(options) || (options.maxFiles && counters.checkedFiles >= options.maxFiles)) return;
  const realDir = dir;
  if (visited.has(realDir)) return;
  visited.add(realDir);

  if (onProgress) {
    await onProgress({ type: 'dir_enter', dir, scannedDirs: visited.size });
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    if (onProgress) await onProgress({ type: 'dir_skip', dir });
    return;
  }

  for (const entry of entries) {
    if (shouldAbort(options) || (options.maxFiles && counters.checkedFiles >= options.maxFiles)) return;

    const entryName = typeof entry === 'string' ? entry : entry.name;
    const fullPath = path.join(dir, entryName);
    if (excludeDirs && excludeDirs.has(entryName.toLowerCase())) continue;

    try {
      const stat = typeof entry === 'string' ? fs.statSync(fullPath) : entry;
      if (stat.isDirectory()) {
        await walkDirWithPredicate(fullPath, results, visited, excludeDirs, onProgress, counters, options, predicate);
      } else if (stat.isFile()) {
        counters.checkedFiles++;
        const target = isTargetFile(fullPath);

        if (onProgress && counters.checkedFiles % (options.progressEvery || 100) === 0) {
          await onProgress({
            type: 'file_check',
            file: fullPath,
            checkedFiles: counters.checkedFiles,
            matchedFiles: counters.matchedFiles,
            target
          });
        }

        if (predicate(entryName, fullPath)) {
          results.push(fullPath);
          counters.matchedFiles++;
          if (onProgress) {
            await onProgress({
              type: 'file_match',
              file: fullPath,
              checkedFiles: counters.checkedFiles,
              matchedFiles: counters.matchedFiles
            });
          }
        }

        if (counters.checkedFiles % YIELD_EVERY === 0) await waitForYield();
      }
    } catch {
      // 跳过
    }
  }
}

function matchFilePattern(filename, normalizedPath, pattern) {
  if (pattern.includes('/') && !pattern.includes('*') && !pattern.includes('?')) {
    return normalizedPath.includes(pattern);
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    return globMatch(filename, path.basename(pattern)) || globMatch(normalizedPath, pattern);
  }
  return filename.includes(path.basename(pattern));
}

/**
 * 模糊匹配文件
 */
function fuzzyMatchFile(filename, fullPath, pattern) {
  const filenameLower = filename.toLowerCase();
  const fullPathLower = fullPath.toLowerCase().replace(/\\/g, '/');
  const dirLower = path.dirname(fullPathLower);
  const hasExplicitFile = /\.[a-z0-9]{1,8}$/i.test(pattern) && !pattern.includes('/') && !pattern.includes('\\');

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

  if (hasExplicitFile) {
    return filenameLower === pattern || filenameLower.includes(pattern);
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
