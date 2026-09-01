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
import { scanDiskForFiles, scanAllLogFiles, initIndex, buildFileIndex, checkIndexStatus } from './core/matcher.js';
import { extractParameter, batchExtract } from './core/extractor.js';
import { parseTemplate, generateResultExcel, generateTemplateExample } from './core/excel-handler.js';
import { callAI, checkAIService, getAvailableBackends, extractJSON } from './core/ai-service.js';
import { aiMatchParameter, aiBatchMatch } from './core/ai-matcher.js';
import { discoverUnknownParameters, scanLogFiles, extractFieldsFromFile } from './core/ai-discoverer.js';
import { generateTemplate, saveTemplateToExcel, extractAvailableFields } from './core/ai-template-gen.js';
import { initExperienceDB, getVendorDevices, saveCollectionRecord, getAllRecords, getRecordDetail, findMatchingRecords, updateRecord, deleteRecord, deleteRecords } from './core/experience-library.js';

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
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 目录初始化
const TEMP_DIR = path.join(__dirname, 'temp');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const EXPERIENCE_DIR = path.join(__dirname, 'experiences');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
if (!fs.existsSync(EXPERIENCE_DIR)) fs.mkdirSync(EXPERIENCE_DIR, { recursive: true });

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
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    platform: process.platform,
    indexReady
  });
});

// 获取可用磁盘列表
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

// 执行完整的采集任务（v2: 三级匹配 + 可信度）
app.post('/api/v1/collect', (req, res) => {
  try {
    const { diskRoot, rules, useIndex = true } = req.body;
    if (!diskRoot || !rules || !Array.isArray(rules)) {
      return res.status(400).json({ success: false, error: '缺少必要参数: diskRoot, rules' });
    }

    const startTime = Date.now();
    const allMatchedFiles = new Set();
    const tasks = [];
    const usedIndex = useIndex && indexReady;

    // 第一步：为每条规则扫描匹配文件
    // 策略：优先在参考文件中查找，找不到则全盘扫描
    let allFilesCache = null; // 缓存全盘扫描结果，避免重复扫描
    let fallbackUsed = false;
    let totalFilesScanned = 0;

    // 推送开始消息
    pushScanProgress({ type: 'start', totalRules: rules.length });

    for (const rule of rules) {
      const filePattern = rule.filePattern || rule.file_pattern || '';
      let files = [];

      // 推送当前规则
      pushScanProgress({
        type: 'rule_start',
        indicator: rule.indicator,
        filePattern: filePattern
      });

      // 1. 优先在参考文件中查找（支持逗号分隔的多个路径）
      if (filePattern && filePattern.trim() !== '') {
        // 拆分逗号分隔的多个路径
        const patterns = filePattern.split(',').map(p => p.trim()).filter(p => p);
        for (const pattern of patterns) {
          const matched = scanDiskForFiles(diskRoot, pattern, usedIndex);
          files.push(...matched);
          // 推送每个文件
          matched.forEach(f => {
            pushScanProgress({
              type: 'file_scanned',
              file: f,
              indicator: rule.indicator,
              status: 'matched'
            });
          });
        }
        // 去重
        files = [...new Set(files)];
        console.log(`[采集] 规则 "${rule.indicator}" 参考文件 "${filePattern}" 找到 ${files.length} 个文件`);
      }

      // 2. 如果参考文件没找到，全盘扫描所有日志文件
      if (files.length === 0) {
        if (!allFilesCache) {
          allFilesCache = scanAllLogFiles(diskRoot, usedIndex);
          console.log(`[采集] 全盘扫描找到 ${allFilesCache.length} 个日志文件`);
          pushScanProgress({
            type: 'full_scan',
            totalFiles: allFilesCache.length
          });
        }
        files = allFilesCache;
        fallbackUsed = true;
      }

      files.forEach(f => {
        allMatchedFiles.add(f);
        totalFilesScanned++;
      });

      // 推送规则完成
      pushScanProgress({
        type: 'rule_complete',
        indicator: rule.indicator,
        filesFound: files.length
      });

      // 关键字：优先使用模板中的关键字，否则使用指标名称
      const keyword = rule.keyword || rule.indicator || '';
      const synonyms = rule.synonyms || [];

      // 如果关键字为空，使用指标名称作为关键字
      if (!keyword && rule.indicator) {
        synonyms.push(rule.indicator);
      }

      tasks.push({
        indicator: rule.indicator,
        keyword: keyword,
        synonyms: synonyms,
        dataType: rule.dataType || '',
        unit: rule.unit || '',
        files,
        file_pattern: filePattern
      });
    }

    // 推送扫描完成
    pushScanProgress({
      type: 'scan_complete',
      totalFiles: allMatchedFiles.size
    });

    // 第二步：三级匹配提取参数
    const results = batchExtract(tasks);

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    const scanLog = {
      scan_time: new Date().toISOString(),
      disk: diskRoot,
      total_files: allMatchedFiles.size,
      success_count: successCount,
      fail_count: failCount,
      total_indicators: rules.length,
      duration: ((Date.now() - startTime) / 1000).toFixed(2),
      template_rules: rules.length,
      used_index: usedIndex,
      fallback_scan: fallbackUsed
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
      ollama: status,
      deepseek: {
        available: !!process.env.DEEPSEEK_API_KEY,
        local: false
      }
    });
  } catch (err) {
    res.json({
      success: true,
      backends: getAvailableBackends(),
      ollama: { available: false, error: err.message },
      deepseek: { available: !!process.env.DEEPSEEK_API_KEY, local: false }
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
  try {
    const { indicators, vendor, deviceType, model, backend } = req.body;

    if (!indicators || !Array.isArray(indicators) || indicators.length === 0) {
      return res.status(400).json({ success: false, error: '缺少必要参数: indicators' });
    }

    // 推送开始思考
    pushAiThinking({
      type: 'start',
      message: `开始分析 ${indicators.length} 个指标`,
      vendor: vendor || '医疗',
      deviceType: deviceType || '设备'
    });

    const rules = [];
    for (let i = 0; i < indicators.length; i++) {
      const indicator = indicators[i];

      // 推送正在分析指标
      pushAiThinking({
        type: 'analyzing',
        indicator: indicator,
        progress: `${i + 1}/${indicators.length}`
      });

      // 推送搜索经验库
      pushAiThinking({
        type: 'thinking',
        message: '搜索经验库...'
      });

      const prompt = `你是${vendor || '医疗'}${deviceType || '设备'}日志分析专家。
请为以下指标生成采集关键词：

指标名称：${indicator}

请按以下JSON格式回答（只回答JSON，不要其他内容）：
{
  "filePattern": "最可能包含此参数的日志目录（如 MedCom/log, MriSiteData, SysUtil）",
  "keyword": "最可能的英文字段名",
  "synonyms": ["备用关键词1", "备用关键词2", "备用关键词3"]
}

如果不确定，filePattern填""，keyword填""，synonyms填[]。`;

      // 推送调用 AI
      pushAiThinking({
        type: 'thinking',
        message: `调用 AI 模型分析关键字...`
      });

      // 使用传入的模型和后端，如果没有则使用默认
      const aiResult = await callAI(prompt, { timeout: 30000, model: model || undefined, backend: backend || 'ollama' });

      let parsed = null;
      try {
        const jsonMatch = aiResult.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
          // 推送解析成功
          pushAiThinking({
            type: 'success',
            indicator: indicator,
            keyword: parsed?.keyword || '',
            synonyms: parsed?.synonyms || [],
            filePattern: parsed?.filePattern || ''
          });
        } else {
          console.log('AI 返回内容:', aiResult.content);
          pushAiThinking({
            type: 'warning',
            indicator: indicator,
            message: 'AI 返回格式异常'
          });
        }
      } catch (e) {
        // AI 返回解析失败，记录日志
        console.error('AI 返回解析失败:', e.message);
        console.error('AI 原始响应:', aiResult.content?.substring(0, 500));
        pushAiThinking({
          type: 'error',
          indicator: indicator,
          message: '解析失败：' + e.message
        });
      }

      rules.push({
        indicator,
        filePattern: parsed?.filePattern || '',
        keyword: parsed?.keyword || '',
        synonyms: parsed?.synonyms || []
      });
    }

    // 推送完成
    pushAiThinking({
      type: 'complete',
      message: `补全完成！共处理 ${rules.length} 个指标`
    });

    res.json({ success: true, rules });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
              synonyms: matchedRule.synonyms || ''
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
            synonyms: aiResult.synonyms || ''
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
              synonyms: matchedRule.synonyms || ''
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
