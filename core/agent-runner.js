import path from 'path';
import { callAIStream, extractJSON } from './ai-service.js';
import { executeTool, listTools } from './tools/agent-tools.js';
import { getKnowledgeCandidates } from './experience-library.js';

const ALLOWED_TOOLS = new Set([
  'search_files',
  'get_file_meta',
  'read_head',
  'read_tail',
  'read_sample',
  'search_text',
  'parse_xml',
  'count_rows',
  'first_last_rows',
  'gunzip_preview'
]);

const FILE_ARG_TOOLS = new Set([
  'get_file_meta',
  'read_head',
  'read_tail',
  'read_sample',
  'search_text',
  'parse_xml',
  'count_rows',
  'first_last_rows',
  'gunzip_preview'
]);

const DEFAULT_MAX_STEPS = 10;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_MAX_RESULT_CHARS = 7000;
const DEFAULT_MAX_TOKEN_OUTPUT = 1400;

export async function runAgentCollection(request = {}, hooks = {}) {
  const roots = normalizeRoots(request.roots || request.diskRoots || request.root || request.diskRoot);
  const indicators = normalizeIndicators(request.indicators || request.rules);

  if (roots.length === 0) throw new Error('roots/diskRoots is required');
  if (indicators.length === 0) throw new Error('indicators/rules is required');

  const context = {
    vendor: request.vendor || '',
    deviceType: request.deviceType || '',
    model: request.model || '',
    roots,
    aiOptions: request.aiOptions || {},
    maxSteps: clampNumber(request.maxSteps, 1, 30, DEFAULT_MAX_STEPS),
    maxCandidates: clampNumber(request.maxCandidates, 0, 30, DEFAULT_MAX_CANDIDATES),
    maxResultChars: clampNumber(request.maxResultChars, 1000, 30000, DEFAULT_MAX_RESULT_CHARS),
    dryRun: !!request.dryRun
  };

  const startedAt = Date.now();
  const results = [];
  const trace = [];
  const toolCalls = [];

  await emit(hooks, trace, {
    type: 'start',
    message: `开始 Agent 采集：${indicators.length} 个指标，${roots.length} 个根目录`,
    totalIndicators: indicators.length,
    roots
  });

  for (let i = 0; i < indicators.length; i++) {
    const indicator = indicators[i];
    await emit(hooks, trace, {
      type: 'indicator_start',
      indicator: indicator.indicator,
      index: i + 1,
      total: indicators.length
    });

    const candidates = loadKnowledgeCandidates(indicator, context);
    await emit(hooks, trace, {
      type: 'knowledge',
      indicator: indicator.indicator,
      count: candidates.length
    });

    if (context.dryRun) {
      const prompt = buildAgentPrompt(indicator, candidates, context, []);
      results.push(createPendingResult(indicator, 'dry_run', prompt));
      continue;
    }

    const indicatorResult = await runIndicatorAgent(indicator, candidates, context, hooks, trace, toolCalls);
    results.push(indicatorResult);

    await emit(hooks, trace, {
      type: 'indicator_complete',
      indicator: indicator.indicator,
      status: indicatorResult.status,
      confidence: indicatorResult.confidence
    });
  }

  await emit(hooks, trace, {
    type: 'complete',
    message: 'Agent 采集完成',
    durationMs: Date.now() - startedAt,
    successCount: results.filter(item => item.status === 'success').length,
    failCount: results.filter(item => item.status !== 'success').length
  });

  return {
    success: true,
    results,
    trace,
    toolCalls,
    durationMs: Date.now() - startedAt
  };
}

async function runIndicatorAgent(indicator, candidates, context, hooks, trace, toolCalls) {
  const observations = [];
  let lastModelText = '';

  for (let step = 1; step <= context.maxSteps; step++) {
    await emit(hooks, trace, {
      type: 'model_step',
      indicator: indicator.indicator,
      step,
      maxSteps: context.maxSteps
    });

    const prompt = buildAgentPrompt(indicator, candidates, context, observations);
    let raw = '';
    const aiResult = await callAIStream(
      prompt,
      {
        ...context.aiOptions,
        maxTokens: context.aiOptions.maxTokens || DEFAULT_MAX_TOKEN_OUTPUT,
        temperature: context.aiOptions.temperature ?? 0.2,
        formatJson: false
      },
      token => {
        raw += token;
        hooks.onEvent?.({
          type: 'model_delta',
          indicator: indicator.indicator,
          step,
          content: token
        });
      }
    );

    lastModelText = aiResult.content || raw;
    const action = extractJSON(lastModelText);
    if (!action || typeof action !== 'object') {
      observations.push({
        type: 'parse_error',
        content: truncate(lastModelText, 1200),
        message: '模型没有返回有效 JSON'
      });
      await emit(hooks, trace, {
        type: 'parse_error',
        indicator: indicator.indicator,
        step,
        message: '模型没有返回有效 JSON'
      });
      continue;
    }

    if (action.type === 'final') {
      return normalizeFinalResult(indicator, action.result || action, observations);
    }

    if (action.type !== 'tool_call') {
      observations.push({
        type: 'protocol_error',
        action: truncate(JSON.stringify(action), 1200),
        message: '模型返回了未知 action type'
      });
      continue;
    }

    const toolName = String(action.tool || '').trim();
    const args = action.args || {};
    await emit(hooks, trace, {
      type: 'tool_call',
      indicator: indicator.indicator,
      step,
      tool: toolName,
      thought: action.thought || '',
      args: redactToolArgs(args)
    });

    const toolResult = await runSafeTool(toolName, args, context);
    const compactResult = compactToolResult(toolName, toolResult, context.maxResultChars);
    const callRecord = {
      indicator: indicator.indicator,
      step,
      tool: toolName,
      args: redactToolArgs(args),
      result: compactResult
    };

    toolCalls.push(callRecord);
    observations.push(callRecord);

    await emit(hooks, trace, {
      type: 'tool_result',
      indicator: indicator.indicator,
      step,
      tool: toolName,
      success: toolResult.success !== false,
      summary: summarizeToolResult(toolName, compactResult)
    });
  }

  return {
    indicator: indicator.indicator,
    value: '',
    filePath: '',
    matchedKeyword: '',
    keywordMeaning: '',
    evidence: '',
    confidence: 0,
    status: 'failed',
    reason: '达到最大 Agent 步数，模型未给出最终结果',
    observations: observations.slice(-5),
    rawModelText: truncate(lastModelText, 2000)
  };
}

async function runSafeTool(toolName, args, context) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    return { success: false, error: `tool is not allowed: ${toolName}` };
  }

  const safeArgs = sanitizeToolArgs(toolName, args, context);
  if (safeArgs.success === false) return safeArgs;

  return executeTool(toolName, safeArgs);
}

function sanitizeToolArgs(toolName, args = {}, context) {
  const safe = { ...args };

  if (toolName === 'search_files') {
    safe.roots = context.roots;
    safe.maxFiles = clampNumber(safe.maxFiles, 1, 20000, 5000);
    safe.maxResults = clampNumber(safe.maxResults, 1, 200, 50);
    safe.patterns = normalizeList(safe.patterns || safe.pattern || safe.query).slice(0, 20);
    safe.extensions = normalizeList(safe.extensions || safe.exts).slice(0, 20);
    delete safe.root;
    delete safe.diskRoot;
    delete safe.diskRoots;
    return safe;
  }

  if (FILE_ARG_TOOLS.has(toolName)) {
    const file = safe.file || safe.path;
    if (!file) return { success: false, error: 'file/path is required' };
    if (!isPathInsideRoots(file, context.roots)) {
      return { success: false, error: 'file path is outside allowed roots' };
    }
    safe.file = file;
    safe.lines = clampNumber(safe.lines, 1, 500, safe.lines || 120);
    safe.maxMatches = clampNumber(safe.maxMatches, 1, 100, safe.maxMatches || 20);
    safe.maxBytes = clampNumber(safe.maxBytes, 1024, 16 * 1024 * 1024, safe.maxBytes || undefined);
    safe.maxLineLength = clampNumber(safe.maxLineLength, 100, 2000, safe.maxLineLength || 500);
    return safe;
  }

  return safe;
}

function buildAgentPrompt(indicator, candidates, context, observations) {
  return `你是医疗设备日志采集 Agent。你不能直接访问磁盘，只能通过程序工具采集证据。

任务：
- 厂商：${context.vendor || '未知'}
- 设备类型：${context.deviceType || '未知'}
- 型号：${context.model || '未知'}
- 当前指标：${indicator.indicator}
- 指标参考关键字：${indicator.keyword || ''}
- 指标备用关键字：${normalizeList(indicator.synonyms).join(', ')}
- 参考文件：${indicator.filePattern || indicator.file_pattern || ''}
- 关键字和含义：${indicator.keywordMeaning || indicator.keyword_meaning || ''}
- 允许根目录：${context.roots.join(' | ')}

可用工具：
${listTools().map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

知识库候选：
${JSON.stringify(candidates, null, 2)}

已观察到的工具结果：
${JSON.stringify(observations.slice(-8), null, 2)}

你必须只返回 JSON，不要 Markdown，不要额外解释。

如果还需要查看文件，返回：
{
  "type": "tool_call",
  "thought": "简短说明为什么调用这个工具",
  "tool": "search_files",
  "args": {}
}

如果已经可以给出采集结论，返回：
{
  "type": "final",
  "result": {
    "indicator": "${indicator.indicator}",
    "value": "",
    "filePath": "",
    "matchedKeyword": "",
    "keywordMeaning": "",
    "evidence": "",
    "confidence": 0,
    "status": "success",
    "reason": ""
  }
}

规则：
- 优先使用知识库候选和模板已有英文关键字。
- 日志中一般不会出现中文，搜索关键字必须使用英文、数字或符号。
- 不要要求读取完整大文件，优先 read_tail/read_sample/search_text/parse_xml。
- 最终结果必须有文件路径和证据；没有证据时 status 应为 "not_found"。`;
}

function loadKnowledgeCandidates(indicator, context) {
  if (context.maxCandidates <= 0) return [];
  try {
    return getKnowledgeCandidates({
      vendor: context.vendor,
      deviceType: context.deviceType,
      model: context.model,
      indicator: indicator.indicator,
      status: 'draft',
      limit: context.maxCandidates
    }).map(candidate => ({
      id: candidate.id,
      indicatorName: candidate.indicatorName,
      indicatorCode: candidate.indicatorCode,
      ruleType: candidate.ruleType,
      parserType: candidate.parserType,
      filePatterns: candidate.filePatterns,
      fileNamePatterns: candidate.fileNamePatterns,
      keywords: candidate.keywords,
      selector: candidate.selector,
      operation: candidate.operation,
      meaning: candidate.meaning,
      evidenceExample: candidate.evidenceExample,
      confidence: candidate.confidence
    }));
  } catch {
    return [];
  }
}

function normalizeFinalResult(indicator, result, observations) {
  const status = String(result.status || '').trim() || (result.evidence ? 'success' : 'not_found');
  return {
    indicator: result.indicator || indicator.indicator,
    value: String(result.value || ''),
    filePath: String(result.filePath || result.file_path || ''),
    matchedKeyword: String(result.matchedKeyword || result.matched_keyword || result.keyword || ''),
    keywordMeaning: String(result.keywordMeaning || result.keyword_meaning || ''),
    evidence: String(result.evidence || result.line || ''),
    confidence: clampNumber(result.confidence, 0, 100, status === 'success' ? 70 : 0),
    status,
    reason: String(result.reason || ''),
    observations: observations.slice(-5)
  };
}

function createPendingResult(indicator, status, prompt) {
  return {
    indicator: indicator.indicator,
    value: '',
    filePath: '',
    matchedKeyword: '',
    keywordMeaning: '',
    evidence: '',
    confidence: 0,
    status,
    reason: 'dryRun only',
    prompt
  };
}

function compactToolResult(toolName, result, maxChars) {
  const compact = { ...result };
  if (Array.isArray(compact.files)) compact.files = compact.files.slice(0, 20);
  if (Array.isArray(compact.matches)) compact.matches = compact.matches.slice(0, 20);
  if (Array.isArray(compact.lines)) compact.lines = compact.lines.slice(0, 80);
  if (Array.isArray(compact.first)) compact.first = compact.first.slice(0, 5);
  if (Array.isArray(compact.last)) compact.last = compact.last.slice(0, 5);
  if (typeof compact.text === 'string') compact.text = truncate(compact.text, 4000);
  const json = JSON.stringify(compact);
  return JSON.parse(truncateJson(json, maxChars));
}

function summarizeToolResult(toolName, result) {
  if (result.success === false) return result.error || '工具调用失败';
  if (toolName === 'search_files') return `找到 ${result.count || 0} 个文件，检查 ${result.checked?.files || 0} 个文件`;
  if (toolName === 'search_text') return `命中 ${result.count || 0} 行`;
  if (toolName === 'parse_xml') return `提取 ${result.count || 0} 个 XML 值`;
  if (toolName === 'count_rows') return `行数 ${result.rows || 0}`;
  return '工具返回成功';
}

function redactToolArgs(args = {}) {
  const clone = { ...args };
  delete clone.apiKey;
  return clone;
}

function normalizeIndicators(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return { indicator: item.trim() };
    return {
      indicator: String(item.indicator || item.name || item.indicatorName || '').trim(),
      keyword: item.keyword || '',
      synonyms: item.synonyms || [],
      filePattern: item.filePattern || item.file_pattern || '',
      keywordMeaning: item.keywordMeaning || item.keyword_meaning || ''
    };
  }).filter(item => item.indicator);
}

function normalizeRoots(value) {
  return normalizeList(value).map(root => {
    const text = String(root || '').trim();
    return /^[a-z]:$/i.test(text) ? `${text}\\` : text;
  });
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|;|；|,/).map(item => item.trim()).filter(Boolean);
}

function isPathInsideRoots(filePath, roots) {
  const resolvedFile = path.resolve(filePath).toLowerCase();
  return roots.some(root => {
    const resolvedRoot = path.resolve(root).toLowerCase();
    return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`);
  });
}

async function emit(hooks, trace, event) {
  trace.push({ ...event, time: new Date().toISOString() });
  hooks.onEvent?.(event);
  await new Promise(resolve => setImmediate(resolve));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function truncateJson(json, maxChars) {
  if (json.length <= maxChars) return json;
  return JSON.stringify({
    success: false,
    truncated: true,
    message: '工具结果过长，已截断摘要',
    preview: json.slice(0, maxChars)
  });
}
