/**
 * Express 后端服务 - MRI 设备日志参数采集工具 v2.0
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
  scanReferenceFilesWithProgress,
  scanFileGlobsWithProgress,
  scanAllLogFilesWithProgressOptions,
  buildFileGlobCandidates,
  initIndex,
  buildFileIndex,
  checkIndexStatus
} from './core/matcher.js';
import { extractParameter, batchExtractWithProgress } from './core/extractor.js';
import { parseTemplate, generateResultExcel, generateTemplateExample } from './core/excel-handler.js';
import { callAI, callAIStream, checkAIService, getAvailableBackends, extractJSON, testAIConnection, normalizeAIOptions } from './core/ai-service.js';
import { aiMatchParameter, aiBatchMatch } from './core/ai-matcher.js';
import { discoverUnknownParameters, scanLogFiles, extractFieldsFromFile } from './core/ai-discoverer.js';
import { generateTemplate, saveTemplateToExcel, extractAvailableFields } from './core/ai-template-gen.js';
import {
  initExperienceDB,
  getVendorDevices,
  saveCollectionRecord,
  getAllRecords,
  getRecordDetail,
  findMatchingRecords,
  updateRecord,
  deleteRecord,
  deleteRecords,
  importRawExperienceWorkbook,
  getRawExperienceRecords,
  clearRawExperienceRecords,
  getRawExperienceByIds,
  saveKnowledgeCandidate,
  getKnowledgeCandidates,
  getKnowledgeCandidatesByIds,
  updateKnowledgeCandidateValidation,
  deleteKnowledgeCandidate,
  clearKnowledgeCandidates
} from './core/experience-library.js';
import { listTools, executeTool } from './core/tools/agent-tools.js';
import { validateKnowledgeCandidates } from './core/knowledge-validator.js';
import { runAgentCollection } from './core/agent-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 9091;

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
const TEMP_DIR = path.join(__dirname, 'temp');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const EXPERIENCE_DIR = path.join(__dirname, 'experiences');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
if (!fs.existsSync(EXPERIENCE_DIR)) fs.mkdirSync(EXPERIENCE_DIR, { recursive: true });

let agentRuntimeConfig = {
  provider: 'ollama',
  backend: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: '',
  apiKey: ''
};

// 初始化采集经验库
initExperienceDB().then(() => {
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

// AI 智能补全辅助函数
async function aiSmartFill(indicator, vendor, deviceType) {
  try {
    const prompt = `你是MRI/CT医疗设备日志分析专家。请根据以下信息，为采集指标生成搜索规则。

指标名称：${indicator}
设备厂商：${vendor || '未知'}
设备类型：${deviceType || '未知'}

请分析该指标可能对应的：
1. 参考文件路径关键词（如 MedCom/log, MriSiteData, SysUtil, LogData 等）
2. 标准关键词（日志中可能出现的英文字段名）
3. 备用关键词（同义词，用分号分隔）

只返回JSON格式，不要其他内容：
{"filePattern": "参考文件路径关键词", "keyword": "标准关键词", "synonyms": "备用关键词1;备用关键词2"}

如果无法确定，返回空字符串。`;

    const result = await callAI(prompt, { maxTokens: 200 });

    // 尝试解析 JSON 响应
    const jsonMatch = result.response?.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        filePattern: parsed.filePattern || '',
        keyword: parsed.keyword || '',
        synonyms: parsed.synonyms || ''
      };
    }

    return { filePattern: '', keyword: '', synonyms: '' };
  } catch (err) {
    console.warn('AI 智能补全失败:', err.message);
    return { filePattern: '', keyword: '', synonyms: '' };
  }
}

// ============ API 路由 ============

// 健康检查
function buildKnowledgeCandidatePrompt(record) {
  return `你是医疗设备日志采集知识库设计助手。
请把一条旧采集经验拆解成“候选知识规则”。候选规则只是草稿，后续必须由程序工具验证，不能把样例路径或样例值当成永久固定规则。

原始经验：
- 厂商：${record.vendor || ''}
- 设备类型：${record.deviceType || ''}
- 型号：${record.model || ''}
- 中文指标名：${record.indicatorName || ''}
- 指标标识：${record.indicatorCode || ''}
- 原始文件路径：${record.filePathRaw || ''}
- 已拆路径片段：${(record.pathFragments || []).join(' | ')}
- 已拆文件名：${(record.fileNames || []).join(' | ')}
- 扩展名：${(record.extensions || []).join(' | ')}
- 关键字及含义/证据摘要：${record.keywordMeaningRaw || ''}
- 数据来源：${record.dataSourceRaw || ''}
- 备注：${record.noteRaw || ''}

允许的 ruleType：
xml_selector, text_keyword, first_last_rows, row_count, column_sum, file_presence, composite_summary, unavailable_reason, unknown

字段说明：
- filePatterns：去掉盘符后的路径片段或通用路径模式，不要写死盘符。
- fileNamePatterns：文件名或文件名通配符。
- keywords：只放真正可能在文件里出现的英文/数字/符号关键字，不要放中文解释。
- selector：XML/HTML/结构化字段路径，例如 GeneralInfo.SerialNumber。
- operation：extract_value / search_text / count_rows / first_row / last_row / first_last_rows / sum_column / check_presence / summarize / unavailable。
- valuePattern：如果适合正则提取，写正则；不确定就留空。
- meaning：中文说明，说明这个规则为什么可能能采到该指标。
- evidenceExample：保留原始证据里的关键片段或示例。
- confidence：0-100，表示候选规则可信度。空路径、空证据、需要外部数据库时应较低。
- aiReason：简短说明拆解原因和待验证点。

只返回 JSON，不要 Markdown，不要额外解释。格式：
{
  "ruleType": "xml_selector",
  "parserType": "xml",
  "filePatterns": [],
  "fileNamePatterns": [],
  "keywords": [],
  "selector": "",
  "operation": "",
  "valuePattern": "",
  "meaning": "",
  "evidenceExample": "",
  "confidence": 0,
  "aiReason": ""
}`;
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
  const provider = options.provider || options.backend || agentRuntimeConfig.provider || agentRuntimeConfig.backend || 'ollama';
  const usesRuntimeKey = !options.apiKey && provider !== 'ollama';
  return {
    provider,
    backend: options.backend || provider,
    baseUrl: options.baseUrl || agentRuntimeConfig.baseUrl || '',
    apiKey: options.apiKey || (usesRuntimeKey ? agentRuntimeConfig.apiKey : ''),
    model: options.model || options.aiModel || agentRuntimeConfig.model || '',
    timeout: options.timeout,
    temperature: options.temperature,
    maxTokens: options.maxTokens
  };
}

function normalizeAgentConfigInput(input = {}) {
  const provider = input.provider || input.backend || 'ollama';
  const baseUrl = input.baseUrl || input.url || defaultBaseUrl(provider);
  return {
    provider,
    backend: input.backend || provider,
    baseUrl,
    model: input.model || input.aiModel || defaultModel(provider),
    apiKey: input.apiKey || ''
  };
}

function publicAgentConfig(config = agentRuntimeConfig) {
  return {
    provider: config.provider,
    backend: config.backend,
    baseUrl: config.baseUrl,
    model: config.model,
    hasApiKey: !!config.apiKey
  };
}

function defaultBaseUrl(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'deepseek') return 'https://api.deepseek.com';
  if (normalized === 'openai') return 'https://api.openai.com';
  if (normalized === 'ollama') return 'http://localhost:11434';
  return '';
}

function defaultModel(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'deepseek') return 'deepseek-chat';
  if (normalized === 'openai') return 'gpt-4o-mini';
  return '';
}

function normalizeAgentResultsForExcel(results = []) {
  return results.map(item => ({
    indicator: item.indicator || '',
    value: item.value || (item.status === 'success' ? '已采集' : '未找到'),
    file_path: item.filePath || item.file_path || '',
    matchedKeyword: item.matchedKeyword || item.matched_keyword || '',
    keywordMeaning: item.keywordMeaning || item.keyword_meaning || item.reason || '',
    match_line: item.evidence || item.match_line || '',
    confidence: item.confidence || 0,
    matchMethod: `Agent ${item.status || 'unknown'}`,
    success: item.status === 'success'
  }));
}

app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    platform: process.platform,
    indexReady
  });
});

// 获取可用磁盘列表
app.get('/api/v1/tools', (req, res) => {
  res.json({ success: true, tools: listTools() });
});

app.post('/api/v1/tools/:name', async (req, res) => {
  const result = await executeTool(req.params.name, req.body || {});
  res.status(result.success === false ? 400 : 200).json(result);
});

app.get('/api/v1/agent/config', (req, res) => {
  res.json({ success: true, config: publicAgentConfig(agentRuntimeConfig) });
});

app.post('/api/v1/agent/config', (req, res) => {
  try {
    agentRuntimeConfig = normalizeAgentConfigInput(req.body || {});
    res.json({
      success: true,
      config: publicAgentConfig(agentRuntimeConfig)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/agent/test', async (req, res) => {
  try {
    const input = normalizeAgentConfigInput(req.body || {});
    const result = await testAIConnection(input);
    if (result.success) {
      agentRuntimeConfig = input;
    }
    res.json({
      ...result,
      config: publicAgentConfig(input)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/raw-experience/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const decodedFilename = iconv.decode(Buffer.from(req.file.originalname, 'latin1'), 'utf8');
    const result = importRawExperienceWorkbook(req.file.buffer, {
      vendor: req.body.vendor || '',
      deviceType: req.body.deviceType || '',
      model: req.body.model || '',
      sourceFile: decodedFilename
    });

    res.json({
      success: true,
      filename: decodedFilename,
      count: result.count,
      sheets: result.sheets,
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
      limit: req.query.limit || 200
    });
    res.json({ success: true, records, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/raw-experience', (req, res) => {
  try {
    clearRawExperienceRecords(req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/knowledge-candidates/generate', async (req, res) => {
  try {
    const {
      rawExperienceIds = [],
      vendor = '',
      deviceType = '',
      model = '',
      indicator = '',
      limit = 10,
      backend = '',
      provider = '',
      baseUrl = '',
      apiKey = '',
      aiModel = '',
      modelName = '',
      dryRun = false,
      replaceExistingDraft = true
    } = req.body || {};

    let records = rawExperienceIds.length
      ? getRawExperienceByIds(rawExperienceIds)
      : getRawExperienceRecords({ vendor, deviceType, model, indicator, limit });

    records = records.slice(0, Math.max(1, Number(limit) || 10));
    if (records.length === 0) {
      return res.status(400).json({ success: false, error: '没有找到可拆解的原始经验记录' });
    }

    const generated = [];
    const failures = [];
    for (const record of records) {
      try {
        const prompt = buildKnowledgeCandidatePrompt(record);
        if (dryRun) {
          generated.push({ rawExperienceId: record.id, prompt });
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
            maxTokens: 1200,
            timeout: 60000,
            formatJson: false
          }
        );
        const parsed = extractJSON(aiResult.content);
        if (!parsed) {
          failures.push({ rawExperienceId: record.id, error: 'AI 未返回有效 JSON' });
          continue;
        }

        const candidate = normalizeGeneratedCandidate(record, parsed, aiResult);
        if (replaceExistingDraft) {
          clearKnowledgeCandidates({ rawExperienceId: record.id, status: 'draft' });
        }
        generated.push(saveKnowledgeCandidate(candidate));
      } catch (error) {
        failures.push({ rawExperienceId: record.id, error: error.message });
      }
    }

    res.json({
      success: true,
      generated,
      failures,
      count: generated.length,
      failCount: failures.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/v1/knowledge-candidates/list', (req, res) => {
  try {
    const records = getKnowledgeCandidates({
      vendor: req.query.vendor || '',
      deviceType: req.query.deviceType || '',
      model: req.query.model || '',
      indicator: req.query.indicator || '',
      status: req.query.status || '',
      validationStatus: req.query.validationStatus || '',
      rawExperienceId: req.query.rawExperienceId || '',
      limit: req.query.limit || 200
    });
    res.json({ success: true, records, count: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/knowledge-candidates/validate', async (req, res) => {
  try {
    const {
      candidateIds = [],
      candidates = [],
      roots = [],
      root = '',
      maxFiles = 5000,
      maxResults = 40,
      topFiles = 10,
      maxEvidence = 20,
      writeBack = false
    } = req.body || {};

    let records = Array.isArray(candidates) && candidates.length ? candidates : [];
    if (Array.isArray(candidateIds) && candidateIds.length) {
      records = getKnowledgeCandidatesByIds(candidateIds);
    }

    if (records.length === 0) {
      return res.status(400).json({ success: false, error: '没有可验证的候选知识规则' });
    }

    const rootList = Array.isArray(roots) && roots.length ? roots : (root ? [root] : []);
    const results = await validateKnowledgeCandidates(records, {
      roots: rootList,
      maxFiles,
      maxResults,
      topFiles,
      maxEvidence
    });

    const updated = [];
    if (writeBack) {
      for (const result of results) {
        if (!result.candidateId) continue;
        updated.push(updateKnowledgeCandidateValidation(result.candidateId, result));
      }
    }

    res.json({
      success: true,
      count: results.length,
      verifiedCount: results.filter(item => item.status === 'verified').length,
      updatedCount: updated.length,
      updated,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/knowledge-candidates/:id', (req, res) => {
  try {
    deleteKnowledgeCandidate(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/knowledge-candidates', (req, res) => {
  try {
    clearKnowledgeCandidates(req.body || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/agent/collect', async (req, res) => {
  const requestController = new AbortController();
  req.on('aborted', () => requestController.abort());
  res.on('close', () => {
    if (!res.writableEnded) requestController.abort();
  });

  try {
    const body = req.body || {};
    const roots = body.roots || body.diskRoots || (body.diskRoot ? [body.diskRoot] : []);
    const indicators = body.indicators || body.rules || [];

    if (!Array.isArray(roots) || roots.length === 0) {
      return res.status(400).json({ success: false, error: '缺少 roots/diskRoots' });
    }
    if (!Array.isArray(indicators) || indicators.length === 0) {
      return res.status(400).json({ success: false, error: '缺少 indicators/rules' });
    }

    const aiOptions = mergeAgentAIOptions({
      provider: body.provider,
      backend: body.backend,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      model: body.modelName || body.aiModel,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
      timeout: body.timeout
    });
    aiOptions.signal = requestController.signal;

    await pushAgentEventNow({
      type: 'request',
      message: '收到 Agent 采集请求',
      roots,
      indicatorCount: indicators.length,
      ai: normalizeAIOptions(aiOptions)
    });

    const result = await runAgentCollection({
      vendor: body.vendor || '',
      deviceType: body.deviceType || '',
      model: body.deviceModel || body.machineModel || body.model || '',
      roots,
      indicators,
      aiOptions,
      maxSteps: body.maxSteps,
      maxCandidates: body.maxCandidates,
      maxResultChars: body.maxResultChars,
      dryRun: body.dryRun
    }, {
      onEvent: event => {
        if (requestController.signal.aborted) return;
        pushAgentEvent(event);
      }
    });

    const excelResults = normalizeAgentResultsForExcel(result.results);
    const successCount = excelResults.filter(item => item.success).length;
    const scanLog = {
      scan_time: new Date().toLocaleString('zh-CN'),
      disk: roots.join(', '),
      total_files: result.toolCalls
        .filter(call => call.tool === 'search_files')
        .reduce((sum, call) => sum + (call.result?.checked?.files || 0), 0),
      success_count: successCount,
      fail_count: excelResults.length - successCount,
      total_indicators: excelResults.length,
      duration: (result.durationMs / 1000).toFixed(2),
      template_rules: indicators.length,
      used_index: false,
      collector: 'agent'
    };

    if (!body.dryRun) {
      const outputPath = path.join(TEMP_DIR, 'MRI_Result.xlsx');
      generateResultExcel(excelResults, scanLog, outputPath);
    }

    res.json({
      ...result,
      scanLog,
      exportReady: !body.dryRun
    });
  } catch (err) {
    await pushAgentEventNow({
      type: 'error',
      message: err.message
    });
    res.status(500).json({ success: false, error: err.message });
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
      format: rules[0].synonyms !== undefined ? 'new' : 'old'
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 下载模板示例（新格式）
app.get('/api/v1/template/example', (req, res) => {
  try {
    const outputPath = path.join(TEMP_DIR, 'MRI_Template_Example.xlsx');
    generateTemplateExample(outputPath);
    res.download(outputPath, 'MRI采集模板示例_v2.xlsx', (err) => {
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
app.get('/api/v1/devices', (req, res) => {
  try {
    const indexPath = path.join(TEMPLATES_DIR, 'template_index.json');
    if (!fs.existsSync(indexPath)) {
      return res.json({ success: true, devices: [] });
    }
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    res.json({ success: true, devices: data.devices || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 加载设备模板
app.get('/api/v1/devices/:deviceId/template', (req, res) => {
  try {
    const { deviceId } = req.params;
    const indexPath = path.join(TEMPLATES_DIR, 'template_index.json');

    if (!fs.existsSync(indexPath)) {
      return res.status(404).json({ success: false, error: '设备模板索引不存在' });
    }

    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const device = (data.devices || []).find(d => d.id === deviceId);

    if (!device) {
      return res.status(404).json({ success: false, error: `设备 ${deviceId} 不存在` });
    }

    const templatePath = path.join(TEMPLATES_DIR, device.template);
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ success: false, error: `模板文件 ${device.template} 不存在` });
    }

    // 解析模板并返回规则
    const buffer = fs.readFileSync(templatePath);
    const rules = parseTemplate(buffer);

    res.json({
      success: true,
      device,
      rules,
      count: rules.length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 上传设备模板
app.post('/api/v1/devices/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: '未上传文件' });
    }

    const { deviceId, brand, model, description } = req.body;
    const filename = req.file.originalname;

    // 保存模板文件
    const templatePath = path.join(TEMPLATES_DIR, filename);
    fs.writeFileSync(templatePath, req.file.buffer);

    // 更新索引
    const indexPath = path.join(TEMPLATES_DIR, 'template_index.json');
    let indexData = { devices: [] };
    if (fs.existsSync(indexPath)) {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }

    const existingIndex = indexData.devices.findIndex(d => d.id === deviceId);
    const deviceInfo = {
      id: deviceId || filename.replace(/\.xlsx?$/i, ''),
      brand: brand || 'Unknown',
      model: model || filename.replace(/\.xlsx?$/i, ''),
      template: filename,
      description: description || `${brand} ${model}`
    };

    if (existingIndex >= 0) {
      indexData.devices[existingIndex] = deviceInfo;
    } else {
      indexData.devices.push(deviceInfo);
    }

    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));

    res.json({ success: true, device: deviceInfo });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ 文件索引管理 ============

// 构建/更新文件索引
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

// SSE 实时扫描进度推送
let scanStreamClients = [];

const waitForFlush = () => new Promise(resolve => setImmediate(resolve));
const AI_AUTOFILL_ITEM_TIMEOUT = Number(process.env.AI_AUTOFILL_ITEM_TIMEOUT || 60000);
const AI_AUTOFILL_MAX_TOKENS = Number(process.env.AI_AUTOFILL_MAX_TOKENS || 1600);
const COLLECTION_L2_MAX_FILES = Number(process.env.COLLECTION_L2_MAX_FILES || 15000);
const COLLECTION_L3_MAX_FILES = Number(process.env.COLLECTION_L3_MAX_FILES || 5000);
const COLLECTION_PROGRESS_EVERY = Number(process.env.COLLECTION_PROGRESS_EVERY || 200);

function normalizeDiskRoot(diskRoot) {
  const value = String(diskRoot || '').trim();
  if (/^[a-z]:$/i.test(value)) return value + '\\';
  return value;
}

app.get('/api/v1/scan-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲

  // 禁用响应缓冲
  res.socket.setNoDelay(true);

  // 添加到客户端列表
  scanStreamClients.push(res);

  // 发送初始消息
  const initMsg = 'data: {"type":"init","message":"扫描服务已连接"}\n\n';
  res.write(initMsg);
  if (res.flush) res.flush();

  // 客户端断开时移除
  req.on('close', () => {
    scanStreamClients = scanStreamClients.filter(client => client !== res);
    console.log('[SSE] 客户端断开连接');
  });
});

// 推送扫描进度到所有客户端
function pushScanProgress(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  scanStreamClients.forEach(client => {
    try {
      client.write(message);
      if (client.flush) client.flush();
    } catch (err) {
      console.error('[SSE] 推送失败:', err.message);
    }
  });
}

async function pushScanProgressNow(data) {
  pushScanProgress(data);
  await waitForFlush();
}

// ============ AI 思考过程 SSE ============

let aiThinkingClients = [];

app.get('/api/v1/ai-thinking-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  res.socket.setNoDelay(true);

  aiThinkingClients.push(res);

  const initMsg = 'data: {"type":"init","message":"AI 思考服务已连接"}\n\n';
  res.write(initMsg);
  if (res.flush) res.flush();

  req.on('close', () => {
    aiThinkingClients = aiThinkingClients.filter(client => client !== res);
    console.log('[AI SSE] 客户端断开连接');
  });
});

function pushAiThinking(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  aiThinkingClients.forEach(client => {
    try {
      client.write(message);
      if (client.flush) client.flush();
    } catch (err) {
      console.error('[AI SSE] 推送失败:', err.message);
    }
  });
}

async function pushAiThinkingNow(data) {
  pushAiThinking(data);
  await waitForFlush();
}

// ============ Agent 运行过程 SSE ============

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

// 执行完整的采集任务（v2: 三级匹配 + 可信度）
app.post('/api/v1/collect', async (req, res) => {
  const requestController = new AbortController();
  req.on('aborted', () => requestController.abort());
  res.on('close', () => {
    if (!res.writableEnded) requestController.abort();
  });

  try {
    const { diskRoot, diskRoots, rules, useIndex = true } = req.body;
    const targetDisks = (Array.isArray(diskRoots) && diskRoots.length > 0 ? diskRoots : [diskRoot])
      .map(disk => normalizeDiskRoot(disk))
      .filter(Boolean);

    if (targetDisks.length === 0 || !rules || !Array.isArray(rules)) {
      return res.status(400).json({ success: false, error: '缺少必要参数: diskRoot/diskRoots, rules' });
    }

    const startTime = Date.now();
    const allMatchedFiles = new Set();
    const results = [];
    const usedIndex = false;
    let fallbackUsed = false;
    let stopped = false;

    // 推送开始消息
    await pushScanProgressNow({ type: 'start', totalRules: rules.length, totalDisks: targetDisks.length });

    for (const currentDisk of targetDisks) {
      if (requestController.signal.aborted) {
        stopped = true;
        break;
      }

      await pushScanProgressNow({ type: 'disk_start', diskRoot: currentDisk });

      for (const rule of rules) {
        if (requestController.signal.aborted) {
          stopped = true;
          break;
        }

        const filePattern = rule.filePattern || rule.file_pattern || '';

        await pushScanProgressNow({
          type: 'rule_start',
          diskRoot: currentDisk,
          indicator: rule.indicator,
          filePattern
        });

        const levelResults = await collectRuleByLevels(currentDisk, rule, requestController.signal, allMatchedFiles);
        if (levelResults.stopped) {
          stopped = true;
          break;
        }
        if (levelResults.fallbackUsed) fallbackUsed = true;
        results.push(...levelResults.results);
      }
    }

    // 推送扫描完成
    await pushScanProgressNow({
      type: stopped ? 'scan_stopped' : 'scan_complete',
      totalFiles: allMatchedFiles.size
    });

    // 第二步：三级匹配提取参数
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    const scanLog = {
      scan_time: new Date().toISOString(),
      disk: targetDisks.join(', '),
      disks: targetDisks,
      total_files: allMatchedFiles.size,
      success_count: successCount,
      fail_count: failCount,
      total_indicators: rules.length * targetDisks.length,
      duration: ((Date.now() - startTime) / 1000).toFixed(2),
      template_rules: rules.length,
      used_index: usedIndex,
      fallback_scan: fallbackUsed,
      stopped
    };

    // 第三步：生成结果 Excel
    const outputPath = path.join(TEMP_DIR, 'MRI_Result.xlsx');
    generateResultExcel(results, scanLog, outputPath);

    res.json({
      success: true,
      results,
      scanLog,
      outputFile: outputPath
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function collectRuleByLevels(diskRoot, rule, signal, allMatchedFiles) {
  const levels = [
    {
      level: 'L1',
      name: 'L1 参考路径',
      fallbackUsed: false,
      scan: async onProgress => {
        const filePattern = rule.filePattern || rule.file_pattern || '';
        if (!filePattern || !filePattern.trim()) return [];
        return scanReferenceFilesWithProgress(diskRoot, filePattern, onProgress, {
          signal,
          progressEvery: COLLECTION_PROGRESS_EVERY
        });
      }
    },
    {
      level: 'L2',
      name: 'L2 文件扩展',
      fallbackUsed: false,
      scan: async onProgress => scanFileGlobsWithProgress(diskRoot, buildFileGlobCandidates(rule), onProgress, {
        signal,
        maxFiles: COLLECTION_L2_MAX_FILES,
        progressEvery: COLLECTION_PROGRESS_EVERY
      })
    },
    {
      level: 'L3',
      name: 'L3 全盘兜底',
      fallbackUsed: true,
      scan: async onProgress => scanAllLogFilesWithProgressOptions(diskRoot, onProgress, {
        signal,
        maxFiles: COLLECTION_L3_MAX_FILES,
        progressEvery: COLLECTION_PROGRESS_EVERY
      })
    }
  ];

  let finalResults = [];
  let usedFallback = false;

  for (const levelInfo of levels) {
    if (signal.aborted) return { results: finalResults, fallbackUsed: usedFallback, stopped: true };

    await pushScanProgressNow({
      type: 'scan_level_start',
      diskRoot,
      indicator: rule.indicator,
      level: levelInfo.level,
      levelName: levelInfo.name
    });

    const files = await levelInfo.scan(async progress => {
      await pushScanProgressNow({
        type: progress.type,
        diskRoot,
        indicator: rule.indicator,
        level: levelInfo.level,
        levelName: levelInfo.name,
        dir: progress.dir,
        file: progress.file,
        checkedFiles: progress.checkedFiles,
        matchedFiles: progress.matchedFiles,
        target: progress.target
      });
    });

    const uniqueFiles = [...new Set(files)];
    uniqueFiles.forEach(file => allMatchedFiles.add(file));

    await pushScanProgressNow({
      type: 'rule_candidates',
      diskRoot,
      indicator: rule.indicator,
      level: levelInfo.level,
      levelName: levelInfo.name,
      filesFound: uniqueFiles.length
    });

    const levelResults = await extractRuleFromFiles(diskRoot, rule, uniqueFiles, levelInfo, signal);
    finalResults = levelResults;
    if (levelInfo.fallbackUsed) usedFallback = true;

    const hit = levelResults.some(result => result.success);
    await pushScanProgressNow({
      type: 'scan_level_complete',
      diskRoot,
      indicator: rule.indicator,
      level: levelInfo.level,
      levelName: levelInfo.name,
      filesFound: uniqueFiles.length,
      hit
    });

    if (signal.aborted) return { results: finalResults, fallbackUsed: usedFallback, stopped: true };
    if (hit) return { results: finalResults, fallbackUsed: usedFallback, stopped: false };
  }

  return { results: finalResults, fallbackUsed: usedFallback, stopped: false };
}

async function extractRuleFromFiles(diskRoot, rule, files, levelInfo, signal) {
  const keyword = rule.keyword || rule.indicator || '';
  const synonyms = Array.isArray(rule.synonyms) ? [...rule.synonyms] : [];

  if (!keyword && rule.indicator) {
    synonyms.push(rule.indicator);
  }

  await pushScanProgressNow({
    type: 'extract_start',
    diskRoot,
    indicator: rule.indicator,
    level: levelInfo.level,
    levelName: levelInfo.name,
    filesFound: files.length
  });

  const task = {
    indicator: rule.indicator,
    keyword,
    synonyms,
    dataType: rule.dataType || '',
    unit: rule.unit || '',
    files,
    file_pattern: rule.filePattern || rule.file_pattern || '',
    keywordMeaning: rule.keywordMeaning || rule.keyword_meaning || ''
  };

  return (await batchExtractWithProgress([task], async progress => {
    await pushScanProgressNow({
      type: progress.type,
      diskRoot,
      indicator: progress.indicator,
      keyword: progress.keyword,
      file: progress.file,
      lineNumber: progress.lineNumber,
      line: progress.line,
      matchedWord: progress.matchedWord,
      checkedFiles: progress.checkedFiles,
      matchedFiles: progress.matchedFiles,
      level: levelInfo.level,
      levelName: levelInfo.name
    });
  }, { signal })).map(result => ({
    ...result,
    disk_root: diskRoot,
    scan_level: levelInfo.level,
    scan_strategy: levelInfo.name
  }));
}

// 从单个文件中提取参数（三级匹配）
app.post('/api/v1/extract', (req, res) => {
  try {
    const { filePath, keyword, synonyms } = req.body;
    if (!filePath || !keyword) {
      return res.status(400).json({ success: false, error: '缺少必要参数: filePath, keyword' });
    }

    const result = extractParameter(filePath, keyword, synonyms || []);
    res.json({ success: result.success, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 下载结果文件
app.get('/api/v1/result/download', (req, res) => {
  const filePath = path.join(TEMP_DIR, 'MRI_Result.xlsx');
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: '结果文件不存在，请先执行采集' });
  }
  res.download(filePath, 'MRI采集结果_v2.xlsx');
});

// ==================== AI 功能 API ====================

// 获取 AI 服务状态
app.get('/api/v1/ai/status', async (req, res) => {
  try {
    const backends = getAvailableBackends();
    const status = await checkAIService('ollama');

    res.json({
      success: true,
      backends,
      agentConfig: publicAgentConfig(agentRuntimeConfig),
      ollama: status,
      deepseek: {
        available: !!(process.env.DEEPSEEK_API_KEY || (agentRuntimeConfig.provider === 'deepseek' && agentRuntimeConfig.apiKey)),
        local: false
      }
    });
  } catch (err) {
    res.json({
      success: true,
      backends: getAvailableBackends(),
      agentConfig: publicAgentConfig(agentRuntimeConfig),
      ollama: { available: false, error: err.message },
      deepseek: {
        available: !!(process.env.DEEPSEEK_API_KEY || (agentRuntimeConfig.provider === 'deepseek' && agentRuntimeConfig.apiKey)),
        local: false
      }
    });
  }
});

// 获取 Ollama 本地已安装的模型列表
app.get('/api/v1/ai/models', async (req, res) => {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();
    const models = (data.models || []).map(m => ({
      name: m.name,
      size: (m.size / 1024 / 1024 / 1024).toFixed(1) + ' GB',
      modified: m.modified_at ? new Date(m.modified_at).toLocaleDateString('zh-CN') : ''
    }));
    res.json({ success: true, models, count: models.length });
  } catch (error) {
    res.json({ success: false, error: '无法连接 Ollama，请确认已安装并运行', models: [] });
  }
});

// AI 参数匹配
app.post('/api/v1/ai/match', async (req, res) => {
  try {
    const { indicator, keyword, synonyms, filePath, fileContent, dataType, unit } = req.body;

    if (!indicator || !keyword) {
      return res.status(400).json({ success: false, error: '缺少必要参数: indicator, keyword' });
    }

    // 如果没有提供文件内容，尝试读取文件
    let content = fileContent;
    if (!content && filePath) {
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        return res.status(400).json({ success: false, error: '无法读取文件内容' });
      }
    }

    if (!content) {
      return res.status(400).json({ success: false, error: '需要提供 fileContent 或有效的 filePath' });
    }

    const rule = { indicator, keyword, synonyms: synonyms || [], dataType, unit };
    const result = await aiMatchParameter(rule, filePath || 'unknown', content);

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI 智能补全（根据指标名称生成关键词和文件路径）
app.post('/api/v1/ai/autofill', async (req, res) => {
  const requestController = new AbortController();
  req.on('aborted', () => requestController.abort());
  res.on('close', () => {
    if (!res.writableEnded) requestController.abort();
  });

  try {
    const { indicators, vendor, deviceType, model, backend, provider, baseUrl, apiKey } = req.body;

    if (!indicators || !Array.isArray(indicators) || indicators.length === 0) {
      return res.status(400).json({ success: false, error: '缺少必要参数: indicators' });
    }

    // 推送开始思考
    await pushAiThinkingNow({
      type: 'start',
      message: `开始分析 ${indicators.length} 个指标`,
      vendor: vendor || '医疗',
      deviceType: deviceType || '设备'
    });

    const rules = [];
    const failures = [];
    for (let i = 0; i < indicators.length; i++) {
      if (requestController.signal.aborted) break;
      const indicator = indicators[i];

      // 推送正在分析指标
      await pushAiThinkingNow({
        type: 'analyzing',
        indicator: indicator,
        index: i + 1,
        total: indicators.length,
        progress: `${i + 1}/${indicators.length}`
      });

      const prompt = `你是${vendor || '医疗'}${deviceType || '设备'}日志分析专家。
请为以下指标生成采集关键词。

指标名称：${indicator}

重要限制：
- 日志中不会出现中文，keyword 和 synonyms 必须全部使用英文或 ASCII 字段名。
- 不要把中文解释、中文翻译、中文词语放进 keyword 或 synonyms。
- filePattern 只能使用英文目录名、英文文件名或常见路径片段。

请先输出可展示分析过程，最多 3 行，每行以“分析：”开头，说明你如何判断英文参考日志路径、英文主关键词和英文备用关键词。
最后单独输出一段 JSON，格式如下：
{
  "filePattern": "English path fragment, e.g. MedCom/log, MriSiteData, SysUtil",
  "keyword": "EnglishFieldName",
  "synonyms": ["EnglishAlias1", "english_alias_2", "EnglishAlias3"],
  "keywordMeaning": "中文说明：该关键字在日志中通常表示什么，必要时写出关键字段与含义"
}

如果不确定，filePattern填""，keyword填""，synonyms填[]。`;

      await pushAiThinkingNow({
        type: 'thinking',
        indicator,
        message: `正在接收 AI 输出...`
      });

      let parsed = null;
      let rawContent = '';
      try {
        const aiResult = await callAIStream(
          prompt,
          {
            ...mergeAgentAIOptions({
              backend,
              provider,
              baseUrl,
              apiKey,
              model: model || undefined
            }),
            timeout: AI_AUTOFILL_ITEM_TIMEOUT,
            maxTokens: AI_AUTOFILL_MAX_TOKENS,
            formatJson: false,
            signal: requestController.signal
          },
          token => {
            rawContent += token;
            pushAiThinking({
              type: 'delta',
              indicator,
              content: token
            });
          }
        );

        rawContent = aiResult.content || rawContent;
        const jsonMatch = aiResult.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
          parsed = sanitizeAiAutofillRule(parsed);
          // 推送解析成功
          await pushAiThinkingNow({
            type: 'success',
            indicator: indicator,
            keyword: parsed?.keyword || '',
            synonyms: parsed?.synonyms || [],
            filePattern: parsed?.filePattern || '',
            keywordMeaning: parsed?.keywordMeaning || '',
            summary: summarizeAiOutput(rawContent)
          });
        } else {
          console.log('AI 返回内容:', aiResult.content);
          failures.push({ indicator, error: 'AI 返回格式异常' });
          await pushAiThinkingNow({
            type: 'warning',
            indicator: indicator,
            message: 'AI 返回格式异常，已跳过该指标',
            summary: summarizeAiOutput(rawContent)
          });
        }
      } catch (e) {
        // AI 返回解析失败，记录日志
        console.error('AI 返回解析失败:', e.message);
        console.error('AI 原始响应:', rawContent?.substring(0, 500));
        failures.push({ indicator, error: e.message });
        await pushAiThinkingNow({
          type: 'error',
          indicator: indicator,
          message: `该指标失败，已继续下一项：${e.message}`,
          summary: summarizeAiOutput(rawContent)
        });
      }

      rules.push({
        indicator,
        filePattern: parsed?.filePattern || '',
        keyword: parsed?.keyword || '',
        synonyms: parsed?.synonyms || [],
        keywordMeaning: parsed?.keywordMeaning || ''
      });
    }

    // 推送完成
    await pushAiThinkingNow({
      type: 'complete',
      message: `补全完成：成功 ${rules.length - failures.length}，失败 ${failures.length}`,
      successCount: rules.length - failures.length,
      failCount: failures.length,
      total: rules.length
    });

    res.json({ success: true, rules, failures });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function summarizeAiOutput(content = '') {
  const lines = String(content)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('{') && !line.startsWith('"') && !line.startsWith('}'))
    .map(line => line.replace(/^分析[:：]\s*/, ''))
    .slice(0, 3);
  return lines.join('\n');
}

function sanitizeAiAutofillRule(rule = {}) {
  return {
    filePattern: sanitizeFilePattern(rule.filePattern || rule.file_pattern || ''),
    keyword: sanitizeKeyword(rule.keyword || ''),
    synonyms: sanitizeSynonyms(rule.synonyms || []),
    keywordMeaning: String(rule.keywordMeaning || rule.keyword_meaning || '').trim()
  };
}

function sanitizeFilePattern(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part && /^[A-Za-z0-9_./\\*?\-\s]+$/.test(part))
    .join(', ');
}

function sanitizeKeyword(value) {
  const text = String(value || '').trim();
  if (!text || /[^\x00-\x7F]/.test(text)) return '';
  return text.replace(/[^A-Za-z0-9_.:\-\s]/g, '').trim();
}

function sanitizeSynonyms(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,；，]/);
  return [...new Set(list.map(sanitizeKeyword).filter(Boolean))].slice(0, 8);
}

// AI 未知参数发现
app.post('/api/v1/ai/discover', async (req, res) => {
  try {
    const { diskRoot, existingIndicators } = req.body;

    if (!diskRoot) {
      return res.status(400).json({ success: false, error: '缺少必要参数: diskRoot' });
    }

    // 扫描日志文件
    const files = scanLogFiles(diskRoot);

    if (files.length === 0) {
      return res.json({
        success: true,
        suggestions: [],
        message: '未找到日志文件'
      });
    }

    // 限制文件数量和大小
    const limitedFiles = files
      .slice(0, 30)
      .map(f => ({
        path: f.path,
        content: f.content.length > 10000 ? f.content.substring(0, 10000) : f.content
      }));

    const result = await discoverUnknownParameters(limitedFiles, existingIndicators || []);

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI 生成模板
app.post('/api/v1/ai/generate-template', async (req, res) => {
  try {
    const { userRequest, diskRoot } = req.body;

    if (!userRequest) {
      return res.status(400).json({ success: false, error: '缺少必要参数: userRequest' });
    }

    // 提取可用字段
    let availableFields = [];
    if (diskRoot) {
      try {
        availableFields = await extractAvailableFields(diskRoot);
      } catch {
        // 字段提取失败，继续生成
      }
    }

    const result = await generateTemplate(userRequest, availableFields);

    if (result.success) {
      // 保存模板到文件
      const templatePath = path.join(TEMPLATES_DIR, `ai_${Date.now()}.xlsx`);
      await saveTemplateToExcel(result.template, templatePath);
      result.templatePath = templatePath;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== AI 智能补全 ====================
app.post('/api/v1/ai/smart-fill', async (req, res) => {
  try {
    const { indicators, vendor, deviceType, model } = req.body;
    if (!indicators || !Array.isArray(indicators) || indicators.length === 0) {
      return res.json({ success: false, error: '请提供指标名称列表' });
    }

    // 1. 先尝试从经验库匹配
    const matchResult = findMatchingRecords(vendor, deviceType);
    const matchedRecords = matchResult.exact.length > 0 ? matchResult.exact : matchResult.vendor;
    const filledRules = [];

    for (const indicator of indicators) {
      let rule = { indicator, filePattern: '', keyword: '', synonyms: '' };

      // 尝试从经验库匹配
      if (matchedRecords.length > 0) {
        for (const record of matchedRecords) {
          const matchedRule = record.rules.find(r =>
            r.indicator && r.indicator.toLowerCase().includes(indicator.toLowerCase()) ||
            indicator.toLowerCase().includes(r.indicator.toLowerCase())
          );
          if (matchedRule) {
            rule = {
              indicator,
              filePattern: matchedRule.filePattern || '',
              keyword: matchedRule.keyword || '',
              synonyms: matchedRule.synonyms || '',
              keywordMeaning: matchedRule.keywordMeaning || matchedRule.keyword_meaning || ''
            };
            rule._fromExperience = true;
            break;
          }
        }
      }

      // 如果经验库没有匹配，使用 AI 生成
      if (!rule._fromExperience) {
        const aiResult = await aiSmartFill(indicator, vendor, deviceType);
        if (aiResult && aiResult.success) {
          rule = {
              indicator,
              filePattern: aiResult.filePattern || '',
              keyword: aiResult.keyword || '',
              synonyms: aiResult.synonyms || '',
              keywordMeaning: aiResult.keywordMeaning || aiResult.keyword_meaning || ''
            };
        }
      }

      filledRules.push(rule);
    }

    res.json({ success: true, rules: filledRules, experienceCount: matchedRecords.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 采集经验库 API ====================

// 获取经验库列表
app.get('/api/v1/experience', (req, res) => {
  try {
    const { vendor, deviceType } = req.query;
    const records = getAllRecords(vendor, deviceType);
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取经验库列表（别名）
app.get('/api/v1/experience/list', (req, res) => {
  try {
    const records = getAllRecords();
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按厂商和设备类型匹配经验（静态路由，必须在 :id 之前）
app.get('/api/v1/experience/match', (req, res) => {
  try {
    const { vendor, deviceType } = req.query;
    if (!vendor || !deviceType) {
      return res.json({ success: false, error: '缺少 vendor 或 deviceType 参数' });
    }
    const records = findMatchingRecords(vendor, deviceType);
    res.json({ success: true, records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取单条经验详情
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
app.post('/api/v1/experience', (req, res) => {
  try {
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

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 保存采集经验（别名）
app.post('/api/v1/experience/save', (req, res) => {
  try {
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

    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 按厂商和设备类型匹配经验（POST方式，支持指标匹配）
app.post('/api/v1/experience/match', (req, res) => {
  try {
    const { vendor, deviceType, indicators } = req.body;
    if (!vendor || !deviceType) {
      return res.json({ success: false, error: '缺少 vendor 或 deviceType 参数' });
    }
    const matchResult = findMatchingRecords(vendor, deviceType);
    const matchedRecords = matchResult.exact.length > 0 ? matchResult.exact : matchResult.vendor;

    // 如果提供了指标列表，返回匹配的规则
    if (indicators && Array.isArray(indicators) && indicators.length > 0) {
      const matches = [];
      for (const indicator of indicators) {
        for (const record of matchedRecords) {
          if (!record.rules) continue;
          const matchedRule = record.rules.find(r =>
            (r.indicator && r.indicator.toLowerCase().includes(indicator.toLowerCase())) ||
            (indicator.toLowerCase().includes((r.indicator || '').toLowerCase()))
          );
          if (matchedRule) {
            matches.push({
              indicator: indicator,
              filePattern: matchedRule.filePattern || '',
              keyword: matchedRule.keyword || '',
              synonyms: matchedRule.synonyms || '',
              keywordMeaning: matchedRule.keywordMeaning || matchedRule.keyword_meaning || ''
            });
            break;
          }
        }
      }
      return res.json({ success: true, matches, experienceCount: matchedRecords.length });
    }

    res.json({ success: true, records: matchResult });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新采集经验
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
app.listen(PORT, () => {
  console.log(`大放设备参数采集程序 v3.0 已启动: http://localhost:${PORT}`);
  console.log(`平台: ${process.platform}`);
});
