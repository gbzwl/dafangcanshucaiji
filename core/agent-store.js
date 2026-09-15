import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import initSqlJs from 'sql.js';

let db = null;
let dbPath = '';
let encryptionKey = null;

export async function initAgentStore(tempDir) {
  const SQL = await initSqlJs();
  fs.mkdirSync(tempDir, { recursive: true });
  dbPath = path.join(tempDir, 'agent.db');
  encryptionKey = loadOrCreateEncryptionKey(path.join(tempDir, '.agent-config.key'));
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
  db.run(`
    CREATE TABLE IF NOT EXISTS api_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      api_key_hint TEXT DEFAULT '',
      output_mode TEXT DEFAULT 'auto',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      last_used_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      status TEXT DEFAULT 'active',
      context_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id, id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_agent_memory_lookup ON agent_memories(device_type, vendor, model, indicator_id, status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_generated_tools_status ON generated_tools(status, name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_api_profiles_active ON api_profiles(is_active, last_used_at)');
  persist();
}

export function listApiProfiles() {
  requireDB();
  const result = db.exec(`
    SELECT id, name, base_url, model, api_key_hint, output_mode, is_active,
           created_at, updated_at, last_used_at
    FROM api_profiles
    ORDER BY is_active DESC, last_used_at DESC, id DESC
  `);
  if (!result.length) return [];
  return result[0].values.map(row => publicApiProfile(mapRow(result[0].columns, row)));
}

export function getActiveApiProfile() {
  requireDB();
  const result = db.exec(`
    SELECT * FROM api_profiles
    ORDER BY is_active DESC, last_used_at DESC, id DESC
    LIMIT 1
  `);
  if (!result.length) return null;
  return privateApiProfile(mapRow(result[0].columns, result[0].values[0]));
}

export function getApiProfile(id) {
  requireDB();
  const result = db.exec('SELECT * FROM api_profiles WHERE id = ? LIMIT 1', [Number(id)]);
  if (!result.length) return null;
  return privateApiProfile(mapRow(result[0].columns, result[0].values[0]));
}

export function saveApiProfile(input = {}) {
  requireDB();
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(input.model || '').trim();
  const source = input.sourceProfileId ? getApiProfile(input.sourceProfileId) : null;
  const apiKey = String(input.apiKey || source?.apiKey || '').trim();
  if (!baseUrl) throw new Error('API URL 不能为空');
  if (!model) throw new Error('模型名称不能为空');
  if (!apiKey) throw new Error('API Key 不能为空');

  const same = db.exec(`
    SELECT id FROM api_profiles WHERE base_url = ? AND model = ? ORDER BY id DESC LIMIT 1
  `, [baseUrl, model]);
  const existingId = Number(same[0]?.values?.[0]?.[0] || 0);
  const name = String(input.name || buildProfileName(baseUrl, model)).trim();
  const encrypted = encryptSecret(apiKey);
  const hint = maskApiKey(apiKey);
  let profileId = existingId;

  db.run('UPDATE api_profiles SET is_active = 0');
  if (existingId) {
    db.run(`
      UPDATE api_profiles SET name = ?, api_key_encrypted = ?, api_key_hint = ?,
        output_mode = ?, is_active = 1,
        updated_at = datetime('now', 'localtime'), last_used_at = datetime('now', 'localtime')
      WHERE id = ?
    `, [name, encrypted, hint, input.outputMode || 'auto', existingId]);
  } else {
    db.run(`
      INSERT INTO api_profiles (
        name, base_url, model, api_key_encrypted, api_key_hint, output_mode, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `, [name, baseUrl, model, encrypted, hint, input.outputMode || 'auto']);
    profileId = lastInsertId();
  }
  persist();
  return getApiProfile(profileId);
}

export function activateApiProfile(id) {
  requireDB();
  const profile = getApiProfile(id);
  if (!profile) throw new Error('API 历史配置不存在');
  db.run('UPDATE api_profiles SET is_active = 0');
  db.run(`
    UPDATE api_profiles SET is_active = 1, last_used_at = datetime('now', 'localtime')
    WHERE id = ?
  `, [profile.id]);
  persist();
  return getApiProfile(profile.id);
}

export function deleteApiProfile(id) {
  requireDB();
  const profile = getApiProfile(id);
  if (!profile) return { deleted: false, active: getActiveApiProfile() };
  db.run('DELETE FROM api_profiles WHERE id = ?', [profile.id]);
  if (profile.isActive) {
    const next = getActiveApiProfile();
    if (next) {
      db.run('UPDATE api_profiles SET is_active = 1 WHERE id = ?', [next.id]);
    }
  }
  persist();
  return { deleted: true, active: getActiveApiProfile() };
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

export function ensureAgentSession(sessionId, context = {}) {
  requireDB();
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('会话 ID 不能为空');
  const existing = db.exec('SELECT id FROM agent_sessions WHERE id = ? LIMIT 1', [id]);
  if (!existing.length) {
    db.run('INSERT INTO agent_sessions (id, context_json) VALUES (?, ?)', [id, JSON.stringify(context || {})]);
  } else if (context && Object.keys(context).length) {
    const current = getAgentSessionContext(id);
    db.run("UPDATE agent_sessions SET context_json = ?, updated_at = datetime('now', 'localtime') WHERE id = ?", [JSON.stringify({ ...current, ...context }), id]);
  }
  persist();
  return id;
}

export function getAgentSessionContext(sessionId) {
  requireDB();
  const result = db.exec('SELECT context_json FROM agent_sessions WHERE id = ? LIMIT 1', [String(sessionId || '')]);
  if (!result.length) return {};
  return parseJSON(result[0].values[0][0], {});
}

export function appendAgentMessage(sessionId, role, content, metadata = {}) {
  requireDB();
  const id = ensureAgentSession(sessionId);
  const text = String(content || '').trim();
  if (!text) return null;
  db.run('INSERT INTO agent_messages (session_id, role, content, metadata_json) VALUES (?, ?, ?, ?)', [id, role || 'user', text, JSON.stringify(metadata || {})]);
  db.run("UPDATE agent_sessions SET updated_at = datetime('now', 'localtime') WHERE id = ?", [id]);
  persist();
  return lastInsertId();
}

export function getAgentMessages(sessionId, limit = 30) {
  requireDB();
  const result = db.exec('SELECT role, content, metadata_json, created_at FROM agent_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?', [String(sessionId || ''), Math.max(1, Math.min(Number(limit) || 30, 200))]);
  if (!result.length) return [];
  return result[0].values.reverse().map(row => ({ role: row[0], content: row[1], metadata: parseJSON(row[2], {}), createdAt: row[3] }));
}

export function closeAgentSession(sessionId) {
  requireDB();
  db.run("UPDATE agent_sessions SET status = 'closed', updated_at = datetime('now', 'localtime') WHERE id = ?", [String(sessionId || '')]);
  persist();
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

function lastInsertId() {
  return Number(db.exec('SELECT last_insert_rowid() AS id')[0]?.values?.[0]?.[0] || 0);
}

function publicApiProfile(profile = {}) {
  return {
    id: Number(profile.id),
    name: profile.name || buildProfileName(profile.base_url, profile.model),
    baseUrl: profile.base_url || '',
    model: profile.model || '',
    apiKeyHint: profile.api_key_hint || '',
    hasApiKey: !!profile.api_key_encrypted,
    outputMode: profile.output_mode || 'auto',
    isActive: Boolean(profile.is_active),
    createdAt: profile.created_at || '',
    updatedAt: profile.updated_at || '',
    lastUsedAt: profile.last_used_at || ''
  };
}

function privateApiProfile(profile = {}) {
  return {
    ...publicApiProfile(profile),
    apiKey: decryptSecret(profile.api_key_encrypted)
  };
}

function buildProfileName(baseUrl, model) {
  let host = String(baseUrl || '').replace(/^https?:\/\//i, '').split('/')[0];
  if (!host) host = 'API';
  return `${model || '未命名模型'} · ${host}`;
}

function maskApiKey(apiKey) {
  const value = String(apiKey || '');
  if (!value) return '';
  return `••••${value.slice(-4)}`;
}

function loadOrCreateEncryptionKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    const saved = fs.readFileSync(keyPath);
    if (saved.length === 32) return saved;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

function encryptSecret(value) {
  if (!encryptionKey) throw new Error('API 配置加密密钥尚未初始化');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(item => item.toString('base64')).join('.');
}

function decryptSecret(value) {
  if (!value) return '';
  if (!encryptionKey) throw new Error('API 配置加密密钥尚未初始化');
  try {
    const [iv, tag, encrypted] = String(value).split('.').map(item => Buffer.from(item, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('无法解密已保存的 API Key');
  }
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
