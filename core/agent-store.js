import fs from 'fs';
import path from 'path';
import initSqlJs from 'sql.js';

let db = null;
let dbPath = '';

export async function initAgentStore(tempDir) {
  const SQL = await initSqlJs();
  fs.mkdirSync(tempDir, { recursive: true });
  dbPath = path.join(tempDir, 'agent.db');
  db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      device_type TEXT DEFAULT '',
      vendor TEXT DEFAULT '',
      model TEXT DEFAULT '',
      roots_json TEXT DEFAULT '[]',
      indicators_json TEXT DEFAULT '[]',
      request_json TEXT DEFAULT '{}',
      result_json TEXT DEFAULT '{}',
      current_indicator TEXT DEFAULT '',
      current_step INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      indicator_id TEXT DEFAULT '',
      payload_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_type TEXT NOT NULL,
      device_type TEXT DEFAULT '',
      vendor TEXT DEFAULT '',
      model TEXT DEFAULT '',
      indicator_id TEXT DEFAULT '',
      indicator_name TEXT DEFAULT '',
      title TEXT DEFAULT '',
      content TEXT NOT NULL,
      source_task_id TEXT DEFAULT '',
      evidence_json TEXT DEFAULT '[]',
      confidence INTEGER DEFAULT 0,
      status TEXT DEFAULT 'verified',
      use_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS generated_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      description TEXT DEFAULT '',
      source_code TEXT NOT NULL,
      input_schema_json TEXT DEFAULT '{}',
      output_schema_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'candidate',
      source_model TEXT DEFAULT '',
      source_task_id TEXT DEFAULT '',
      run_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      avg_duration_ms REAL DEFAULT 0,
      last_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_memory_lookup ON agent_memories(device_type, vendor, model, indicator_id, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_generated_tools_status ON generated_tools(status, name)');
  persist();
}

export function createAgentTask(input = {}) {
  requireDB();
  const id = input.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.run(`
    INSERT INTO agent_tasks (
      id, status, device_type, vendor, model, roots_json, indicators_json, request_json
    ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
  `, [
    id,
    input.deviceType || '',
    input.vendor || '',
    input.model || '',
    JSON.stringify(input.roots || []),
    JSON.stringify(input.indicators || []),
    JSON.stringify(redact(input))
  ]);
  persist();
  return id;
}

export function updateAgentTask(id, updates = {}) {
  requireDB();
  const fields = [];
  const values = [];
  const mapping = {
    status: 'status',
    currentIndicator: 'current_indicator',
    currentStep: 'current_step'
  };
  for (const [key, column] of Object.entries(mapping)) {
    if (updates[key] === undefined) continue;
    fields.push(`${column} = ?`);
    values.push(updates[key]);
  }
  if (updates.result !== undefined) {
    fields.push('result_json = ?');
    values.push(JSON.stringify(updates.result || {}));
  }
  if (!fields.length) return;
  fields.push("updated_at = datetime('now', 'localtime')");
  values.push(id);
  db.run(`UPDATE agent_tasks SET ${fields.join(', ')} WHERE id = ?`, values);
  persist();
}

export function appendAgentEvent(taskId, event = {}) {
  if (!db || !taskId) return;
  db.run(`
    INSERT INTO agent_events (task_id, event_type, indicator_id, payload_json)
    VALUES (?, ?, ?, ?)
  `, [taskId, event.type || 'event', event.indicatorId || '', JSON.stringify(redact(event))]);
  persist();
}

export function retrieveAgentMemories(filters = {}) {
  requireDB();
  const limit = Math.max(1, Math.min(Number(filters.limit || 12), 50));
  const result = db.exec(`
    SELECT * FROM agent_memories
    WHERE status = 'verified'
      AND (? = '' OR device_type = ?)
      AND (? = '' OR vendor = ? OR vendor = '')
      AND (? = '' OR model = ? OR model = '')
      AND (? = '' OR indicator_id = ? OR indicator_name LIKE ?)
    ORDER BY
      CASE WHEN indicator_id = ? AND indicator_id <> '' THEN 0 ELSE 1 END,
      CASE WHEN model = ? AND model <> '' THEN 0 ELSE 1 END,
      confidence DESC,
      updated_at DESC
    LIMIT ?
  `, [
    filters.deviceType || '', filters.deviceType || '',
    filters.vendor || '', filters.vendor || '',
    filters.model || '', filters.model || '',
    filters.indicatorId || filters.indicatorName || '',
    filters.indicatorId || '',
    `%${filters.indicatorName || ''}%`,
    filters.indicatorId || '', filters.model || '', limit
  ]);
  if (!result.length) return [];
  const columns = result[0].columns;
  const rows = result[0].values.map(row => mapRow(columns, row));
  for (const item of rows) {
    db.run('UPDATE agent_memories SET use_count = use_count + 1 WHERE id = ?', [item.id]);
  }
  persist();
  return rows.map(item => ({
    ...item,
    evidence: parseJSON(item.evidence_json, [])
  }));
}

export function saveAgentMemory(memory = {}) {
  requireDB();
  if (!String(memory.content || '').trim()) return null;
  db.run(`
    INSERT INTO agent_memories (
      memory_type, device_type, vendor, model, indicator_id, indicator_name,
      title, content, source_task_id, evidence_json, confidence, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    memory.memoryType || 'task_success', memory.deviceType || '', memory.vendor || '',
    memory.model || '', memory.indicatorId || '', memory.indicatorName || '',
    memory.title || '', String(memory.content || '').trim(), memory.sourceTaskId || '',
    JSON.stringify(memory.evidence || []), clamp(memory.confidence, 0, 100), memory.status || 'verified'
  ]);
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return id;
}

export function saveGeneratedTool(tool = {}) {
  requireDB();
  const name = String(tool.name || 'generated_tool').trim();
  const sourceCode = String(tool.sourceCode || '');
  const existing = db.exec(`
    SELECT id, name, version FROM generated_tools
    WHERE name = ? AND source_code = ? AND status <> 'deprecated'
    ORDER BY version DESC LIMIT 1
  `, [name, sourceCode]);
  if (existing.length) {
    const [id, existingName, version] = existing[0].values[0];
    return { id, name: existingName, version, reused: true };
  }
  const versionResult = db.exec('SELECT COALESCE(MAX(version), 0) + 1 FROM generated_tools WHERE name = ?', [name]);
  const version = Number(versionResult[0]?.values?.[0]?.[0] || 1);
  db.run(`
    INSERT INTO generated_tools (
      name, version, description, source_code, input_schema_json, output_schema_json,
      status, source_model, source_task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    name, version, tool.description || '', sourceCode,
    JSON.stringify(tool.inputSchema || {}), JSON.stringify(tool.outputSchema || {}),
    tool.status || 'candidate', tool.sourceModel || '', tool.sourceTaskId || ''
  ]);
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return { id, name, version };
}

export function recordGeneratedToolRun(id, run = {}) {
  if (!db || !id) return;
  db.run(`
    UPDATE generated_tools SET
      run_count = run_count + 1,
      success_count = success_count + ?,
      avg_duration_ms = CASE WHEN run_count = 0 THEN ? ELSE ((avg_duration_ms * run_count) + ?) / (run_count + 1) END,
      last_error = ?,
      status = CASE
        WHEN (success_count + ?) >= 3 AND ((success_count + ?) * 1.0 / (run_count + 1)) >= 0.8 THEN 'official'
        WHEN (success_count + ?) >= 1 THEN 'experimental'
        ELSE status
      END,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `, [run.success ? 1 : 0, run.durationMs || 0, run.durationMs || 0, run.error || '', run.success ? 1 : 0, run.success ? 1 : 0, run.success ? 1 : 0, id]);
  persist();
}

export function listGeneratedTools(filters = {}) {
  requireDB();
  const result = db.exec(`
    SELECT id, name, version, description, input_schema_json, output_schema_json,
           status, source_model, source_task_id, run_count, success_count,
           avg_duration_ms, last_error, created_at, updated_at
    FROM generated_tools
    WHERE (? = '' OR status = ?)
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `, [filters.status || '', filters.status || '', Math.min(Number(filters.limit || 100), 500)]);
  if (!result.length) return [];
  return result[0].values.map(row => mapRow(result[0].columns, row));
}

function persist() {
  if (!db || !dbPath) return;
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function requireDB() {
  if (!db) throw new Error('Agent 数据库尚未初始化');
}

function mapRow(columns, row) {
  const value = {};
  columns.forEach((column, index) => { value[column] = row[index]; });
  return value;
}

function parseJSON(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function redact(value) {
  const clone = JSON.parse(JSON.stringify(value || {}));
  if (clone.apiKey) clone.apiKey = '[REDACTED]';
  if (clone.aiOptions?.apiKey) clone.aiOptions.apiKey = '[REDACTED]';
  return clone;
}

function clamp(value, min, max) {
  const number = Number(value || 0);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? Math.round(number) : min));
}
