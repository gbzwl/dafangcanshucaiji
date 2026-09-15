import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

let db = null;
let dbPath = '';

/**
 * 初始化经验库数据库
 */
export async function initExperienceDB(dataDir = path.join(process.cwd(), 'temp')) {
  try {
    const SQL = await initSqlJs();
    const tempDir = path.resolve(dataDir);
    dbPath = path.join(tempDir, 'experience.db');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
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
        keyword_meaning TEXT DEFAULT '',
        actual_path TEXT DEFAULT '',
        match_method TEXT DEFAULT '',
        confidence INTEGER DEFAULT 0,
        FOREIGN KEY (record_id) REFERENCES collection_records(id) ON DELETE CASCADE
      )
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_rules_record ON collection_rules(record_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_records_vendor ON collection_records(vendor, device_type)');
    ensureColumn('collection_rules', 'keyword_meaning', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'indicator_code', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'value', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'evidence', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'data_timestamp', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'file_mtime', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'evidence_level', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'status', "TEXT DEFAULT ''");
    ensureColumn('collection_rules', 'source_type', "TEXT DEFAULT 'collection_result'");

    db.run(`
      CREATE TABLE IF NOT EXISTS raw_experience (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor TEXT DEFAULT '',
        device_type TEXT DEFAULT '',
        model TEXT DEFAULT '',
        source_file TEXT DEFAULT '',
        source_sheet TEXT DEFAULT '',
        row_number INTEGER DEFAULT 0,
        indicator_name TEXT DEFAULT '',
        indicator_code TEXT DEFAULT '',
        file_path_raw TEXT DEFAULT '',
        path_fragments TEXT DEFAULT '',
        file_names TEXT DEFAULT '',
        extensions TEXT DEFAULT '',
        keyword_meaning_raw TEXT DEFAULT '',
        data_source_raw TEXT DEFAULT '',
        note_raw TEXT DEFAULT '',
        imported_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_raw_exp_device ON raw_experience(vendor, device_type, model)');
    db.run('CREATE INDEX IF NOT EXISTS idx_raw_exp_indicator ON raw_experience(indicator_name, indicator_code)');
    ensureColumn('raw_experience', 'value', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'matched_keyword', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'evidence', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'data_timestamp', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'file_mtime', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'evidence_level', "TEXT DEFAULT ''");
    ensureColumn('raw_experience', 'confidence', "INTEGER DEFAULT 0");
    ensureColumn('raw_experience', 'status', "TEXT DEFAULT 'historical_import'");

    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_experience_id INTEGER,
        source_record_id INTEGER,
        vendor TEXT DEFAULT '',
        device_type TEXT DEFAULT '',
        model TEXT DEFAULT '',
        indicator_name TEXT DEFAULT '',
        indicator_code TEXT DEFAULT '',
        rule_type TEXT DEFAULT 'unknown',
        parser_type TEXT DEFAULT '',
        file_patterns TEXT DEFAULT '[]',
        file_name_patterns TEXT DEFAULT '[]',
        keywords TEXT DEFAULT '[]',
        selector TEXT DEFAULT '',
        operation TEXT DEFAULT '',
        value_pattern TEXT DEFAULT '',
        meaning TEXT DEFAULT '',
        evidence_example TEXT DEFAULT '',
        ai_reason TEXT DEFAULT '',
        confidence INTEGER DEFAULT 0,
        status TEXT DEFAULT 'draft',
        validation_status TEXT DEFAULT '',
        validated_confidence INTEGER DEFAULT 0,
        validated_file_path TEXT DEFAULT '',
        validated_evidence TEXT DEFAULT '',
        validated_at TEXT DEFAULT '',
        created_by TEXT DEFAULT 'ai',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);
    ensureColumn('knowledge_candidates', 'validation_status', "TEXT DEFAULT ''");
    ensureColumn('knowledge_candidates', 'source_record_id', 'INTEGER');
    ensureColumn('knowledge_candidates', 'validated_confidence', "INTEGER DEFAULT 0");
    ensureColumn('knowledge_candidates', 'validated_file_path', "TEXT DEFAULT ''");
    ensureColumn('knowledge_candidates', 'validated_evidence', "TEXT DEFAULT ''");
    ensureColumn('knowledge_candidates', 'validated_at', "TEXT DEFAULT ''");
    db.run('CREATE INDEX IF NOT EXISTS idx_candidates_raw ON knowledge_candidates(raw_experience_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_candidates_device ON knowledge_candidates(vendor, device_type, model)');
    db.run('CREATE INDEX IF NOT EXISTS idx_candidates_indicator ON knowledge_candidates(indicator_name, indicator_code)');

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
    fs.writeFileSync(dbPath, buffer);
  }
}

function ensureColumn(tableName, columnName, definition) {
  const info = db.exec(`PRAGMA table_info(${tableName})`);
  const columns = info[0]?.values?.map(row => row[1]) || [];
  if (!columns.includes(columnName)) {
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function importRawExperienceWorkbook(buffer, options = {}) {
  if (!db) throw new Error('经验库未初始化');

  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const imported = [];
  const stmt = db.prepare(`
    INSERT INTO raw_experience (
      vendor, device_type, model, source_file, source_sheet, row_number,
      indicator_name, indicator_code, file_path_raw, path_fragments,
      file_names, extensions, keyword_meaning_raw, data_source_raw, note_raw,
      value, matched_keyword, evidence, data_timestamp, file_mtime, evidence_level, confidence, status
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.run('BEGIN TRANSACTION');
  try {
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      const headerInfo = findRawExperienceHeader(rows);
      if (!headerInfo) continue;

      const { headerRow, columns } = headerInfo;
      for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i] || [];
        const indicatorName = cell(row, columns.indicatorName);
        const filePathRaw = combineDirectoryAndFileName(
          cell(row, columns.filePath),
          cell(row, columns.fileName)
        );
        const keywordMeaningRaw = cell(row, columns.keywordMeaning);
        const indicatorCode = cell(row, columns.indicatorCode);
        const dataSourceRaw = cell(row, columns.dataSource);
        const noteRaw = cell(row, columns.note);
        const value = cell(row, columns.value);
        const matchedKeyword = cell(row, columns.matchedKeyword);
        const evidence = cell(row, columns.evidence);
        const dataTimestamp = cell(row, columns.dataTimestamp);
        const fileMtime = cell(row, columns.fileMtime);
        const evidenceLevel = cell(row, columns.evidenceLevel);
        const confidence = Number(cell(row, columns.confidence)) || 0;
        const status = cell(row, columns.status) || 'historical_import';

        if (!indicatorName && !filePathRaw && !keywordMeaningRaw) continue;

        const pathInfo = splitExperiencePaths(filePathRaw);
        const sheetDeviceType = inferDeviceTypeFromSheet(sheetName) || options.deviceType || '';
        const record = {
          vendor: options.vendor || '',
          deviceType: sheetDeviceType,
          model: options.model || '',
          sourceFile: options.sourceFile || '',
          sourceSheet: sheetName,
          rowNumber: i + 1,
          indicatorName,
          indicatorCode,
          filePathRaw,
          pathFragments: pathInfo.pathFragments,
          fileNames: pathInfo.fileNames,
          extensions: pathInfo.extensions,
          keywordMeaningRaw,
          dataSourceRaw,
          noteRaw, value, matchedKeyword, evidence, dataTimestamp, fileMtime,
          evidenceLevel, confidence, status
        };

        stmt.run([
          record.vendor,
          record.deviceType,
          record.model,
          record.sourceFile,
          record.sourceSheet,
          record.rowNumber,
          record.indicatorName,
          record.indicatorCode,
          record.filePathRaw,
          record.pathFragments.join('\n'),
          record.fileNames.join('\n'),
          record.extensions.join('\n'),
          record.keywordMeaningRaw,
          record.dataSourceRaw,
          record.noteRaw, record.value, record.matchedKeyword, record.evidence,
          record.dataTimestamp, record.fileMtime, record.evidenceLevel,
          record.confidence, record.status
        ]);
        record.id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
        imported.push(record);
      }
    }

    db.run('COMMIT');
    stmt.free();
    saveDB();
  } catch (error) {
    db.run('ROLLBACK');
    stmt.free();
    throw error;
  }

  return {
    count: imported.length,
    sheets: workbook.SheetNames,
    records: imported
  };
}

export function getRawExperienceRecords(filters = {}) {
  if (!db) throw new Error('经验库未初始化');

  let query = 'SELECT * FROM raw_experience WHERE 1=1';
  const params = [];
  if (filters.vendor) {
    query += " AND (vendor = ? OR vendor = '')";
    params.push(filters.vendor);
  }
  if (filters.deviceType) {
    const normalizedType = String(filters.deviceType).toUpperCase() === 'MRI' ? 'MR' : String(filters.deviceType).toUpperCase();
    if (normalizedType === 'MR') {
      query += " AND UPPER(device_type) IN ('MR', 'MRI')";
    } else {
      query += ' AND UPPER(device_type) = ?';
      params.push(normalizedType);
    }
  }
  if (filters.model) {
    query += " AND (model = ? OR model = '')";
    params.push(filters.model);
  }
  if (filters.indicator) {
    query += ' AND (indicator_name LIKE ? OR indicator_code LIKE ?)';
    params.push(`%${filters.indicator}%`, `%${filters.indicator}%`);
  }
  if (filters.sourceFile) {
    query += ' AND source_file = ?';
    params.push(filters.sourceFile);
  }
  if (filters.importedAt) {
    query += ' AND imported_at = ?';
    params.push(filters.importedAt);
  }

  query += ' ORDER BY imported_at DESC, id DESC';
  if (filters.limit) query += ` LIMIT ${Math.max(1, Number(filters.limit) || 100)}`;

  const result = db.exec(query, params);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => mapRawExperienceRow(columns, row));
}

export function clearRawExperienceRecords(filters = {}) {
  if (!db) throw new Error('经验库未初始化');
  const clauses = [];
  const params = [];
  if (filters.vendor) {
    clauses.push('vendor = ?');
    params.push(filters.vendor);
  }
  if (filters.deviceType) {
    clauses.push('device_type = ?');
    params.push(filters.deviceType);
  }
  if (filters.model) {
    clauses.push('model = ?');
    params.push(filters.model);
  }
  if (filters.sourceFile) {
    clauses.push('source_file = ?');
    params.push(filters.sourceFile);
  }
  if (filters.importedAt) {
    clauses.push('imported_at = ?');
    params.push(filters.importedAt);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  db.run(`DELETE FROM raw_experience${where}`, params);
  saveDB();
  return true;
}

export function getRawExperienceByIds(ids = []) {
  if (!db) throw new Error('经验库未初始化');
  const normalizedIds = ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0);
  if (normalizedIds.length === 0) return [];

  const placeholders = normalizedIds.map(() => '?').join(',');
  const result = db.exec(`SELECT * FROM raw_experience WHERE id IN (${placeholders})`, normalizedIds);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => mapRawExperienceRow(columns, row));
}

export function updateRawExperienceRecord(id, updates = {}) {
  if (!db) throw new Error('经验库未初始化');
  const recordId = Number(id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    throw new Error('旧表记录 ID 无效');
  }

  const current = getRawExperienceByIds([recordId])[0];
  if (!current) throw new Error('旧表记录不存在');

  const next = {
    indicatorName: updates.indicatorName ?? updates.indicator_name ?? current.indicatorName,
    indicatorCode: updates.indicatorCode ?? updates.indicator_code ?? current.indicatorCode,
    filePathRaw: updates.filePathRaw ?? updates.file_path_raw ?? current.filePathRaw,
    keywordMeaningRaw: updates.keywordMeaningRaw ?? updates.keyword_meaning_raw ?? current.keywordMeaningRaw,
    dataSourceRaw: updates.dataSourceRaw ?? updates.data_source_raw ?? current.dataSourceRaw,
    noteRaw: updates.noteRaw ?? updates.note_raw ?? current.noteRaw,
    value: updates.value ?? current.value,
    matchedKeyword: updates.matchedKeyword ?? updates.matched_keyword ?? current.matchedKeyword,
    evidence: updates.evidence ?? current.evidence,
    dataTimestamp: updates.dataTimestamp ?? updates.data_timestamp ?? current.dataTimestamp,
    fileMtime: updates.fileMtime ?? updates.file_mtime ?? current.fileMtime,
    evidenceLevel: updates.evidenceLevel ?? updates.evidence_level ?? current.evidenceLevel,
    confidence: updates.confidence ?? current.confidence,
    status: updates.status ?? current.status
  };
  const pathInfo = splitExperiencePaths(next.filePathRaw);

  db.run(`
    UPDATE raw_experience
    SET indicator_name = ?,
        indicator_code = ?,
        file_path_raw = ?,
        path_fragments = ?,
        file_names = ?,
        extensions = ?,
        keyword_meaning_raw = ?,
        data_source_raw = ?,
        note_raw = ?, value = ?, matched_keyword = ?, evidence = ?, data_timestamp = ?,
        file_mtime = ?, evidence_level = ?, confidence = ?, status = ?
    WHERE id = ?
  `, [
    String(next.indicatorName || '').trim(),
    String(next.indicatorCode || '').trim(),
    String(next.filePathRaw || '').trim(),
    pathInfo.pathFragments.join('\n'),
    pathInfo.fileNames.join('\n'),
    pathInfo.extensions.join('\n'),
    String(next.keywordMeaningRaw || '').trim(),
    String(next.dataSourceRaw || '').trim(),
    String(next.noteRaw || '').trim(),
    String(next.value || '').trim(), String(next.matchedKeyword || '').trim(),
    String(next.evidence || '').trim(), String(next.dataTimestamp || '').trim(),
    String(next.fileMtime || '').trim(), String(next.evidenceLevel || '').trim(),
    clamp(Number(next.confidence || 0), 0, 100), String(next.status || 'historical_import').trim(),
    recordId
  ]);

  saveDB();
  return getRawExperienceByIds([recordId])[0] || null;
}

export function saveKnowledgeCandidate(candidate = {}) {
  if (!db) throw new Error('经验库未初始化');

  const normalized = normalizeKnowledgeCandidate(candidate);
  const stmt = db.prepare(`
    INSERT INTO knowledge_candidates (
      raw_experience_id, source_record_id, vendor, device_type, model, indicator_name, indicator_code,
      rule_type, parser_type, file_patterns, file_name_patterns, keywords,
      selector, operation, value_pattern, meaning, evidence_example,
      ai_reason, confidence, status, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run([
    normalized.rawExperienceId,
    normalized.sourceRecordId,
    normalized.vendor,
    normalized.deviceType,
    normalized.model,
    normalized.indicatorName,
    normalized.indicatorCode,
    normalized.ruleType,
    normalized.parserType,
    JSON.stringify(normalized.filePatterns),
    JSON.stringify(normalized.fileNamePatterns),
    JSON.stringify(normalized.keywords),
    normalized.selector,
    normalized.operation,
    normalized.valuePattern,
    normalized.meaning,
    normalized.evidenceExample,
    normalized.aiReason,
    normalized.confidence,
    normalized.status,
    normalized.createdBy
  ]);
  stmt.free();

  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  saveDB();
  return { id, ...normalized };
}

export function getKnowledgeCandidates(filters = {}) {
  if (!db) throw new Error('经验库未初始化');

  let query = 'SELECT * FROM knowledge_candidates WHERE 1=1';
  const params = [];
  if (filters.vendor) {
    query += ' AND vendor = ?';
    params.push(filters.vendor);
  }
  if (filters.deviceType) {
    query += ' AND device_type = ?';
    params.push(filters.deviceType);
  }
  if (filters.model) {
    query += ' AND model = ?';
    params.push(filters.model);
  }
  if (filters.indicator) {
    query += ' AND (indicator_name LIKE ? OR indicator_code LIKE ?)';
    params.push(`%${filters.indicator}%`, `%${filters.indicator}%`);
  }
  if (filters.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters.validationStatus) {
    query += ' AND validation_status = ?';
    params.push(filters.validationStatus);
  }
  if (filters.rawExperienceId) {
    query += ' AND raw_experience_id = ?';
    params.push(Number(filters.rawExperienceId));
  }
  if (filters.sourceRecordId) {
    query += ' AND source_record_id = ?';
    params.push(Number(filters.sourceRecordId));
  }

  query += ' ORDER BY updated_at DESC, id DESC';
  if (filters.limit) query += ` LIMIT ${Math.max(1, Number(filters.limit) || 100)}`;

  const result = db.exec(query, params);
  if (result.length === 0) return [];
  const columns = result[0].columns;
  return result[0].values.map(row => mapKnowledgeCandidateRow(columns, row));
}

export function clearKnowledgeCandidates(filters = {}) {
  if (!db) throw new Error('经验库未初始化');
  const clauses = [];
  const params = [];
  if (filters.rawExperienceId) {
    clauses.push('raw_experience_id = ?');
    params.push(Number(filters.rawExperienceId));
  }
  if (filters.sourceRecordId) {
    clauses.push('source_record_id = ?');
    params.push(Number(filters.sourceRecordId));
  }
  if (filters.vendor) {
    clauses.push('vendor = ?');
    params.push(filters.vendor);
  }
  if (filters.deviceType) {
    clauses.push('device_type = ?');
    params.push(filters.deviceType);
  }
  if (filters.model) {
    clauses.push('model = ?');
    params.push(filters.model);
  }
  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  db.run(`DELETE FROM knowledge_candidates${where}`, params);
  saveDB();
  return true;
}

function findRawExperienceHeader(rows) {
  const aliases = {
    indicatorName: ['基础数据指标', '数据指标', '指标名称', '指标'],
    filePath: ['文件路径', '目录', '路径', '参考文件'],
    keywordMeaning: ['关键字及含义', '关键字段及含义', '关键字和含义', '含义'],
    indicatorCode: ['指标标识', '指标编码', '字段标识', '英文名'],
    dataSource: ['数据更新来源', '来源', '采集来源'],
    note: ['备注', '说明']
  };
  aliases.value = ['采集值', '结果值', '参数值', '值'];
  aliases.matchedKeyword = ['匹配关键字', '关键字', '关键词'];
  aliases.evidence = ['证据内容', '匹配行内容', '匹配行', '原始证据'];
  aliases.dataTimestamp = ['数据时间', '数据时间戳'];
  aliases.fileMtime = ['文件修改时间', '文件时间'];
  aliases.evidenceLevel = ['证据等级', '证据级别'];
  aliases.confidence = ['置信度', '可信度'];
  aliases.status = ['状态', '结果状态'];

  aliases.fileName = ['文件名', '文件', '日志文件', '参考文件名', 'file', 'filename', 'file name'];
  aliases.indicatorName.push('采集参数', '参数', '参数名称', '基础数据指标');
  aliases.filePath.push('目录路径', '所在目录', '日志目录');
  aliases.keywordMeaning.push('关键字段及含义', '关键字段和含义', '关键字段说明', '关键字及含义', '关键字和含义', '结果描述', '证据摘要');
  aliases.indicatorCode.push('英文名', '字段名', '指标英文名', '指标代码');

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex].map(value => String(value || '').trim());
    const columns = {};
    for (const [field, names] of Object.entries(aliases)) {
      const index = findRawHeaderIndex(row, names, field);
      if (index >= 0) columns[field] = index;
    }
    if (columns.indicatorName !== undefined && (columns.filePath !== undefined || columns.fileName !== undefined || columns.keywordMeaning !== undefined)) {
      return { headerRow: rowIndex, columns };
    }
  }
  return null;
}

function findRawHeaderIndex(row, aliases, field) {
  const exactIndex = row.findIndex(value => aliases.includes(value));
  if (exactIndex >= 0) return exactIndex;
  return row.findIndex(value => isRawHeaderMatch(value, field));
}

function isRawHeaderMatch(value, field) {
  const text = String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!text) return false;

  if (field === 'indicatorName') {
    return text.includes('采集参数') || text.includes('基础数据指标') || text === '指标' || text.includes('指标名称') || text.includes('参数名称');
  }
  if (field === 'indicatorCode') {
    return text.includes('指标标识') || text.includes('指标编码') || text.includes('指标代码') || text.includes('英文名') || text.includes('字段名');
  }
  if (field === 'filePath') {
    return text.includes('文件路径') || text === '目录' || text.includes('目录路径') || text.includes('所在目录') || text === '路径';
  }
  if (field === 'fileName') {
    return text === '文件名' || text === '文件' || text.includes('日志文件') || text.includes('参考文件名') || text === 'filename' || text === 'file';
  }
  if (field === 'keywordMeaning') {
    return text.includes('关键字段及含义')
      || text.includes('关键字段和含义')
      || text.includes('关键字及含义')
      || text.includes('关键字和含义')
      || (text.includes('关键') && (text.includes('含义') || text.includes('说明') || text.includes('描述')))
      || text.includes('结果描述')
      || text.includes('证据摘要');
  }
  if (field === 'dataSource') {
    return text.includes('数据来源') || text.includes('采集来源') || text.includes('更新来源');
  }
  if (field === 'note') {
    return text === '备注' || text === '说明';
  }
  if (field === 'value') return text === '采集值' || text === '结果值' || text === '参数值' || text === '值';
  if (field === 'matchedKeyword') return text === '匹配关键字' || text === '关键字' || text === '关键词';
  if (field === 'evidence') return text.includes('证据内容') || text.includes('匹配行内容') || text === '匹配行' || text.includes('原始证据');
  if (field === 'dataTimestamp') return text === '数据时间' || text.includes('数据时间戳');
  if (field === 'fileMtime') return text.includes('文件修改时间') || text === '文件时间';
  if (field === 'evidenceLevel') return text.includes('证据等级') || text.includes('证据级别');
  if (field === 'confidence') return text.includes('置信度') || text.includes('可信度');
  if (field === 'status') return text === '状态' || text.includes('结果状态');
  return false;
}

function inferDeviceTypeFromSheet(sheetName) {
  const normalized = String(sheetName || '').trim().toUpperCase();
  const knownTypes = ['CT', 'MR', 'MRI', 'DSA', 'DR', 'PET-CT', 'ULTRASOUND'];
  return knownTypes.includes(normalized) ? normalized : '';
}

function combineDirectoryAndFileName(directoryValue, fileNameValue) {
  const directory = String(directoryValue || '').trim();
  const fileName = String(fileNameValue || '').trim();
  if (!directory) return fileName;
  if (!fileName) return directory;
  if (/^[a-z]:[\\/]/i.test(fileName) || fileName.startsWith('\\\\') || fileName.startsWith('/')) {
    return fileName;
  }

  return directory
    .split(/\r?\n|;|；/)
    .map(dir => dir.trim())
    .filter(Boolean)
    .flatMap(dir => fileName
      .split(/\r?\n|;|；/)
      .map(name => name.trim())
      .filter(Boolean)
      .map(name => {
        if (dir.endsWith('\\') || dir.endsWith('/')) return `${dir}${name}`;
        const separator = dir.includes('\\') ? '\\' : '/';
        return `${dir}${separator}${name}`;
      })
    )
    .join('\n');
}

function splitExperiencePaths(value) {
  const paths = String(value || '')
    .split(/\r?\n|;|；/)
    .map(item => item.trim())
    .filter(Boolean);
  const pathFragments = [];
  const fileNames = [];
  const extensions = [];

  for (const item of paths) {
    const normalized = item.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    const withoutDrive = normalized.replace(/^[a-z]:\//i, '');
    pathFragments.push(withoutDrive);
    const fileName = path.posix.basename(withoutDrive);
    if (fileName && fileName !== '.' && fileName !== '/') fileNames.push(fileName);
    const ext = path.posix.extname(fileName.replace(/\.gz$/i, ''));
    if (ext) extensions.push(ext.toLowerCase());
    if (/\.gz$/i.test(fileName)) extensions.push('.gz');
  }

  return {
    pathFragments: unique(pathFragments),
    fileNames: unique(fileNames),
    extensions: unique(extensions)
  };
}

function mapRawExperienceRow(columns, row) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return {
    id: obj.id,
    vendor: obj.vendor,
    deviceType: obj.device_type,
    model: obj.model,
    sourceFile: obj.source_file,
    sourceSheet: obj.source_sheet,
    rowNumber: obj.row_number,
    indicatorName: obj.indicator_name,
    indicatorCode: obj.indicator_code,
    filePathRaw: obj.file_path_raw,
    pathFragments: splitStoredList(obj.path_fragments),
    fileNames: splitStoredList(obj.file_names),
    extensions: splitStoredList(obj.extensions),
    keywordMeaningRaw: obj.keyword_meaning_raw,
    dataSourceRaw: obj.data_source_raw,
    noteRaw: obj.note_raw,
    value: obj.value || '',
    matchedKeyword: obj.matched_keyword || '',
    evidence: obj.evidence || '',
    dataTimestamp: obj.data_timestamp || '',
    fileMtime: obj.file_mtime || '',
    evidenceLevel: obj.evidence_level || '',
    confidence: obj.confidence || 0,
    status: obj.status || 'historical_import',
    importedAt: obj.imported_at
  };
}

function normalizeKnowledgeCandidate(candidate = {}) {
  return {
    rawExperienceId: candidate.rawExperienceId || candidate.raw_experience_id || null,
    sourceRecordId: candidate.sourceRecordId || candidate.source_record_id || null,
    vendor: String(candidate.vendor || '').trim(),
    deviceType: String(candidate.deviceType || candidate.device_type || '').trim(),
    model: String(candidate.model || '').trim(),
    indicatorName: String(candidate.indicatorName || candidate.indicator_name || candidate.indicator || '').trim(),
    indicatorCode: String(candidate.indicatorCode || candidate.indicator_code || '').trim(),
    ruleType: normalizeRuleType(candidate.ruleType || candidate.rule_type),
    parserType: String(candidate.parserType || candidate.parser_type || '').trim(),
    filePatterns: normalizeArray(candidate.filePatterns || candidate.file_patterns || candidate.filePattern),
    fileNamePatterns: normalizeArray(candidate.fileNamePatterns || candidate.file_name_patterns || candidate.fileNamePattern),
    keywords: normalizeArray(candidate.keywords || candidate.keywordCandidates || candidate.keyword_candidates || candidate.keyword),
    selector: String(candidate.selector || '').trim(),
    operation: String(candidate.operation || '').trim(),
    valuePattern: String(candidate.valuePattern || candidate.value_pattern || '').trim(),
    meaning: String(candidate.meaning || candidate.keywordMeaning || candidate.keyword_meaning || '').trim(),
    evidenceExample: String(candidate.evidenceExample || candidate.evidence_example || '').trim(),
    aiReason: String(candidate.aiReason || candidate.ai_reason || candidate.reason || '').trim(),
    confidence: clamp(Number(candidate.confidence || 0), 0, 100),
    status: String(candidate.status || 'draft').trim(),
    createdBy: String(candidate.createdBy || candidate.created_by || 'ai').trim()
  };
}

function mapKnowledgeCandidateRow(columns, row) {
  const obj = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return {
    id: obj.id,
    rawExperienceId: obj.raw_experience_id,
    sourceRecordId: obj.source_record_id,
    vendor: obj.vendor,
    deviceType: obj.device_type,
    model: obj.model,
    indicatorName: obj.indicator_name,
    indicatorCode: obj.indicator_code,
    ruleType: obj.rule_type,
    parserType: obj.parser_type,
    filePatterns: parseJsonArray(obj.file_patterns),
    fileNamePatterns: parseJsonArray(obj.file_name_patterns),
    keywords: parseJsonArray(obj.keywords),
    selector: obj.selector,
    operation: obj.operation,
    valuePattern: obj.value_pattern,
    meaning: obj.meaning,
    evidenceExample: obj.evidence_example,
    aiReason: obj.ai_reason,
    confidence: obj.confidence,
    status: obj.status,
    validationStatus: obj.validation_status,
    validatedConfidence: obj.validated_confidence,
    validatedFilePath: obj.validated_file_path,
    validatedEvidence: obj.validated_evidence,
    validatedAt: obj.validated_at,
    createdBy: obj.created_by,
    createdAt: obj.created_at,
    updatedAt: obj.updated_at
  };
}

function normalizeRuleType(value) {
  const allowed = new Set([
    'xml_selector',
    'text_keyword',
    'first_last_rows',
    'row_count',
    'column_sum',
    'file_presence',
    'composite_summary',
    'unavailable_reason',
    'unknown'
  ]);
  const normalized = String(value || 'unknown').trim();
  return allowed.has(normalized) ? normalized : 'unknown';
}

function normalizeArray(value) {
  if (Array.isArray(value)) return unique(value.map(item => String(item || '').trim()).filter(Boolean));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeArray(parsed);
    } catch {
      // split below
    }
    return unique(trimmed.split(/\r?\n|;|；|,/).map(item => item.trim()).filter(Boolean));
  }
  return [];
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return normalizeArray(value);
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cell(row, index) {
  if (index === undefined || index < 0) return '';
  return String(row[index] || '').trim();
}

function splitStoredList(value) {
  return String(value || '').split('\n').map(item => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function insertCollectionRules(recordId, rules = []) {
  if (!rules.length) return;

  const stmt = db.prepare(`
    INSERT INTO collection_rules (
      record_id, indicator, indicator_code, file_pattern, keyword, synonyms,
      keyword_meaning, actual_path, match_method, confidence, value, evidence,
      data_timestamp, file_mtime, evidence_level, status, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    for (const rule of rules) {
      stmt.run([
        recordId,
        rule.indicator || '',
        rule.indicatorCode || rule.indicator_code || '',
        rule.filePattern || rule.file_pattern || '',
        rule.keyword || rule.matchedKeyword || rule.matched_keyword || '',
        Array.isArray(rule.synonyms) ? rule.synonyms.join(';') : (rule.synonyms || ''),
        rule.keywordMeaning || rule.keyword_meaning || '',
        rule.actualPath || rule.actual_path || rule.filePath || rule.file_path || '',
        rule.matchMethod || rule.match_method || '',
        Number(rule.confidence || 0),
        rule.value || '',
        rule.evidence || rule.matchLine || rule.match_line || '',
        rule.dataTimestamp || rule.data_timestamp || '',
        rule.fileMtime || rule.file_mtime || '',
        rule.evidenceLevel || rule.evidence_level || '',
        rule.status || '',
        rule.sourceType || rule.source_type || 'collection_result'
      ]);
    }
  } finally {
    stmt.free();
  }
}

function mapCollectionRule(obj = {}) {
  return {
    id: obj.id,
    recordId: obj.record_id,
    indicator: obj.indicator || '',
    indicatorCode: obj.indicator_code || '',
    filePattern: obj.file_pattern || '',
    keyword: obj.keyword || '',
    synonyms: obj.synonyms || '',
    keywordMeaning: obj.keyword_meaning || '',
    actualPath: obj.actual_path || '',
    matchMethod: obj.match_method || '',
    confidence: Number(obj.confidence || 0),
    value: obj.value || '',
    evidence: obj.evidence || '',
    dataTimestamp: obj.data_timestamp || '',
    fileMtime: obj.file_mtime || '',
    evidenceLevel: obj.evidence_level || '',
    status: obj.status || '',
    sourceType: obj.source_type || 'collection_result'
  };
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

  insertCollectionRules(recordId, rules);

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
      rules.push(mapCollectionRule(obj));
    });
  }

  return { ...record, rules };
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

    insertCollectionRules(recordId, data.rules);
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
