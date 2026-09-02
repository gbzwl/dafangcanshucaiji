/**
 * SQLite 文件索引模块 - 建立磁盘文件索引，避免重复扫描
 * 使用 sql.js（纯 JS 实现，无需原生编译）
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

let SQL = null;
let db = null;
let dbPath = null;

// 目标文件扩展名
const TARGET_EXTENSIONS = new Set(['.log', '.mrs', '.txt', '.xml']);

/**
 * 统一路径格式：小写 + 路径分隔符结尾
 * Windows: 反斜杠，Linux/Mac: 正斜杠
 */
export function normalizePath(p) {
  if (!p) return '';
  if (/^[a-z]:$/i.test(p)) p += '\\';
  // 检测是否为 Windows 路径（以盘符开头，如 C:\）
  const isWindowsPath = /^[a-z]:[\\/]/i.test(p) || /\\/.test(p);
  const sep = isWindowsPath ? '\\' : '/';
  let normalized = p.toLowerCase().replace(/[\/\\]/g, sep);
  if (!normalized.endsWith(sep)) normalized += sep;
  return normalized;
}

/**
 * 初始化 SQLite 数据库
 * @param {string} dirPath - 数据库文件存放目录
 */
export async function initFileIndex(dirPath) {
  if (!SQL) {
    try {
      SQL = await initSqlJs({
        locateFile: file => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file)
      });
    } catch (e) {
      // 回退到默认加载方式
      SQL = await initSqlJs();
    }
  }

  dbPath = path.join(dirPath, 'file_index.db');

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 创建索引表
  db.run(`
    CREATE TABLE IF NOT EXISTS file_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      disk_root TEXT NOT NULL,
      file_name TEXT NOT NULL,
      full_path TEXT NOT NULL UNIQUE,
      file_size INTEGER DEFAULT 0,
      modified_time TEXT,
      file_type TEXT,
      scan_time TEXT DEFAULT (datetime('now')),
      is_valid INTEGER DEFAULT 1
    )
  `);

  // 创建索引加速查询
  db.run(`CREATE INDEX IF NOT EXISTS idx_disk_root ON file_index(disk_root)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_file_name ON file_index(file_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_file_type ON file_index(file_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_full_path ON file_index(full_path)`);

  saveDatabase();
  return db;
}

/**
 * 保存数据库到磁盘
 */
function saveDatabase() {
  if (db && dbPath) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }
}

/**
 * 批量插入文件索引（增量更新）
 * @param {string} diskRoot - 磁盘根路径
 * @param {Array<{fullPath: string, fileName: string, fileSize: number, modifiedTime: string, fileType: string}>} files
 * @returns {{inserted: number, updated: number, deleted: number}}
 */
export function updateFileIndex(diskRoot, files) {
  if (!db) throw new Error('数据库未初始化，请先调用 initFileIndex()');

  let inserted = 0;
  let updated = 0;

  // 使用事务批量操作
  db.run('BEGIN TRANSACTION');

  try {
    for (const file of files) {
      // 检查是否已存在
      const existing = db.exec(
        `SELECT id, file_size, modified_time FROM file_index WHERE full_path = '${escapeSql(file.fullPath)}'`
      );

      if (existing.length > 0 && existing[0].values.length > 0) {
        const [id, oldSize, oldTime] = existing[0].values[0];
        // 如果文件大小或修改时间变化，更新记录
        if (oldSize !== file.fileSize || oldTime !== file.modifiedTime) {
          db.run(
            `UPDATE file_index SET file_size = ${file.fileSize}, modified_time = '${escapeSql(file.modifiedTime)}', scan_time = datetime('now'), is_valid = 1 WHERE id = ${id}`
          );
          updated++;
        }
      } else {
        db.run(
          `INSERT INTO file_index (disk_root, file_name, full_path, file_size, modified_time, file_type) VALUES ('${escapeSql(diskRoot)}', '${escapeSql(file.fileName)}', '${escapeSql(file.fullPath)}', ${file.fileSize}, '${escapeSql(file.modifiedTime)}', '${escapeSql(file.fileType)}')`
        );
        inserted++;
      }
    }

    // 将当前磁盘中不再存在的文件标记为无效
    const currentPaths = new Set(files.map(f => f.fullPath));
    const indexedFiles = db.exec(
      `SELECT id, full_path FROM file_index WHERE disk_root = '${escapeSql(diskRoot)}' AND is_valid = 1`
    );

    let deleted = 0;
    if (indexedFiles.length > 0) {
      for (const [id, fullPath] of indexedFiles[0].values) {
        if (!currentPaths.has(fullPath)) {
          db.run(`UPDATE file_index SET is_valid = 0 WHERE id = ${id}`);
          deleted++;
        }
      }
    }

    db.run('COMMIT');
    saveDatabase();

    return { inserted, updated, deleted };
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

/**
 * 从索引中查询匹配的文件
 * @param {string} diskRoot - 磁盘根路径
 * @param {string} pattern - 匹配模式（文件名/路径片段）
 * @returns {Array<{fileName: string, fullPath: string, fileSize: number, modifiedTime: string, fileType: string}>}
 */
export function queryFileIndex(diskRoot, pattern) {
  if (!db) throw new Error('数据库未初始化');

  // 标准化路径：统一用 normalizePath（小写 + 反斜杠结尾）
  const normalizedRoot = normalizePath(diskRoot);
  const normalizedPattern = pattern.replace(/\\/g, '/').toLowerCase();
  let results = [];

  // 根据 pattern 构建查询
  if (normalizedPattern.includes('/') || normalizedPattern.includes('\\')) {
    // 路径匹配：在 full_path 中搜索
    const pathParts = normalizedPattern.split('/').filter(Boolean);
    const likePattern = '%' + pathParts.join('%') + '%';
    const stmt = db.prepare(
      `SELECT file_name, full_path, file_size, modified_time, file_type
       FROM file_index
       WHERE disk_root = '${escapeSql(normalizedRoot)}'
         AND is_valid = 1
         AND lower(full_path) LIKE '${escapeSql(likePattern)}'`
    );

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        fileName: row.file_name,
        fullPath: row.full_path,
        fileSize: row.file_size,
        modifiedTime: row.modified_time,
        fileType: row.file_type
      });
    }
    stmt.free();
  } else if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
    // 通配符匹配：转换为 SQL LIKE
    const likePattern = normalizedPattern.replace(/\*/g, '%').replace(/\?/g, '_');
    const stmt = db.prepare(
      `SELECT file_name, full_path, file_size, modified_time, file_type
       FROM file_index
       WHERE disk_root = '${escapeSql(normalizedRoot)}'
         AND is_valid = 1
         AND lower(file_name) LIKE '${escapeSql(likePattern)}'`
    );

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        fileName: row.file_name,
        fullPath: row.full_path,
        fileSize: row.file_size,
        modifiedTime: row.modified_time,
        fileType: row.file_type
      });
    }
    stmt.free();
  } else {
    // 名称模糊匹配：文件名或路径中包含 pattern
    const stmt = db.prepare(
      `SELECT file_name, full_path, file_size, modified_time, file_type
       FROM file_index
       WHERE disk_root = '${escapeSql(normalizedRoot)}'
         AND is_valid = 1
         AND (lower(file_name) LIKE '%${escapeSql(normalizedPattern)}%'
              OR lower(full_path) LIKE '%${escapeSql(normalizedPattern)}%')`
    );

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        fileName: row.file_name,
        fullPath: row.full_path,
        fileSize: row.file_size,
        modifiedTime: row.modified_time,
        fileType: row.file_type
      });
    }
    stmt.free();
  }

  // 过滤只保留目标文件类型
  results = results.filter(f => TARGET_EXTENSIONS.has(f.fileType?.toLowerCase()));

  return results;
}

/**
 * 获取索引统计信息
 * @param {string} diskRoot - 磁盘根路径
 */
export function getIndexStats(diskRoot) {
  if (!db) return null;

  // 标准化路径：统一用 normalizePath（小写 + 反斜杠结尾）
  const normalizedRoot = normalizePath(diskRoot);

  const result = db.exec(
    `SELECT
       COUNT(*) as total_files,
       COUNT(DISTINCT file_type) as file_types,
       SUM(file_size) as total_size,
       MIN(scan_time) as first_scan,
       MAX(scan_time) as last_scan
     FROM file_index
     WHERE disk_root = '${escapeSql(normalizedRoot)}' AND is_valid = 1`
  );

  if (result.length > 0 && result[0].values.length > 0) {
    const [totalFiles, fileTypes, totalSize, firstScan, lastScan] = result[0].values[0];
    return {
      totalFiles,
      fileTypes,
      totalSizeMB: Math.round((totalSize || 0) / (1024 * 1024) * 10) / 10,
      firstScan,
      lastScan
    };
  }

  return null;
}

/**
 * 检查索引是否是最新的（磁盘是否有新文件）
 * @param {string} diskRoot
 * @returns {boolean}
 */
export function isIndexFresh(diskRoot) {
  if (!db) return false;

  // 标准化路径：统一用 normalizePath（小写 + 反斜杠结尾）
  const normalizedRoot = normalizePath(diskRoot);

  const result = db.exec(
    `SELECT MAX(scan_time) FROM file_index WHERE disk_root = '${escapeSql(normalizedRoot)}' AND is_valid = 1`
  );

  if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0]) {
    const lastScan = new Date(result[0].values[0][0] + 'Z');
    const now = new Date();
    // 索引在 24 小时内视为有效
    return (now - lastScan) < 86400000;
  }

  return false;
}

/**
 * 关闭数据库
 */
export function closeFileIndex() {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
  }
}

/**
 * SQL 字符串转义
 */
function escapeSql(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "''");
}
