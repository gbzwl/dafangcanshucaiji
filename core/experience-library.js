import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

let db = null;
const DB_PATH = path.join(process.cwd(), 'temp', 'experience.db');

// 厂商和设备类型预设
const VENDOR_DEVICES = {
  'Siemens': ['MRI', 'CT', 'X-Ray', 'Ultrasound'],
  'GE': ['MRI', 'CT', 'X-Ray', 'Ultrasound', 'PET-CT'],
  'Philips': ['MRI', 'CT', 'X-Ray', 'Ultrasound'],
  'United Imaging': ['MRI', 'CT', 'X-Ray', 'PET-CT'],
  'Canon': ['CT', 'X-Ray', 'Ultrasound'],
  'Hitachi': ['MRI', 'CT', 'Ultrasound'],
  'Toshiba': ['CT', 'X-Ray', 'Ultrasound'],
  '其他': ['MRI', 'CT', 'X-Ray', 'Ultrasound', '其他']
};

/**
 * 初始化经验库数据库
 */
export async function initExperienceDB() {
  try {
    const SQL = await initSqlJs();
    const tempDir = path.join(process.cwd(), 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    // 创建采集记录表
    db.run(`
      CREATE TABLE IF NOT EXISTS collection_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor TEXT NOT NULL,
        device_type TEXT NOT NULL,
        model TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        indicator_count INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        notes TEXT DEFAULT ''
      )
    `);

    // 创建采集规则表
    db.run(`
      CREATE TABLE IF NOT EXISTS collection_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id INTEGER NOT NULL,
        indicator TEXT NOT NULL,
        file_pattern TEXT DEFAULT '',
        keyword TEXT DEFAULT '',
        synonyms TEXT DEFAULT '',
        actual_path TEXT DEFAULT '',
        match_method TEXT DEFAULT '',
        confidence INTEGER DEFAULT 0,
        FOREIGN KEY (record_id) REFERENCES collection_records(id) ON DELETE CASCADE
      )
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_rules_record ON collection_rules(record_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_records_vendor ON collection_records(vendor, device_type)');

    saveDB();
    console.log('采集经验库已初始化');
    return true;
  } catch (err) {
    console.error('经验库初始化失败:', err.message);
    return false;
  }
}

function saveDB() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

/**
 * 获取厂商和设备类型列表
 */
export function getVendorDevices() {
  return VENDOR_DEVICES;
}

/**
 * 保存采集记录
 */
export function saveCollectionRecord(data) {
  if (!db) throw new Error('经验库未初始化');

  const {
    vendor,
    deviceType,
    model = '',
    rules = [],
    successRate = 0,
    notes = ''
  } = data;

  if (!vendor || !deviceType) {
    throw new Error('厂商和设备类型不能为空');
  }

  const indicatorCount = rules.length;

  // 插入记录
  const stmt = db.prepare(`
    INSERT INTO collection_records (vendor, device_type, model, indicator_count, success_rate, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run([vendor, deviceType, model, indicatorCount, successRate, notes]);
  stmt.free();

  const recordId = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];

  // 插入规则
  if (rules.length > 0) {
    const ruleStmt = db.prepare(`
      INSERT INTO collection_rules (record_id, indicator, file_pattern, keyword, synonyms, actual_path, match_method, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rule of rules) {
      ruleStmt.run([
        recordId,
        rule.indicator || '',
        rule.filePattern || rule.file_pattern || '',
        rule.keyword || '',
        rule.synonyms ? (Array.isArray(rule.synonyms) ? rule.synonyms.join(';') : rule.synonyms) : '',
        rule.actualPath || rule.actual_path || '',
        rule.matchMethod || rule.match_method || '',
        rule.confidence || 0
      ]);
    }
    ruleStmt.free();
  }

  saveDB();
  return { id: recordId, vendor, deviceType, model, indicatorCount };
}

/**
 * 获取所有采集记录
 */
export function getAllRecords(filters = {}) {
  if (!db) throw new Error('经验库未初始化');

  let query = `
    SELECT id, vendor, device_type, model, created_at, updated_at, indicator_count, success_rate, notes
    FROM collection_records
    WHERE 1=1
  `;
  const params = [];

  if (filters.vendor) {
    query += ' AND vendor = ?';
    params.push(filters.vendor);
  }
  if (filters.deviceType) {
    query += ' AND device_type = ?';
    params.push(filters.deviceType);
  }
  if (filters.keyword) {
    query += ' AND (vendor LIKE ? OR device_type LIKE ? OR model LIKE ? OR notes LIKE ?)';
    const kw = `%${filters.keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  query += ' ORDER BY updated_at DESC';

  const result = db.exec(query, params);
  if (result.length === 0) return [];

  const columns = result[0].columns;
  return result[0].values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    // Map snake_case to camelCase for frontend
    return {
      id: obj.id,
      vendor: obj.vendor,
      deviceType: obj.device_type,
      model: obj.model,
      indicatorCount: obj.indicator_count,
      successRate: obj.success_rate,
      notes: obj.notes,
      savedAt: obj.created_at,
      updatedAt: obj.updated_at
    };
  });
}

/**
 * 获取单条记录详情（含规则）
 */
export function getRecordDetail(recordId) {
  if (!db) throw new Error('经验库未初始化');

  // 获取记录
  const recordResult = db.exec(
    'SELECT * FROM collection_records WHERE id = ?',
    [recordId]
  );

  if (recordResult.length === 0) return null;

  const columns = recordResult[0].columns;
  const rawRecord = {};
  recordResult[0].values[0].forEach((val, i) => { rawRecord[columns[i]] = val; });

  const record = {
    id: rawRecord.id,
    vendor: rawRecord.vendor,
    deviceType: rawRecord.device_type,
    model: rawRecord.model,
    indicatorCount: rawRecord.indicator_count,
    successRate: rawRecord.success_rate,
    notes: rawRecord.notes,
    savedAt: rawRecord.created_at,
    updatedAt: rawRecord.updated_at
  };

  // 获取规则
  const rulesResult = db.exec(
    'SELECT * FROM collection_rules WHERE record_id = ?',
    [recordId]
  );

  const rules = [];
  if (rulesResult.length > 0) {
    const ruleColumns = rulesResult[0].columns;
    rulesResult[0].values.forEach(row => {
      const obj = {};
      ruleColumns.forEach((col, i) => { obj[col] = row[i]; });
      // Map rule columns to camelCase
      rules.push({
        id: obj.id,
        record_id: obj.record_id,
        indicator: obj.indicator,
        filePattern: obj.file_pattern,
        keyword: obj.keyword,
        synonyms: obj.synonyms,
        actualPath: obj.actual_path,
        matchMethod: obj.match_method,
        confidence: obj.confidence
      });
    });
  }

  return { ...record, rules };
}

/**
 * 根据厂商和设备类型查找最匹配的记录
 */
export function findMatchingRecords(vendor, deviceType) {
  if (!db) throw new Error('经验库未初始化');

  // 优先级：完全匹配 > 类型匹配 > 厂商匹配
  const results = {
    exact: [],      // 同厂商 + 同设备类型
    vendor: [],     // 同厂商
    all: []         // 所有记录
  };

  const allRecords = getAllRecords();

  // Helper to load rules for a record
  function loadRules(recordId) {
    const rulesResult = db.exec(
      'SELECT * FROM collection_rules WHERE record_id = ?',
      [recordId]
    );
    const rules = [];
    if (rulesResult.length > 0) {
      const ruleColumns = rulesResult[0].columns;
      rulesResult[0].values.forEach(row => {
        const obj = {};
        ruleColumns.forEach((col, i) => { obj[col] = row[i]; });
        rules.push({
          indicator: obj.indicator,
          filePattern: obj.file_pattern,
          keyword: obj.keyword,
          synonyms: obj.synonyms,
          actualPath: obj.actual_path,
          matchMethod: obj.match_method,
          confidence: obj.confidence
        });
      });
    }
    return rules;
  }

  for (const record of allRecords) {
    const recordWithRules = { ...record, rules: loadRules(record.id) };
    if (record.vendor === vendor && record.deviceType === deviceType) {
      results.exact.push(recordWithRules);
    }
    if (record.vendor === vendor) {
      results.vendor.push(recordWithRules);
    }
    results.all.push(recordWithRules);
  }

  return results;
}

/**
 * 更新采集记录
 */
export function updateRecord(recordId, data) {
  if (!db) throw new Error('经验库未初始化');

  const fields = [];
  const params = [];

  if (data.vendor !== undefined) { fields.push('vendor = ?'); params.push(data.vendor); }
  if (data.deviceType !== undefined) { fields.push('device_type = ?'); params.push(data.deviceType); }
  if (data.model !== undefined) { fields.push('model = ?'); params.push(data.model); }
  if (data.notes !== undefined) { fields.push('notes = ?'); params.push(data.notes); }
  if (data.indicatorCount !== undefined) { fields.push('indicator_count = ?'); params.push(data.indicatorCount); }
  if (data.successRate !== undefined) { fields.push('success_rate = ?'); params.push(data.successRate); }

  if (fields.length === 0) return false;

  fields.push("updated_at = datetime('now', 'localtime')");
  params.push(recordId);

  db.run(`UPDATE collection_records SET ${fields.join(', ')} WHERE id = ?`, params);

  // 如果提供了新规则，先删除旧规则再插入
  if (data.rules) {
    db.run('DELETE FROM collection_rules WHERE record_id = ?', [recordId]);

    if (data.rules.length > 0) {
      const ruleStmt = db.prepare(`
        INSERT INTO collection_rules (record_id, indicator, file_pattern, keyword, synonyms, actual_path, match_method, confidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const rule of data.rules) {
        ruleStmt.run([
          recordId,
          rule.indicator || '',
          rule.filePattern || rule.file_pattern || '',
          rule.keyword || '',
          rule.synonyms ? (Array.isArray(rule.synonyms) ? rule.synonyms.join(';') : rule.synonyms) : '',
          rule.actualPath || rule.actual_path || '',
          rule.matchMethod || rule.match_method || '',
          rule.confidence || 0
        ]);
      }
      ruleStmt.free();
    }
  }

  saveDB();
  return true;
}

/**
 * 删除采集记录
 */
export function deleteRecord(recordId) {
  if (!db) throw new Error('经验库未初始化');

  db.run('DELETE FROM collection_rules WHERE record_id = ?', [recordId]);
  db.run('DELETE FROM collection_records WHERE id = ?', [recordId]);
  saveDB();
  return true;
}

/**
 * 批量删除记录
 */
export function deleteRecords(recordIds) {
  if (!db) throw new Error('经验库未初始化');

  for (const id of recordIds) {
    db.run('DELETE FROM collection_rules WHERE record_id = ?', [id]);
    db.run('DELETE FROM collection_records WHERE id = ?', [id]);
  }
  saveDB();
  return true;
}
