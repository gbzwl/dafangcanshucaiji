/**
 * AI 未知参数发现模块
 * 扫描日志文件，发现模板中未包含的有价值参数
 */

import { callAI, extractJSON } from './ai-service.js';
import fs from 'fs';
import path from 'path';

/**
 * 未知参数发现 Prompt 模板
 */
const DISCOVER_PROMPT_TEMPLATE = `你是MRI设备运维专家。以下是从设备日志中提取的字段列表：

{fieldList}

现有采集模板已包含以下指标：
{existingIndicators}

请分析：
1. 哪些字段可能是有价值但未采集的参数？
2. 建议的中文指标名称是什么？
3. 建议的关键词是什么？

按以下JSON格式回答（不要添加其他内容）：
{
  "suggestions": [
    {
      "indicator": "中文指标名",
      "keyword": "建议关键词",
      "file": "来源文件",
      "dataType": "数字或文本",
      "unit": "单位（如有）",
      "reason": "为什么这个参数重要"
    }
  ],
  "totalFieldsAnalyzed": 字段总数,
  "valuableFieldsFound": 有价值的字段数
}

只返回真正有价值的参数建议，不要重复已有的指标。`;

/**
 * 从日志文件中提取所有字段
 * @param {string} filePath - 文件路径
 * @param {string} content - 文件内容
 * @returns {Array} 字段列表
 */
export function extractFieldsFromFile(filePath, content) {
  const lines = content.split('\n');
  const fields = [];
  const fileName = path.basename(filePath);

  // 匹配常见的 key-value 模式
  const patterns = [
    /([A-Za-z][A-Za-z0-9_\s]*?)\s*[=:]\s*(.+?)(?:\s*$|\s*,|\s*;)/,  // key = value 或 key: value
    /<([A-Za-z][A-Za-z0-9_]+)>([^<]+)<\/\1>/,  // XML 标签
    /([A-Z][a-z]+(?:[A-Z][a-z]+)+)\s*[:=]?\s*([\d.]+\s*[a-zA-Z°%μ]*)/,  // CamelCase 字段
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const fieldName = match[1].trim();
        const value = match[2]?.trim() || '';

        // 过滤掉太短或太长的字段名
        if (fieldName.length >= 3 && fieldName.length <= 50) {
          fields.push({
            field: fieldName,
            value: value.substring(0, 100),
            file: fileName,
            line: trimmed.substring(0, 200)
          });
        }
      }
    }
  }

  return fields;
}

/**
 * AI 发现未知参数
 * @param {Array} files - 文件列表 [{path, content}]
 * @param {Array} existingIndicators - 已有指标列表
 * @param {object} options - 选项
 * @returns {Promise<object>} 发现结果
 */
export async function discoverUnknownParameters(files, existingIndicators = [], options = {}) {
  // 从所有文件中提取字段
  const allFields = [];
  for (const file of files) {
    const fields = extractFieldsFromFile(file.path, file.content);
    allFields.push(...fields);
  }

  // 去重
  const uniqueFields = Array.from(
    new Map(allFields.map(f => [f.field.toLowerCase(), f])).values()
  );

  if (uniqueFields.length === 0) {
    return {
      suggestions: [],
      totalFieldsAnalyzed: 0,
      valuableFieldsFound: 0,
      message: '未从日志中提取到任何字段'
    };
  }

  // 构建字段列表文本
  const fieldListText = uniqueFields
    .slice(0, 100) // 限制字段数量
    .map(f => `- ${f.field}: ${f.value} (来自 ${f.file})`)
    .join('\n');

  // 已有指标文本
  const existingText = existingIndicators.length > 0
    ? existingIndicators.map(ind => `- ${ind.indicator} (关键词: ${ind.keyword})`).join('\n')
    : '（无现有指标）';

  const prompt = DISCOVER_PROMPT_TEMPLATE
    .replace('{fieldList}', fieldListText)
    .replace('{existingIndicators}', existingText);

  try {
    const response = await callAI(prompt, {
      temperature: 0.4,
      maxTokens: 4096,
      ...options
    });

    const result = extractJSON(response.content);

    if (result && result.suggestions) {
      return {
        ...result,
        aiModel: response.model,
        totalUniqueFields: uniqueFields.length
      };
    }

    return {
      suggestions: [],
      totalFieldsAnalyzed: uniqueFields.length,
      valuableFieldsFound: 0,
      message: 'AI 未返回有效建议',
      rawResponse: response.content.substring(0, 500)
    };

  } catch (error) {
    return {
      suggestions: [],
      totalFieldsAnalyzed: uniqueFields.length,
      valuableFieldsFound: 0,
      error: error.message
    };
  }
}

/**
 * 扫描目录中的日志文件
 * @param {string} dirPath - 目录路径
 * @param {Array} extensions - 文件扩展名
 * @returns {Array} 文件列表
 */
export function scanLogFiles(dirPath, extensions = ['.log', '.txt', '.xml', '.mrs']) {
  const files = [];

  function scanDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 跳过系统目录
        const lowerName = entry.name.toLowerCase();
        if (!['node_modules', '.git', '$recycle.bin', 'system volume information'].includes(lowerName)) {
          scanDir(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.includes(ext)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            files.push({ path: fullPath, content });
          } catch {
            // 读取失败，跳过
          }
        }
      }
    }
  }

  scanDir(dirPath);
  return files;
}
