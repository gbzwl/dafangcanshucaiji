/**
 * Express backend for the CT/MR/DR collection Agent.
 * 新增：SQLite文件索引、三级匹配、设备模板管理、可信度评估
 */

// 全局错误处理，防止未捕获异常导致进程退出
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import iconv from 'iconv-lite';
import { fileURLToPath } from 'url';
import { getAvailableDisks } from './core/scanner.js';
import {
  initIndex,
  buildFileIndex,
  checkIndexStatus
} from './core/matcher.js';
import { parseTemplate, generateResultExcel, generateKnowledgeImportTemplateExample } from './core/excel-handler.js';
import { callAIStream, extractJSON, testAIConnection, normalizeAIOptions } from './core/ai-service.js';
import {
  initExperienceDB,
  saveCollectionRecord,
  getAllRecords,
  getRecordDetail,
  updateRecord,
  deleteRecord,
  importRawExperienceWorkbook,
  getRawExperienceRecords,
  updateRawExperienceRecord,
  clearRawExperienceRecords,
  getRawExperienceByIds,
  saveKnowledgeCandidate,
  getKnowledgeCandidates,
  clearKnowledgeCandidates
} from './core/experience-library.js';
import { runAgentCollection } from './core/agent-runner.js';
import { getIndicatorCatalog, getIndicatorTemplatePath, listIndicatorCatalogs, normalizeDeviceType } from './core/indicator-catalog.js';
import {
  initAgentStore,
  listGeneratedTools,
  listApiProfiles,
  getActiveApiProfile,
  getApiProfile,
  saveApiProfile,
  activateApiProfile,
  deleteApiProfile,
  ensureAgentSession,
  getAgentSessionContext,
  appendAgentMessage,
  getAgentMessages,
  closeAgentSession,
  saveAgentMemory
} from './core/agent-store.js';

function persistCollectionKnowledge(recordId, body = {}) {
  const summary = { verified: 0, pending: 0, failed: 0, candidates: [] };
  for (const rule of body.rules || []) {
    const status = rule.status === 'user_verified'
      ? 'verified'
      : rule.status === 'needs_review' ? 'needs_review' : 'failed';
    summary[status === 'verified' ? 'verified' : status === 'needs_review' ? 'pending' : 'failed']++;

    if (status === 'verified') {
      saveAgentMemory({
        memoryType: 'user_verified_result',
        deviceType: body.deviceType || '',
        vendor: body.vendor || '',
        model: body.model || '',
        indicatorId: rule.indicatorCode || rule.indicator_code || '',
        indicatorName: rule.indicator || '',
        title: `${rule.indicator || '指标'}：人工确认`,
        content: JSON.stringify({
          value: rule.value || '',
          filePath: rule.filePattern || rule.file_path || rule.actualPath || '',
          matchedKeyword: rule.keyword || '',
          meaning: rule.keywordMeaning || rule.keyword_meaning || ''
        }),
        sourceTaskId: String(recordId || ''),
        evidence: rule.evidence ? [{ content: rule.evidence, fileMtime: rule.fileMtime || rule.file_mtime || '' }] : [],
        confidence: rule.confidence || 0,
        status: 'verified'
      });
    }

    const sourcePath = rule.actualPath || rule.filePath || rule.file_path || rule.filePattern || '';
    const candidate = saveKnowledgeCandidate({
      sourceRecordId: recordId,
      vendor: body.vendor || '',
      deviceType: body.deviceType || '',
      model: body.model || '',
      indicatorName: rule.indicator || '',
      indicatorCode: rule.indicatorCode || rule.indicator_code || '',
      ruleType: inferRuleTypeFromPath(sourcePath),
      parserType: inferParserType([sourcePath], [path.basename(sourcePath)]),
      filePatterns: sourcePath ? [sourcePath.replace(/^[a-z]:[\\/]/i, '')] : [],
      fileNamePatterns: sourcePath ? [path.basename(sourcePath)] : [],
      keywords: [rule.keyword || '', ...(Array.isArray(rule.synonyms) ? rule.synonyms : String(rule.synonyms || '').split(/[;；,，]/))].filter(Boolean),
      operation: status === 'failed' ? 'avoid_failed_path' : 'extract_value',
      meaning: rule.keywordMeaning || rule.keyword_meaning || rule.reason || '',
      evidenceExample: rule.evidence || '',
      aiReason: `来源：采集记录 #${recordId}；状态：${status}`,
      confidence: rule.confidence || 0,
      status,
      createdBy: 'collection_result'
    });
    summary.candidates.push(candidate);
  }
  return summary;
}

function inferRuleTypeFromPath(filePath = '') {
  const lower = String(filePath || '').toLowerCase();
  if (/\.(xml|html?)$/.test(lower)) return 'xml_selector';
  if (/\.(log|txt|csv|gz)$/.test(lower)) return 'text_keyword';
  return 'unknown';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 9091;
const RUNTIME_SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const knowledgeGenerationJobs = new Map();

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// 文件上传配置
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// 目录初始化
const TEMP_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.join(__dirname, 'temp');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const EXPERIENCE_DIR = path.join(__dirname, 'experiences');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
if (!fs.existsSync(EXPERIENCE_DIR)) fs.mkdirSync(EXPERIENCE_DIR, { recursive: true });

let agentRuntimeConfig = {
  profileId: 0,
  provider: 'api',
  backend: 'api',
  baseUrl: process.env.AI_BASE_URL || 'https://api.deepseek.com',
  model: process.env.AI_MODEL || 'deepseek-chat',
  apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
  outputMode: 'auto'
};

const agentStoreReady = initAgentStore(TEMP_DIR).then(() => {
  const savedProfile = getActiveApiProfile();
  if (savedProfile) agentRuntimeConfig = runtimeConfigFromProfile(savedProfile);
  console.log('Agent 任务、记忆与 API 配置数据库已初始化');
}).catch(err => {
  console.warn('Agent 数据库初始化失败:', err.message);
  throw err;
});

// 初始化采集经验库
initExperienceDB(TEMP_DIR).then(() => {
  console.log('采集经验库已初始化');
}).catch(err => {
  console.warn('经验库初始化失败:', err.message);
});

// 初始化文件索引
let indexReady = false;
initIndex(TEMP_DIR).then(() => {
  indexReady = true;
  console.log('SQLite 文件索引已初始化');
}).catch(err => {
  console.warn('文件索引初始化失败，将使用直接扫描模式:', err.message);
  indexReady = true; // 即使索引失败也允许服务运行
});

// ============ API 路由 ============

// 健康检查
function buildKnowledgeCandidateBatchPrompt(records) {
  return `你是医疗设备日志采集知识库设计助手。请批量拆解以下旧采集经验，每条输入对应一条候选知识规则。
候选规则只是线索，不能把样例盘符、样例值或中文说明当作固定关键字。keywords 只允许英文、数字或符号。
只返回 JSON，不要 Markdown。格式：{"items":[{"rawExperienceId":1,"ruleType":"text_keyword","parserType":"text","filePatterns":[],"fileNamePatterns":[],"keywords":[],"selector":"","operation":"search_text","valuePattern":"","meaning":"","evidenceExample":"","confidence":0,"aiReason":""}]}

输入：
${JSON.stringify(records.map(record => ({
    rawExperienceId: record.id,
    vendor: record.vendor,
    deviceType: record.deviceType,
    model: record.model,
    indicatorName: record.indicatorName,
    indicatorCode: record.indicatorCode,
    filePath: record.filePathRaw,
    pathFragments: record.pathFragments,
    fileNames: record.fileNames,
    keywordMeaning: record.keywordMeaningRaw,
    value: record.value,
    matchedKeyword: record.matchedKeyword,
    evidence: record.evidence
  })), null, 2)}`;
}

function buildBaselineCandidate(record) {
  const keywords = normalizeCandidateKeywords(record.matchedKeyword || '');
  return {
    rawExperienceId: record.id,
    vendor: record.vendor,
    deviceType: record.deviceType,
    model: record.model,
    indicatorName: record.indicatorName,
    indicatorCode: record.indicatorCode,
    ruleType: inferRuleTypeFromPath(record.filePathRaw || record.fileNames?.[0] || ''),
    parserType: inferParserType(record.pathFragments || [], record.fileNames || []),
    filePatterns: record.pathFragments || [],
    fileNamePatterns: record.fileNames || [],
    keywords,
    operation: keywords.length ? 'search_text' : 'unknown',
    meaning: record.keywordMeaningRaw || '',
    evidenceExample: record.evidence || record.keywordMeaningRaw || '',
    aiReason: '由旧表字段直接形成的基础经验，等待模型提炼和新设备验证',
    confidence: record.filePathRaw && (record.keywordMeaningRaw || record.evidence) ? 55 : 30,
    status: 'draft',
    createdBy: 'program:legacy_import'
  };
}

function normalizeGeneratedCandidate(record, parsed, aiResult = {}) {
  const filePatterns = normalizeCandidateArray(parsed.filePatterns || parsed.file_patterns || parsed.filePattern);
  const fileNamePatterns = normalizeCandidateArray(parsed.fileNamePatterns || parsed.file_name_patterns || parsed.fileNamePattern);
  const keywords = normalizeCandidateKeywords(parsed.keywords || parsed.keywordCandidates || parsed.keyword_candidates || parsed.keyword);

  return {
    rawExperienceId: record.id,
    vendor: record.vendor,
    deviceType: record.deviceType,
    model: record.model,
    indicatorName: record.indicatorName,
    indicatorCode: record.indicatorCode,
    ruleType: parsed.ruleType || parsed.rule_type || 'unknown',
    parserType: parsed.parserType || parsed.parser_type || inferParserType(filePatterns, fileNamePatterns),
    filePatterns: filePatterns.length ? filePatterns : (record.pathFragments || []),
    fileNamePatterns: fileNamePatterns.length ? fileNamePatterns : (record.fileNames || []),
    keywords,
    selector: parsed.selector || '',
    operation: parsed.operation || '',
    valuePattern: parsed.valuePattern || parsed.value_pattern || '',
    meaning: parsed.meaning || '',
    evidenceExample: parsed.evidenceExample || parsed.evidence_example || record.keywordMeaningRaw || '',
    aiReason: parsed.aiReason || parsed.ai_reason || parsed.reason || '',
    confidence: parsed.confidence || 0,
    status: 'draft',
    createdBy: `ai:${aiResult.backend || 'unknown'}:${aiResult.model || 'unknown'}`
  };
}

async function generateKnowledgeCandidatesForRecords(records = [], options = {}) {
  const {
    backend = '',
    provider = '',
    baseUrl = '',
    apiKey = '',
    aiModel = '',
    modelName = '',
    dryRun = false,
    replaceExistingDraft = true,
    limit = records.length || 10
  } = options;

  const selectedRecords = records.slice(0, Math.max(1, Number(limit) || 10));
  const generated = [];
  const failures = [];
  const batchSize = 8;

  for (let offset = 0; offset < selectedRecords.length; offset += batchSize) {
    const batch = selectedRecords.slice(offset, offset + batchSize);
    try {
      const prompt = buildKnowledgeCandidateBatchPrompt(batch);
      if (dryRun) {
        generated.push({ rawExperienceIds: batch.map(record => record.id), prompt });
        continue;
      }

      const aiResult = await callAIStream(
        prompt,
        {
          ...mergeAgentAIOptions({
            backend,
            provider,
            baseUrl,
            apiKey,
            model: modelName || aiModel || undefined
          }),
          maxTokens: 6000,
          timeout: 5 * 60 * 1000,
          formatJson: false
        }
      );
      const parsed = extractJSON(aiResult.content);
      const items = Array.isArray(parsed) ? parsed : parsed?.items;
      if (!Array.isArray(items)) {
        failures.push(...batch.map(record => ({ rawExperienceId: record.id, indicator: record.indicatorName || '', error: 'AI 未返回有效批量 JSON' })));
        continue;
      }

      for (const record of batch) {
        const item = items.find(entry => Number(entry.rawExperienceId) === Number(record.id));
        if (!item) {
          failures.push({ rawExperienceId: record.id, indicator: record.indicatorName || '', error: 'AI 批量结果缺少对应记录' });
          continue;
        }
        const candidate = normalizeGeneratedCandidate(record, item, aiResult);
        if (replaceExistingDraft && record.id) clearKnowledgeCandidates({ rawExperienceId: record.id, status: 'draft' });
        generated.push(saveKnowledgeCandidate(candidate));
      }
    } catch (error) {
      failures.push(...batch.map(record => ({ rawExperienceId: record.id, indicator: record.indicatorName || '', error: error.message })));
    }
    options.onProgress?.({ processed: Math.min(offset + batch.length, selectedRecords.length), total: selectedRecords.length, generated: generated.length, failed: failures.length });
  }

  return {
    generated,
    failures,
    failureSummary: summarizeKnowledgeGenerationFailures(failures),
    count: generated.length,
    failCount: failures.length
  };
}

function summarizeKnowledgeGenerationFailures(failures = []) {
  const groups = new Map();
  for (const failure of failures) {
    const reason = normalizeKnowledgeGenerationError(failure.error);
    groups.set(reason, (groups.get(reason) || 0) + 1);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

function normalizeKnowledgeGenerationError(error = '') {
  const text = String(error || '').trim();
  if (!text) return '未知错误';
  if (/api key|unauthorized|401|403|未输入|未提供/i.test(text)) return 'API Key 未配置或无效';
  if (/not found|model.*not|模型.*不存在|404/i.test(text)) return '模型名称不正确或 API 不支持该模型';
  if (/timeout|timed out|超时/i.test(text)) return '模型响应超时';
  if (/json|有效 JSON|格式/i.test(text)) return '模型没有按 JSON 格式返回';
  if (/fetch|connect|ECONNREFUSED|ENOTFOUND|network|连接/i.test(text)) return '模型服务连接失败';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function normalizeCandidateArray(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n|;|；|,/);
  return [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20);
}

function normalizeCandidateKeywords(value) {
  return normalizeCandidateArray(value)
    .filter(item => !/[^\x00-\x7F]/.test(item))
    .map(item => item.replace(/[^A-Za-z0-9_.:/\\*\-\s]/g, '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function inferParserType(filePatterns = [], fileNamePatterns = []) {
  const joined = [...filePatterns, ...fileNamePatterns].join(' ').toLowerCase();
  if (joined.includes('.xml')) return 'xml';
  if (joined.includes('.gz')) return 'gzip_text';
  if (joined.includes('.csv')) return 'csv';
  if (joined.includes('.tsv')) return 'tsv';
  if (joined.includes('.htm')) return 'html';
  if (joined.includes('.ini') || joined.includes('.cfg') || joined.includes('.conf')) return 'key_value';
  if (joined.includes('.log') || joined.includes('.txt')) return 'text';
  return '';
}

function mergeAgentAIOptions(options = {}) {
  return {
    provider: 'api',
    backend: 'api',
    baseUrl: options.baseUrl || agentRuntimeConfig.baseUrl || '',
    apiKey: options.apiKey || agentRuntimeConfig.apiKey || '',
    model: options.model || options.aiModel || agentRuntimeConfig.model || '',
    timeout: options.timeout,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    outputMode: options.outputMode || agentRuntimeConfig.outputMode || 'auto'
  };
}

function normalizeAgentConfigInput(input = {}) {
  const baseUrl = input.baseUrl || input.url || defaultBaseUrl();
  return {
    profileId: Number(input.profileId || 0),
    provider: 'api',
    backend: 'api',
    baseUrl,
    model: input.model || input.aiModel || defaultModel(),
    apiKey: input.apiKey || '',
    outputMode: input.outputMode || 'auto'
  };
}

function publicAgentConfig(config = agentRuntimeConfig) {
  return {
    profileId: Number(config.profileId || config.id || 0),
    provider: config.provider,
    backend: config.backend,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!config.apiKey,
    apiKeyHint: config.apiKeyHint || '',
    outputMode: config.outputMode || 'auto'
  };
}

function runtimeConfigFromProfile(profile) {
  return {
    profileId: Number(profile.id || 0),
    provider: 'api',
    backend: 'api',
    baseUrl: profile.baseUrl || defaultBaseUrl(),
    model: profile.model || defaultModel(),
    apiKey: profile.apiKey || '',
    apiKeyHint: profile.apiKeyHint || '',
    outputMode: profile.outputMode || 'auto'
  };
}

function defaultBaseUrl(provider) {
  return process.env.AI_BASE_URL || 'https://api.deepseek.com';
}

function defaultModel(provider) {
  return process.env.AI_MODEL || 'deepseek-chat';
}

function normalizeAgentResultsForExcel(results = []) {
  return results.map(item => ({
    indicator: item.indicator || '',
    value: item.value || (item.status === 'success' ? '已采集' : '未找到'),
    file_path: item.filePath || item.file_path || '',
    matchedKeyword: item.matchedKeyword || item.matched_keyword || '',
    synonyms: item.synonyms || [],
    keywordMeaning: item.keywordMeaning || item.keyword_meaning || item.reason || '',
    match_line: item.evidence || item.match_line || '',
    dataTimestamp: item.dataTimestamp || item.data_timestamp || '',
    fileMtime: item.fileMtime || item.file_mtime || '',
    evidenceLevel: item.evidenceLevel || item.evidence_level || 'NONE',
    confidence: item.confidence || 0,
    matchMethod: item.matchMethod || item.match_method || `Agent ${item.status || 'unknown'}`,
    sourceType: item.sourceType || item.source_type || 'agent_collection',
    success: item.status === 'success'
  }));
}

function normalizeAgentCollectionBody(body = {}, sessionContext = {}) {
  const allIndicators = body.indicators || body.rules || [];
  const explicit = filterIndicatorsByInstruction(allIndicators, body.message || body.instruction || '');
  const selectedIds = Array.isArray(sessionContext.selectedIndicatorIds) ? sessionContext.selectedIndicatorIds : [];
  const selected = selectedIds.length
    ? allIndicators.filter(item => selectedIds.includes(String(item?.indicatorId || item?.id || '').trim()))
    : [];
  return {
    roots: body.roots || body.diskRoots || (body.diskRoot ? [body.diskRoot] : []),
    indicators: explicit.selectionWasExplicit ? explicit.indicators : (selected.length ? selected : explicit.indicators),
    vendor: body.vendor || '',
    deviceType: body.deviceType || '',
    model: body.deviceModel || body.machineModel || body.model || '',
    dryRun: body.dryRun,
    agentProfile: body.agentProfile || ''
  };
}

function filterIndicatorsByInstruction(indicators = [], instruction = '') {
  if (!Array.isArray(indicators)) return { indicators: [], selectionWasExplicit: false };

  const normalizedIndicators = indicators.filter(item => {
    const name = typeof item === 'string' ? item : item?.indicator || item?.name || item?.indicatorName;
    return String(name || '').trim();
  });
  if (normalizedIndicators.length <= 1) return { indicators: normalizedIndicators, selectionWasExplicit: normalizedIndicators.length === 1 };

  const text = String(instruction || '').trim();
  if (!text) return { indicators: normalizedIndicators, selectionWasExplicit: false };
  if (/(全部|所有|全量|当前模板|整张表|每个指标|all)/i.test(text)) {
    return { indicators: normalizedIndicators, selectionWasExplicit: true };
  }

  const matched = normalizedIndicators.filter(item => {
    const indicator = String(item.indicator || item.name || item.indicatorName || item || '').trim();
    const code = String(item.indicatorCode || item.indicator_code || item.code || '').trim();
    return isIndicatorMentioned(text, indicator) || (code && isIndicatorMentioned(text, code));
  });

  return {
    indicators: matched.length > 0 ? matched : normalizedIndicators,
    selectionWasExplicit: matched.length > 0
  };
}

function isIndicatorMentioned(text, indicator) {
  const value = String(indicator || '').trim();
  if (!value) return false;
  if (text.includes(value)) return true;

  const compactText = text.replace(/\s+/g, '');
  const compactValue = value.replace(/\s+/g, '');
  if (compactValue && compactText.includes(compactValue)) return true;

  const ascii = value.toLowerCase();
  if (/^[\x00-\x7F]+$/.test(ascii) && text.toLowerCase().includes(ascii)) return true;
  return false;
}

async function executeAgentCollection(body = {}, signal = null, sessionContext = {}) {
  const request = normalizeAgentCollectionBody(body, sessionContext);

  if (!Array.isArray(request.roots) || request.roots.length === 0) {
    throw new Error('请先选择目标磁盘，然后再开始采集。');
  }
  if (!Array.isArray(request.indicators) || request.indicators.length === 0) {
    throw new Error('请先选择 CT、MR 或 DR，并保留至少一个采集指标。');
  }

  const aiOptions = mergeAgentAIOptions({
    provider: body.provider,
    backend: body.backend,
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    model: body.modelName || body.aiModel,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
    timeout: body.timeout,
    outputMode: body.outputMode
  });
  if (signal) aiOptions.signal = signal;

  await pushAgentEventNow({
    type: 'request',
    message: '收到 Agent 采集请求',
    roots: request.roots,
    indicatorCount: request.indicators.length,
    ai: normalizeAIOptions(aiOptions)
  });

  const result = await runAgentCollection({
    vendor: request.vendor,
    deviceType: request.deviceType,
    model: request.model,
    roots: request.roots,
    indicators: request.indicators,
    aiOptions,
    dryRun: request.dryRun,
    agentProfile: request.agentProfile
  }, {
    onEvent: event => {
      if (signal?.aborted) return;
      pushAgentEvent(event);
    }
  });

  const excelResults = normalizeAgentResultsForExcel(result.results);
  const successCount = excelResults.filter(item => item.success).length;
  const scanLog = {
    scan_time: new Date().toLocaleString('zh-CN'),
    disk: request.roots.join(', '),
    total_files: result.toolCalls.reduce((sum, call) => sum
      + Number(call.result?.result?.checkedFiles || call.result?.result?.checked?.files || 0), 0),
    success_count: successCount,
    fail_count: excelResults.length - successCount,
    total_indicators: excelResults.length,
    duration: (result.durationMs / 1000).toFixed(2),
    template_rules: request.indicators.length,
    used_index: false,
    collector: 'agent'
  };

  if (!request.dryRun) {
    const outputPath = path.join(TEMP_DIR, 'Collection_Result.xlsx');
    generateResultExcel(excelResults, scanLog, outputPath);
  }

  return {
    ...result,
    scanLog,
    exportReady: !request.dryRun
  };
}

function detectAgentIntent(message = '') {
  const text = String(message || '').trim();
  if (!text) return 'empty';

  // 配置相关检测 - 更精确，仅当明确询问模型配置时才返回
  if (/(模型|AI|大模型|人工智能)/i.test(text) && /(配置|设置|参数|怎么用|怎么配置|告诉我)/i.test(text)) {
    return 'config';
  }
  if (text.includes('api key') || text.includes('base url') || text.includes('服务商')) {
    return 'config';
  }
  // 仅当明确以“开始扫描”、“开始采集”开头，或句子完全为采集相关时才触发
  const collectPatterns = ['^开始扫描', '^开始采集', '^扫描', '^采集'];
  const isExplicitCollect = collectPatterns.some(p => text.startsWith(p));
  // 如果句子只是简单的“扫描什么”之类，不触发自动收集，保留 chat 模式
  if (isExplicitCollect) return 'collect';
  // 仅当同时包含“帮我扫描/采集”且后面有具体指标描述时才触发
  if (/[帮我请我].*(扫描|采集).{1,50}/i.test(text)) {
    // 检查是否有具体的指标或设备描述，有的话才收集，无的话聊天
    if (/[的了及在吗].{1,30}/i.test(text)) return 'collect';
  }
  if (/(停止|中止|取消|暂停).*(采集|扫描|任务)?/i.test(text)) {
    return 'stop';
  }
  return 'chat';
}

function getAgentCollectPreflightMessage(body = {}, sessionContext = {}) {
  const { roots, indicators } = normalizeAgentCollectionBody(body, sessionContext);
  const missing = [];
  if (!Array.isArray(roots) || roots.length === 0) missing.push('目标磁盘');
  if (!Array.isArray(indicators) || indicators.length === 0) missing.push('设备类型和采集指标');
  if (missing.length === 0) return '';
  return `现在还不能开始采集，请先补充：${missing.join('、')}。`;
}

function selectConversationHistory(messages = [], maxChars = 60000) {
  const selected = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index];
    const size = String(item.content || '').length;
    if (selected.length > 0 && used + size > maxChars) break;
    selected.unshift(item);
    used += size;
  }
  return selected;
}

async function answerAgentChat(body = {}, signal = null) {
  const message = String(body.message || body.instruction || '').trim();
  const roots = Array.isArray(body.roots) ? body.roots : (body.roots ? [body.roots] : []);
  const indicators = Array.isArray(body.indicators)
    ? body.indicators
      .map((item, index) => ({
        sequence: index + 1,
        indicatorId: String(item?.indicatorId || item?.id || '').trim(),
        indicator: String(item?.indicator || item?.name || item?.indicatorName || '').trim(),
        indicatorCode: String(item?.indicatorCode || item?.indicator_code || item?.code || '').trim(),
        enabled: item?.enabled !== false
      }))
      .filter(item => item.indicator)
    : [];
  const indicatorContext = indicators.length > 0
    ? JSON.stringify(indicators, null, 2)
    : '当前没有加载采集指标。';
  const aiOptions = mergeAgentAIOptions({
    provider: body.provider,
    backend: body.backend,
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    model: body.modelName || body.aiModel,
    temperature: body.temperature,
    maxTokens: body.maxTokens || 2000,
    timeout: body.timeout,
    outputMode: body.outputMode
  });
  if (signal) aiOptions.signal = signal;

  const systemPrompt = `你是大放设备参数采集工具里的 Agent 助手。你需要像正常对话助手一样理解连续对话、代词和追问。
你可以进行自然对话，也可以回答用户关于模型配置、采集流程、知识库、模板字段和操作方式的问题。
只有用户明确要求开始采集时才进入采集流程。普通对话中不要假装已经扫描磁盘，也不要编造文件或采集结果。
如果用户在对话中定义、选择或确认了本次只采集一部分指标，请在正常回答末尾追加一行：
<<TASK_SELECTION_JSON>>{"indicatorIds":["指标ID"]}<</TASK_SELECTION_JSON>>
indicatorIds 必须来自下方指标预览表。没有形成明确子集时不要追加。该行只供程序保存任务范围，界面不会展示。

本次设备上下文：
- 厂商：${body.vendor || ''}
- 设备类型：${body.deviceType || ''}
- 型号：${body.model || ''}
- 已选根目录：${roots.join(' | ')}
- 当前采集指标数：${indicators.length}
- 当前模型：${aiOptions.provider} / ${aiOptions.model || '未填写'}
- 输出模式：${aiOptions.outputMode || 'auto'}

当前采集指标预览表（这是待采集任务，不代表已经取得结果）：
${indicatorContext}

Agent 个性化设定：
${body.agentProfile || '未设置'}`;
  const storedHistory = getAgentMessages(body.sessionId || RUNTIME_SESSION_ID, 200)
    .filter(item => item.role === 'user' || item.role === 'assistant')
    .map(item => ({ role: item.role, content: item.content }));
  const history = selectConversationHistory(storedHistory);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
  ];

  await pushAgentEventNow({
    type: 'chat_processing',
    message: `已载入本次会话的 ${history.length} 条消息，正在交给模型分析`
  });
let aiResult;
  try {
    aiResult = await callAIStream(message, {
      ...aiOptions,
      messages,
      formatJson: false,
      temperature: 0.3,
      maxTokens: body.maxTokens || 2000
    }, (token, meta = {}) => {
      pushAgentEvent({
        type: meta.type === 'reasoning' ? 'model_reasoning_delta' : 'model_delta',
        content: token
      });
    });
  } catch (e) {
    // 捕获 AI 模型输入错误（如图片输入不支持）并返回友好错误信息
    const errorMsg = e.message || '未知错误';
    if (/image|png|photo|picture/i.test(errorMsg)) {
      const friendlyError = '模型当前不支持图片输入，请使用文字描述进行提问。';
      await pushAgentEventNow({
        type: 'error',
        message: friendlyError
      });
      return res.json({ success: true, mode: 'chat', intent: 'chat', answer: friendlyError, sessionId: body.sessionId || RUNTIME_SESSION_ID });
    }
    console.error('AI 调用错误:', errorMsg);
    await pushAgentEventNow({
      type: 'error',
      message: '模型处理失败: ' + errorMsg
    });
    return res.json({ success: true, mode: 'chat', intent: 'chat', answer: '模型处理失败，请稍后重试。', sessionId: body.sessionId || RUNTIME_SESSION_ID });
  }

  if (!aiResult) {
    await pushAgentEventNow({
      type: 'error',
      message: 'AI 无响应'
    });
    return res.json({ success: true, mode: 'chat', intent: 'chat', answer: 'AI 无响应，请稍后重试。', sessionId: body.sessionId || RUNTIME_SESSION_ID });
  }

  const rawAnswer = aiResult.content || '我没有生成有效回复。';
  const selection = extractTaskSelection(rawAnswer, message, indicators);
  return {
    answer: rawAnswer.replace(/<<TASK_SELECTION_JSON>>[\s\S]*?<\/TASK_SELECTION_JSON>>/g, '').trim(),
    selectedIndicatorIds: selection
  };
}

function extractTaskSelection(answer, userMessage, indicators = []) {
  const marker = String(answer || '').match(/<<TASK_SELECTION_JSON>>([\s\S]*?)<\/TASK_SELECTION_JSON>>/);
  if (marker) {
    try {
      const parsed = JSON.parse(marker[1]);
      const allowed = new Set(indicators.map(item => item.indicatorId));
      const ids = [...new Set((parsed.indicatorIds || []).map(String).filter(id => allowed.has(id)))];
      if (ids.length > 0 && ids.length < indicators.length) return ids;
    } catch {}
  }

  const combined = `${userMessage || ''}\n${answer || ''}`;
  const mentioned = indicators.filter(item =>
    isIndicatorMentioned(combined, item.indicatorId)
    || isIndicatorMentioned(combined, item.indicator)
    || isIndicatorMentioned(combined, item.indicatorCode)
  ).map(item => item.indicatorId);
  const subsetLanguage = /(只|仅|这组|这一组|任务|重点|共\s*\d+\s*(个|项|条)|包含\s*\d+\s*(个|项|条))/i.test(combined);
  return subsetLanguage && mentioned.length > 0 && mentioned.length < indicators.length
    ? [...new Set(mentioned)]
    : [];
}

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.0.0',
    platform: process.platform,
    indexReady,
    sessionId: RUNTIME_SESSION_ID
  });
});

// 获取可用磁盘列表
app.get('/api/v1/indicator-catalogs', (req, res) => {
  try {
    res.json({ success: true, catalogs: listIndicatorCatalogs(TEMPLATES_DIR) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v1/agent/session/:id/messages', async (req, res) => {
  try {
    await agentStoreReady;
    const sessionId = req.params.id || RUNTIME_SESSION_ID;
    ensureAgentSession(sessionId);
    res.json({ success: true, sessionId, messages: getAgentMessages(sessionId, 200) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/v1/indicator-catalogs/:deviceType', (req, res) => {
  try {
    const deviceType = normalizeDeviceType(req.params.deviceType);
    const indicators = getIndicatorCatalog(TEMPLATES_DIR, deviceType);
    res.json({ success: true, deviceType, indicators, count: indicators.length });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/v1/indicator-catalogs/:deviceType/download', (req, res) => {
  try {
    const deviceType = normalizeDeviceType(req.params.deviceType);
    res.download(getIndicatorTemplatePath(TEMPLATES_DIR, deviceType), `${deviceType}采集任务模板.xlsx`);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.get('/api/v1/tools', (req, res) => {
  try {
    res.json({ success: true, tools: listGeneratedTools({ status: req.query.status || '', limit: req.query.limit || 100 }) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/tools/:name', async (req, res) => {
  res.status(410).json({ success: false, error: '固定工具调用接口已停用，工具由外部 API 在 Agent 任务中动态生成' });
});

app.get('/api/v1/agent/config', async (req, res) => {
  try {
    await agentStoreReady;
    res.json({
      success: true,
      config: publicAgentConfig(agentRuntimeConfig),
      profiles: listApiProfiles()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/agent/config', async (req, res) => {
  try {
    await agentStoreReady;
    const profileId = Number(req.body?.profileId || 0);
    if (profileId) {
      agentRuntimeConfig = runtimeConfigFromProfile(activateApiProfile(profileId));
    } else {
      agentRuntimeConfig = normalizeAgentConfigInput(req.body || {});
    }
    res.json({
      success: true,
      config: publicAgentConfig(agentRuntimeConfig),
      profiles: listApiProfiles()
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/agent/config/:id', async (req, res) => {
  try {
    await agentStoreReady;
    const result = deleteApiProfile(req.params.id);
    if (!result.deleted) return res.status(404).json({ success: false, error: 'API 历史配置不存在' });
    agentRuntimeConfig = result.active
      ? runtimeConfigFromProfile(result.active)
      : normalizeAgentConfigInput({ apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '' });
    res.json({
      success: true,
      config: publicAgentConfig(agentRuntimeConfig),
      profiles: listApiProfiles()
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/agent/test', async (req, res) => {
  try {
    await agentStoreReady;
    const body = req.body || {};
    const sourceProfile = body.profileId ? getApiProfile(body.profileId) : null;
    const input = normalizeAgentConfigInput({
      ...body,
      apiKey: body.apiKey || sourceProfile?.apiKey || ''
    });
    const result = await testAIConnection(input);
    if (result.success) {
      const savedProfile = saveApiProfile({
        ...input,
        sourceProfileId: body.profileId || 0
      });
      agentRuntimeConfig = runtimeConfigFromProfile(savedProfile);
    }
    res.json({
      ...result,
      config: publicAgentConfig(result.success ? agentRuntimeConfig : input),
      profiles: result.success ? listApiProfiles() : undefined
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/raw-experience/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const decodedFilename = iconv.decode(Buffer.from(req.file.originalname, 'latin1'), 'utf8');
    const result = importRawExperienceWorkbook(req.file.buffer, {
      vendor: req.body.vendor || '',
      deviceType: normalizeDeviceType(req.body.deviceType) || req.body.deviceType || '',
      model: req.body.model || '',
      sourceFile: decodedFilename
    });

    const shouldGenerate = String(req.body.generateCandidates ?? 'true') !== 'false';
    const generationOptions = {
      provider: req.body.provider || req.body.backend || '',
      backend: req.body.backend || req.body.provider || '',
      baseUrl: req.body.baseUrl || '',
      apiKey: req.body.apiKey || '',
      aiModel: req.body.aiModel || '',
      modelName: req.body.modelName || '',
      limit: result.records.length,
      replaceExistingDraft: true
    };
    const baselineCandidates = result.records.map(record => {
      clearKnowledgeCandidates({ rawExperienceId: record.id, status: 'draft' });
      return saveKnowledgeCandidate(buildBaselineCandidate(record));
    });
    let generationJobId = '';
    if (shouldGenerate && result.records.length > 0) {
      generationJobId = `knowledge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job = {
        id: generationJobId,
        status: 'queued',
        total: result.records.length,
        processed: 0,
        generated: 0,
        failed: 0,
        startedAt: new Date().toISOString(),
        finishedAt: '',
        error: ''
      };
      knowledgeGenerationJobs.set(generationJobId, job);
      setImmediate(() => {
        job.status = 'running';
        generateKnowledgeCandidatesForRecords(result.records, {
          ...generationOptions,
          onProgress: progress => Object.assign(job, progress)
        }).then(generation => {
          Object.assign(job, {
            status: generation.failCount ? 'completed_with_errors' : 'completed',
            processed: result.records.length,
            generated: generation.count,
            failed: generation.failCount,
            failureSummary: generation.failureSummary,
            finishedAt: new Date().toISOString()
          });
        }).catch(error => {
          Object.assign(job, { status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
          console.error('后台知识规则生成失败:', error.message);
        });
      });
    }

    res.json({
      success: true,
      filename: decodedFilename,
      count: result.count,
      sheets: result.sheets,
      baselineCount: baselineCandidates.length,
      generationQueued: shouldGenerate && result.records.length > 0,
      generationJobId,
      preview: result.records.slice(0, 20)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/v1/raw-experience/list', (req, res) => {
  try {
    const records = getRawExperienceRecords({
      vendor: req.query.vendor || '',
      deviceType: req.query.deviceType || '',
      model: req.query.model || '',
      indicator: req.query.indicator || '',
      sourceFile: req.query.sourceFile || '',
      importedAt: req.query.importedAt || '',
      limit: req.query.limit || 200
    });
    res.json({ success: true, records, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/v1/knowledge-candidates', (req, res) => {
  try {
    const records = getKnowledgeCandidates({ ...req.query, limit: Math.min(Number(req.query.limit) || 5000, 10000) });
    res.json({ success: true, records, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/v1/knowledge-generation/:id', (req, res) => {
  const job = knowledgeGenerationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: '知识生成任务不存在或服务已经重启' });
  res.json({ success: true, job });
});

app.put('/api/v1/raw-experience/:id', (req, res) => {
  try {
    const record = updateRawExperienceRecord(req.params.id, req.body || {});
    clearKnowledgeCandidates({ rawExperienceId: req.params.id, status: 'draft' });
    const candidate = saveKnowledgeCandidate(buildBaselineCandidate(record));
    res.json({ success: true, record, candidate });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/raw-experience', (req, res) => {
  try {
    const filters = req.body || {};
    const records = getRawExperienceRecords({ ...filters, limit: 10000 });
    for (const record of records) {
      clearKnowledgeCandidates({ rawExperienceId: record.id });
    }
    clearRawExperienceRecords(filters);
    res.json({ success: true, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/agent/chat', async (req, res) => {
  const requestController = new AbortController();
  req.on('aborted', () => requestController.abort());
  res.on('close', () => {
    if (!res.writableEnded) requestController.abort();
  });

  try {
    await agentStoreReady;
    const body = req.body || {};
    const message = String(body.message || body.instruction || '').trim();
    const intent = detectAgentIntent(message);
    const sessionId = body.sessionId || RUNTIME_SESSION_ID;
    ensureAgentSession(sessionId, {
      vendor: body.vendor || '',
      deviceType: body.deviceType || '',
      model: body.model || '',
      roots: Array.isArray(body.roots) ? body.roots : []
    });

    await pushAgentEventNow({
      type: 'chat_intent',
      message: intent === 'collect' ? '识别为采集任务' : '识别为普通对话',
      intent
    });

    if (intent === 'empty') {
      return res.json({ success: true, mode: 'chat', intent, answer: '请输入要交流的问题，或明确告诉我开始采集。' });
    }
    appendAgentMessage(sessionId, 'user', message);
    const sessionContext = getAgentSessionContext(sessionId);

    if (intent === 'collect') {
      const preflightMessage = getAgentCollectPreflightMessage(body, sessionContext);
      if (preflightMessage) {
        appendAgentMessage(sessionId, 'assistant', preflightMessage, { intent: 'collect_preflight' });
        return res.json({ success: true, mode: 'chat', intent: 'collect_preflight', answer: preflightMessage, sessionId });
      }
      const selectedRequest = normalizeAgentCollectionBody(body, sessionContext);
      await pushAgentEventNow({
        type: 'selection_confirmed',
        message: `本次按已确认范围采集 ${selectedRequest.indicators.length} 个指标`,
        indicatorCount: selectedRequest.indicators.length,
        indicators: selectedRequest.indicators.map(item => item.indicator || item.name || '')
      });
      const result = await executeAgentCollection(body, requestController.signal, sessionContext);
      const summary = `采集完成：成功 ${result.scanLog?.success_count || 0}/${result.scanLog?.total_indicators || 0}。结果等待人工确认。`;
      appendAgentMessage(sessionId, 'assistant', summary, { intent: 'collect', taskId: result.taskId || '' });
      return res.json({ ...result, mode: 'collect', intent, sessionId });
    }

    const chatResult = await answerAgentChat({ ...body, sessionId }, requestController.signal);
    if (chatResult.selectedIndicatorIds.length) {
      ensureAgentSession(sessionId, { selectedIndicatorIds: chatResult.selectedIndicatorIds });
    }
    appendAgentMessage(sessionId, 'assistant', chatResult.answer, {
      intent,
      selectedIndicatorIds: chatResult.selectedIndicatorIds
    });
    res.json({ success: true, mode: 'chat', intent, answer: chatResult.answer, selectedIndicatorIds: chatResult.selectedIndicatorIds, sessionId });
  } catch (err) {
    await pushAgentEventNow({
      type: 'error',
      message: err.message
    });
    res.status(500).json({ success: false, mode: 'chat', error: err.message });
  }
});

app.get('/api/v1/disks', (req, res) => {
  try {
    const disks = getAvailableDisks();
    res.json({ success: true, disks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 上传并解析 Excel 模板（支持新旧格式）
app.post('/api/v1/template/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const rules = parseTemplate(req.file.buffer);
    // 解码文件名（multer返回的是Latin-1编码，需要转为UTF-8）
    const decodedFilename = iconv.decode(Buffer.from(req.file.originalname, 'latin1'), 'utf8');
    res.json({
      success: true,
      rules,
      count: rules.length,
      filename: decodedFilename,
      format: 'task'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 下载采集任务模板示例
app.get('/api/v1/raw-experience/template', (req, res) => {
  try {
    const outputPath = path.join(TEMP_DIR, 'Knowledge_Import_Template.xlsx');
    generateKnowledgeImportTemplateExample(outputPath);
    res.download(outputPath, '旧表知识库导入模板.xlsx', (err) => {
      if (err) {
        res.status(500).json({ success: false, error: '下载失败' });
      }
      setTimeout(() => {
        try { fs.unlinkSync(outputPath); } catch {}
      }, 60000);
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ 设备模板管理 ============

// 获取设备模板列表
app.post('/api/v1/index/build', async (req, res) => {
  try {
    const { diskRoot } = req.body;
    if (!diskRoot) {
      return res.status(400).json({ success: false, error: '缺少 diskRoot 参数' });
    }

    const startTime = Date.now();
    const stats = await buildFileIndex(diskRoot);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    res.json({
      success: true,
      stats,
      duration: parseFloat(duration)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 查询索引状态
app.get('/api/v1/index/status/:diskRoot', (req, res) => {
  try {
    const diskRoot = decodeURIComponent(req.params.diskRoot);
    const status = checkIndexStatus(diskRoot);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ 采集任务 ============

// ============ Agent 运行过程 SSE ============

const waitForFlush = () => new Promise(resolve => setImmediate(resolve));

let agentStreamClients = [];

app.get('/api/v1/agent/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  res.socket.setNoDelay(true);
  agentStreamClients.push(res);

  res.write('data: {"type":"init","message":"Agent 流已连接"}\n\n');
  if (res.flush) res.flush();

  req.on('close', () => {
    agentStreamClients = agentStreamClients.filter(client => client !== res);
    console.log('[Agent SSE] 客户端断开连接');
  });
});

function pushAgentEvent(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  agentStreamClients.forEach(client => {
    try {
      client.write(message);
      if (client.flush) client.flush();
    } catch (err) {
      console.error('[Agent SSE] 推送失败', err.message);
    }
  });
}

async function pushAgentEventNow(data) {
  pushAgentEvent(data);
  await waitForFlush();
}

// 下载结果文件
app.get('/api/v1/result/download', (req, res) => {
  const filePath = path.join(TEMP_DIR, 'Collection_Result.xlsx');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: '结果文件不存在，请先执行采集' });
  }
  res.download(filePath, '设备参数采集结果.xlsx');
});

// ==================== 采集经验库 API ====================

// 获取经验库列表
app.get('/api/v1/experience/list', (req, res) => {
  try {
    const records = getAllRecords();
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按厂商和设备类型匹配经验（静态路由，必须在 :id 之前）
app.get('/api/v1/experience/:id', (req, res) => {
  try {
    const record = getRecordDetail(req.params.id);
    if (!record) {
      return res.json({ success: false, error: '记录不存在' });
    }
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 保存采集经验
app.post('/api/v1/experience/save', async (req, res) => {
  try {
    await agentStoreReady;
    const { vendor, deviceType, model, rules, successRate } = req.body;
    if (!vendor || !deviceType || !rules || !Array.isArray(rules)) {
      return res.json({ success: false, error: '缺少必要参数' });
    }

    const record = saveCollectionRecord({
      vendor,
      deviceType,
      model: model || '',
      rules,
      successRate: successRate || 0
    });
    const knowledge = persistCollectionKnowledge(record.id, req.body);

    res.json({ success: true, record, knowledge: { verified: knowledge.verified, pending: knowledge.pending, failed: knowledge.failed, generated: knowledge.candidates.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按厂商和设备类型匹配经验（POST方式，支持指标匹配）
app.put('/api/v1/experience/:id', (req, res) => {
  try {
    const { vendor, deviceType, model, rules, successRate } = req.body;
    const updated = updateRecord(req.params.id, {
      vendor,
      deviceType,
      model: model || '',
      rules,
      successRate: successRate || 0
    });

    if (!updated) {
      return res.json({ success: false, error: '记录不存在' });
    }

    res.json({ success: true, record: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除采集经验
app.delete('/api/v1/experience/:id', (req, res) => {
  try {
    clearKnowledgeCandidates({ sourceRecordId: req.params.id });
    const deleted = deleteRecord(req.params.id);
    if (!deleted) {
      return res.json({ success: false, error: '记录不存在' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 启动服务
const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`大放设备参数采集程序 v4.0 已启动: http://localhost:${PORT}`);
  console.log(`平台: ${process.platform}`);
  if (typeof process.send === 'function') process.send({ type: 'server-ready', port: Number(PORT) });
});

httpServer.on('error', (error) => {
  console.error('[server]', error.message);
  process.exit(1);
});

let shuttingDown = false;
function shutdownServer(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { closeAgentSession(RUNTIME_SESSION_ID); } catch {}
  console.log(`收到 ${signal}，正在关闭服务...`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdownServer('SIGTERM'));
process.on('SIGINT', () => shutdownServer('SIGINT'));
process.parentPort?.on('message', event => {
  if (event?.data?.type === 'shutdown') shutdownServer('APP_CLOSE');
});
