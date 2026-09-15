import fs from 'fs';
import path from 'path';
import { callAIStream, extractJSON } from './ai-service.js';
import { getKnowledgeCandidates } from './experience-library.js';
import { executeGeneratedTool } from './dynamic-tool-runner.js';
import {
  appendAgentEvent,
  createAgentTask,
  recordGeneratedToolRun,
  retrieveAgentMemories,
  saveGeneratedTool,
  updateAgentTask
} from './agent-store.js';

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_CANDIDATES = 16;
const DEFAULT_MAX_RESULT_CHARS = 20000;
const DEFAULT_MAX_TOKEN_OUTPUT = 5000;

export async function runAgentCollection(request = {}, hooks = {}) {
  const roots = normalizeRoots(request.roots || request.diskRoots || request.root || request.diskRoot);
  const indicators = normalizeIndicators(request.indicators || request.rules);
  if (!roots.length) throw new Error('请先选择目标磁盘');
  if (!indicators.length) throw new Error('当前设备类型没有可采集指标');

  const startedAt = Date.now();
  const context = {
    vendor: String(request.vendor || '').trim(),
    deviceType: String(request.deviceType || '').trim().toUpperCase(),
    model: String(request.model || '').trim(),
    roots,
    aiOptions: request.aiOptions || {},
    maxSteps: DEFAULT_MAX_STEPS,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    maxResultChars: DEFAULT_MAX_RESULT_CHARS,
    agentProfile: String(request.agentProfile || '').trim(),
    dryRun: !!request.dryRun,
    signal: request.aiOptions?.signal
  };
  context.taskId = safeCreateTask({ ...context, indicators });

  const results = [];
  const trace = [];
  const toolCalls = [];
  const sharedDiscoveries = [];
  await emit(hooks, trace, context, { type: 'start', taskId: context.taskId, message: `开始采集 ${indicators.length} 个指标`, totalIndicators: indicators.length, roots });

  try {
    context.taskPlan = context.dryRun
      ? createFallbackPlan(indicators)
      : await createTaskPlan(indicators, context, hooks, trace);
    await emit(hooks, trace, context, { type: 'plan_ready', taskId: context.taskId, groups: context.taskPlan.groups || [], strategy: context.taskPlan.strategy || '' });

    for (let index = 0; index < indicators.length; index++) {
      if (context.signal?.aborted) throw new Error('Agent 采集已停止');

      const indicator = indicators[index];
      safeUpdateTask(context.taskId, { currentIndicator: indicator.indicatorId, currentStep: 0 });
      await emit(hooks, trace, context, { type: 'indicator_start', indicator: indicator.indicator, indicatorId: indicator.indicatorId, index: index + 1, total: indicators.length });

      const memory = loadRelevantMemory(indicator, context);
      await emit(hooks, trace, context, { type: 'knowledge', indicator: indicator.indicator, indicatorId: indicator.indicatorId, count: memory.length });
      if (context.dryRun) {
        results.push({ ...emptyResult(indicator, 'dry_run', '仅生成决策上下文'), prompt: buildAgentPrompt(indicator, memory, context, [], sharedDiscoveries) });
        continue;
      }

      const result = await runIndicator(indicator, memory, context, hooks, trace, toolCalls, sharedDiscoveries);
      results.push(result);
      await emit(hooks, trace, context, { type: 'indicator_complete', indicator: indicator.indicator, indicatorId: indicator.indicatorId, status: result.status, confidence: result.confidence });
    }

    const output = { success: true, taskId: context.taskId, results, trace, toolCalls, durationMs: Date.now() - startedAt };
    safeUpdateTask(context.taskId, { status: 'completed', result: output });
    await emit(hooks, trace, context, { type: 'complete', taskId: context.taskId, message: 'Agent 采集完成', durationMs: output.durationMs, successCount: results.filter(item => item.status === 'success').length, failCount: results.filter(item => item.status !== 'success').length });
    return output;
  } catch (error) {
    safeUpdateTask(context.taskId, { status: context.signal?.aborted ? 'cancelled' : 'failed', result: { error: error.message, results } });
    throw error;
  }
}

async function runIndicator(indicator, memory, context, hooks, trace, toolCalls, sharedDiscoveries) {
  const observations = [];
  let lastModelText = '';
  let parseErrors = 0;
  const actionCounts = new Map();

  for (let step = 1; step <= context.maxSteps; step++) {
    if (context.signal?.aborted) throw new Error('Agent 采集已停止');
    safeUpdateTask(context.taskId, { currentIndicator: indicator.indicatorId, currentStep: step });
    await emit(hooks, trace, context, { type: 'model_step', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, maxSteps: context.maxSteps });

    const prompt = buildAgentPrompt(indicator, memory, context, observations, sharedDiscoveries);
    let streamed = '';
    const aiResult = await callAIStream(prompt, {
      ...context.aiOptions,
      maxTokens: context.aiOptions.maxTokens || DEFAULT_MAX_TOKEN_OUTPUT,
      temperature: context.aiOptions.temperature ?? 0.15,
      formatJson: true
    }, (token, meta = {}) => {
      if (meta.type === 'content') streamed += token;
      hooks.onEvent?.({ type: meta.type === 'reasoning' ? 'model_reasoning_delta' : 'model_delta', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, content: token });
    });

    lastModelText = aiResult.content || streamed;
    let action = extractJSON(lastModelText);
    if (!action) action = await repairAction(lastModelText, indicator, context, hooks, trace, step);
    if (!action || typeof action !== 'object') {
      parseErrors++;
      await emit(hooks, trace, context, { type: 'parse_error', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, message: '模型没有返回有效的 Agent JSON' });
      if (parseErrors >= 2) return emptyResult(indicator, 'failed', '外部 API 连续返回无效格式');
      continue;
    }
    parseErrors = 0;

    if (action.type === 'final') {
      return validateFinalResult(indicator, action.result || action, context, observations);
    }
    if (action.type !== 'code_call') {
      observations.push({ type: 'protocol_error', message: `不支持的动作：${action.type || 'unknown'}` });
      continue;
    }

    const toolName = String(action.name || action.tool || `explore_${indicator.indicatorId}_${step}`).trim();
    const sourceCode = String(action.code || '').trim();
    const actionSignature = JSON.stringify({ code: sourceCode.replace(/\s+/g, ' ').trim(), args: action.args || {} });
    const repeated = (actionCounts.get(actionSignature) || 0) + 1;
    actionCounts.set(actionSignature, repeated);
    if (repeated >= 3) {
      observations.push({ type: 'stagnation', message: '相同工具和参数已重复执行，必须改变探索策略或给出当前结论' });
      await emit(hooks, trace, context, { type: 'stagnation', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, message: '检测到重复探索，要求模型重新规划' });
      continue;
    }
    const savedTool = safeSaveTool({
      name: toolName,
      description: action.thought || action.description || '',
      sourceCode,
      inputSchema: action.input_schema || {},
      outputSchema: action.output_schema || {},
      sourceModel: context.aiOptions.model || '',
      sourceTaskId: context.taskId
    });

    await emit(hooks, trace, context, { type: 'code_call', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, tool: toolName, thought: action.thought || '', args: action.args || {} });
    const startedAt = Date.now();
    const executed = await executeGeneratedTool({ code: sourceCode, args: action.args || {} }, {
      roots: context.roots,
      idleTimeoutMs: 3 * 60 * 1000,
      hardTimeoutMs: 15 * 60 * 1000,
      maxOutputChars: context.maxResultChars * 2,
      signal: context.signal,
      onProgress: progress => hooks.onEvent?.({
        type: 'tool_progress',
        indicator: indicator.indicator,
        indicatorId: indicator.indicatorId,
        step,
        tool: toolName,
        progress
      })
    });
    const compact = compactResult(executed, context.maxResultChars);
    safeRecordToolRun(savedTool?.id, { success: executed.success !== false, durationMs: Date.now() - startedAt, error: executed.error || '' });

    const record = { indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, tool: toolName, args: action.args || {}, result: compact };
    observations.push(record);
    toolCalls.push(record);
    if (executed.success && sharedDiscoveries.length < 30) sharedDiscoveries.push({ indicator: indicator.indicator, tool: toolName, result: compact });
    await emit(hooks, trace, context, { type: 'code_result', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, tool: toolName, success: executed.success !== false, summary: summarizeCodeResult(compact) });
  }
  return { ...emptyResult(indicator, 'failed', '达到最大决策步数，模型仍未形成结论'), rawModelText: truncate(lastModelText, 2000) };
}

async function createTaskPlan(indicators, context, hooks, trace) {
  await emit(hooks, trace, context, { type: 'planning', taskId: context.taskId, message: '正在分析整批指标并制定共享探索计划' });
  const prompt = `你是医疗设备参数采集任务规划器。根据整批指标制定共享探索计划，避免每个指标重复扫描磁盘。
只返回 JSON，不要生成文件路径或结果值，不要假设某个厂商一定使用固定目录。

设备类型：${context.deviceType}
厂商：${context.vendor || '未知'}
型号：${context.model || '未知'}
根目录数量：${context.roots.length}
指标：${JSON.stringify(indicators.map(item => ({ id: item.indicatorId, name: item.indicator, referenceCode: item.indicatorCode })))}

返回格式：
{
  "strategy": "整体探索策略",
  "groups": [
    {"name":"分组名称","indicatorIds":["指标ID"],"likelyFileKinds":["log","xml"],"sharedSearchIdeas":["英文文件名或目录语义"]}
  ],
  "qualityNotes": ["需要特别验证的同源关系或时间要求"]
}`;
  try {
    let content = '';
    const result = await callAIStream(prompt, { ...context.aiOptions, maxTokens: 1800, temperature: 0.1, formatJson: true }, (token, meta = {}) => {
      if (meta.type === 'content') content += token;
      if (meta.type === 'reasoning') hooks.onEvent?.({ type: 'model_reasoning_delta', step: 0, content: token });
    });
    return extractJSON(result.content || content) || createFallbackPlan(indicators);
  } catch (error) {
    await emit(hooks, trace, context, { type: 'planning_fallback', message: `整批计划生成失败，使用指标顺序继续：${error.message}` });
    return createFallbackPlan(indicators);
  }
}

function createFallbackPlan(indicators) {
  return {
    strategy: '按指标顺序探索，并复用前面步骤已经发现的目录和文件。',
    groups: [{ name: '全部指标', indicatorIds: indicators.map(item => item.indicatorId), likelyFileKinds: [], sharedSearchIdeas: [] }],
    qualityNotes: []
  };
}

function buildAgentPrompt(indicator, memory, context, observations, sharedDiscoveries) {
  return `${context.agentProfile || '你是医疗设备参数采集 Agent，负责理解指标、编写只读探索代码、判断证据并输出结论。'}

不可改变的边界：
- 你负责分析和生成代码，本地程序负责执行。不得臆造文件、数值或证据。
- 代码只能读取允许根目录，禁止写入、删除、改名文件，禁止启动其他进程或访问网络。
- test、template、demo、sample、systemstatus、testProtConfig 等文件不得作为正式证据。
- 没有真实文件证据时必须返回 not_found 或 needs_review。

当前任务：
- 设备类型：${context.deviceType}
- 厂商：${context.vendor || '未知'}
- 型号：${context.model || '未知'}
- 指标 ID：${indicator.indicatorId}
- 中文指标：${indicator.indicator}
- 参考英文标识：${indicator.indicatorCode || '无，仅供推测，不是固定字段'}
- 允许根目录：${context.roots.join(' | ')}

整批任务共享计划：
${JSON.stringify(context.taskPlan || {}, null, 2)}

相关前置记忆：
${JSON.stringify(memory, null, 2)}

本任务其他指标已经发现的内容：
${JSON.stringify(sharedDiscoveries.slice(-8), null, 2)}

当前指标已经执行的步骤：
${JSON.stringify(observations.slice(-8), null, 2)}

每次只能返回一个 JSON 对象。需要探索磁盘时返回：
{
  "type": "code_call",
  "name": "简短的英文工具名",
  "thought": "本次真实探索目的",
  "args": {"maxFiles": 5000, "maxResults": 100},
  "code": "JavaScript 函数体代码"
}

代码运行环境：
- 已提供 fs、path、zlib、readline 和 context。
- context.roots 是允许读取的根目录；context.args 是本次参数；context.limits 包含 maxFiles、maxReadBytes、maxResults。
- 代码位于 async function generatedTool(context) 内，最后必须 return 可 JSON 序列化结果。
- 扫描过程中每处理约 100 个文件或每 5 秒调用 context.reportProgress({ checkedFiles, currentPath, matches })，让程序确认工具仍在推进。
- 允许使用 fs.promises、createReadStream、readdir、stat 和 readline，必须限制文件数、读取量和结果数。
- 先探索高概率目录和文件名，再读取小片段；大日志优先读取尾部或逐行搜索。
- 不要在代码中写死当前机器盘符，必须从 context.roots 开始。

形成结论时返回：
{
  "type": "final",
  "result": {
    "indicator": "${indicator.indicator}",
    "value": "采集值",
    "filePath": "真实完整路径",
    "matchedKeyword": "实际字段或 selector",
    "synonyms": ["本次验证过的备用关键字"],
    "keywordMeaning": "中文含义和判断说明",
    "evidence": "来自文件的原始证据片段",
    "dataTimestamp": "数据时间，无法确定则为空",
    "fileMtime": "文件修改时间",
    "evidenceLevel": "STRONG|MEDIUM|WEAK|NONE",
    "confidence": 0,
    "matchMethod": "selector|exact_keyword|semantic_context|file_presence|calculation",
    "status": "success|needs_review|not_found",
    "reason": "结论理由"
  }
}`;
}

async function repairAction(rawText, indicator, context, hooks, trace, step) {
  if (!rawText || context.aiOptions.outputMode === 'strict_json') return null;
  await emit(hooks, trace, context, { type: 'parse_repair', indicator: indicator.indicator, indicatorId: indicator.indicatorId, step, message: '正在修复模型输出格式' });
  try {
    const result = await callAIStream(`把下面内容转换为 code_call 或 final JSON，只返回 JSON。\n${truncate(rawText, 6000)}`, {
      ...context.aiOptions, outputMode: 'strict_json', formatJson: true, maxTokens: 4500, temperature: 0
    });
    return extractJSON(result.content);
  } catch { return null; }
}

function loadRelevantMemory(indicator, context) {
  const memories = [];
  try {
    memories.push(...retrieveAgentMemories({ deviceType: context.deviceType, vendor: context.vendor, model: context.model, indicatorId: indicator.indicatorId, indicatorName: indicator.indicator, limit: context.maxCandidates }));
  } catch {}
  try {
    const exact = getKnowledgeCandidates({ vendor: context.vendor, deviceType: context.deviceType, model: context.model, indicator: indicator.indicator, limit: context.maxCandidates });
    const broader = exact.length < context.maxCandidates
      ? getKnowledgeCandidates({ vendor: context.vendor, deviceType: context.deviceType, indicator: indicator.indicator, limit: context.maxCandidates })
      : [];
    const candidates = [...new Map([...exact, ...broader].map(item => [item.id, item])).values()];
    memories.push(...candidates.sort((a, b) => memoryRank(a) - memoryRank(b)).map(item => ({
      source: 'legacy_knowledge', status: item.validationStatus || item.status, indicatorName: item.indicatorName,
      indicatorCode: item.indicatorCode, filePatterns: item.filePatterns, fileNamePatterns: item.fileNamePatterns,
      keywords: item.keywords, selector: item.selector, operation: item.operation, meaning: item.meaning,
      evidence: item.validatedEvidence || item.evidenceExample, confidence: item.validatedConfidence || item.confidence
    })));
  } catch {}
  return memories.slice(0, context.maxCandidates);
}

function validateFinalResult(indicator, result, context, observations) {
  const normalized = {
    indicatorId: indicator.indicatorId,
    indicator: indicator.indicator,
    indicatorCode: indicator.indicatorCode,
    value: String(result.value || ''),
    filePath: String(result.filePath || result.file_path || ''),
    matchedKeyword: String(result.matchedKeyword || result.matched_keyword || ''),
    synonyms: Array.isArray(result.synonyms) ? result.synonyms.map(String).filter(Boolean) : [],
    keywordMeaning: String(result.keywordMeaning || result.keyword_meaning || ''),
    evidence: String(result.evidence || ''),
    dataTimestamp: String(result.dataTimestamp || result.data_timestamp || ''),
    fileMtime: String(result.fileMtime || result.file_mtime || ''),
    evidenceLevel: String(result.evidenceLevel || result.evidence_level || 'NONE').toUpperCase(),
    confidence: clampNumber(result.confidence, 0, 100, 0),
    matchMethod: String(result.matchMethod || result.match_method || ''),
    status: String(result.status || 'not_found'),
    sourceType: 'agent_collection',
    reason: String(result.reason || ''),
    observations: observations.slice(-5)
  };
  if (normalized.status !== 'success') return normalized;
  if (!normalized.filePath || !normalized.evidence) return { ...normalized, status: 'needs_review', reason: '模型标记成功，但缺少文件路径或原始证据' };
  if (!isInsideRoots(normalized.filePath, context.roots) || !fs.existsSync(normalized.filePath)) return { ...normalized, status: 'needs_review', reason: '模型返回的证据文件不存在或不在选定磁盘内' };
  const stat = fs.statSync(normalized.filePath);
  if (!stat.isFile()) return { ...normalized, status: 'needs_review', reason: '证据路径不是文件' };
  normalized.fileMtime = normalized.fileMtime || stat.mtime.toISOString();
  if (normalized.evidenceLevel === 'WEAK' || normalized.evidenceLevel === 'NONE') normalized.status = 'needs_review';
  return normalized;
}

function compactResult(value, maxChars) {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return value;
  return { success: value.success !== false, truncated: true, preview: json.slice(0, maxChars), durationMs: value.durationMs || 0 };
}

function summarizeCodeResult(result) {
  if (result.success === false) return result.error || '执行失败';
  const payload = result.result;
  if (Array.isArray(payload)) return `返回 ${payload.length} 条记录`;
  if (Array.isArray(payload?.files)) return `发现 ${payload.files.length} 个候选文件`;
  if (Array.isArray(payload?.matches)) return `发现 ${payload.matches.length} 条匹配证据`;
  return `执行成功，耗时 ${result.durationMs || 0} ms`;
}

function normalizeIndicators(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => typeof item === 'string'
    ? { indicatorId: `CUSTOM_${index + 1}`, indicator: item.trim(), indicatorCode: '' }
    : {
        indicatorId: String(item.indicatorId || item.id || `CUSTOM_${index + 1}`).trim(),
        indicator: String(item.indicator || item.name || item.indicatorName || '').trim(),
        indicatorCode: String(item.indicatorCode || item.indicator_code || item.code || '').trim()
      }).filter(item => item.indicator);
}

function normalizeRoots(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,\n]/);
  return list.map(item => path.resolve(String(item || '').trim())).filter(Boolean);
}

function emptyResult(indicator, status, reason) {
  return { indicatorId: indicator.indicatorId, indicator: indicator.indicator, indicatorCode: indicator.indicatorCode, value: '', filePath: '', matchedKeyword: '', synonyms: [], keywordMeaning: '', evidence: '', dataTimestamp: '', fileMtime: '', evidenceLevel: 'NONE', confidence: 0, matchMethod: '', status, sourceType: 'agent_collection', reason };
}

function isInsideRoots(filePath, roots) {
  const resolved = path.resolve(filePath).toLowerCase();
  return roots.some(root => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(`${base}${path.sep}`);
  });
}

function stripDrive(value) {
  return String(value || '').replace(/^[a-z]:[\\/]/i, '').replace(/\\/g, '/');
}

function memoryRank(item) {
  if (item.validationStatus === 'verified') return 0;
  if (item.status === 'verified') return 1;
  return 2;
}

async function emit(hooks, trace, context, event) {
  const payload = { ...event, timestamp: new Date().toISOString() };
  trace.push(payload);
  try { appendAgentEvent(context.taskId, payload); } catch {}
  await hooks.onEvent?.(payload);
}

function safeCreateTask(input) { try { return createAgentTask(input); } catch { return `task_${Date.now()}`; } }
function safeUpdateTask(id, value) { try { updateAgentTask(id, value); } catch {} }
function safeSaveTool(value) { try { return saveGeneratedTool(value); } catch { return null; } }
function safeRecordToolRun(id, value) { try { recordGeneratedToolRun(id, value); } catch {} }
function clampNumber(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }
function truncate(value, max) { const text = String(value || ''); return text.length > max ? `${text.slice(0, max)}...` : text; }
