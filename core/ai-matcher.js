/**
 * AI 参数匹配模块
 * 当传统三级匹配失败时，使用 AI 辅助匹配
 */

import { callAI, extractJSON } from './ai-service.js';
import { extractFileSnippet } from './extractor.js';

/**
 * AI 参数匹配 Prompt 模板
 */
const MATCH_PROMPT_TEMPLATE = `你是MRI设备日志分析专家。请分析以下日志内容，提取指定指标的值。

目标指标：{indicator}
模板关键词：{keyword}
{synonyms}
日志来源文件：{fileName}

日志内容（相关片段）：
{logSnippet}

请严格按以下JSON格式回答（不要添加其他内容）：
{
  "matched": true 或 false,
  "actualField": "日志中实际出现的字段名（如果matched为true）",
  "value": "提取的数值或文本",
  "unit": "单位（如T、°C、%、psi等，没有则为空）",
  "confidence": 0-100的整数,
  "reasoning": "一句话说明匹配依据"
}

如果日志中没有找到与目标指标相关的数据，将matched设为false，其他字段留空。`;

/**
 * AI 辅助参数匹配
 * @param {object} rule - 采集规则
 * @param {string} filePath - 文件路径
 * @param {string} fileContent - 文件内容
 * @param {object} options - 选项
 * @returns {Promise<object>} 匹配结果
 */
export async function aiMatchParameter(rule, filePath, fileContent, options = {}) {
  const { indicator, keyword, synonyms = [], dataType, unit } = rule;

  // 提取文件片段（前200行 + 包含关键词的行）
  const snippet = extractRelevantSnippet(fileContent, keyword, synonyms);

  // 构建提示词
  const synonymsText = synonyms.length > 0
    ? `备用关键词：${synonyms.join('、')}`
    : '';

  const prompt = MATCH_PROMPT_TEMPLATE
    .replace('{indicator}', indicator)
    .replace('{keyword}', keyword)
    .replace('{synonyms}', synonymsText)
    .replace('{fileName}', filePath.split(/[\\/]/).pop())
    .replace('{logSnippet}', snippet);

  try {
    const response = await callAI(prompt, {
      temperature: 0.2,
      maxTokens: 1024,
      ...options
    });

    const result = extractJSON(response.content);

    if (result && result.matched) {
      return {
        value: result.value || null,
        matchLevel: 4, // AI 匹配级别
        matchMethod: 'AI智能匹配',
        confidence: result.confidence || 70,
        matchedKeyword: result.actualField || keyword,
        reasoning: result.reasoning || '',
        unit: result.unit || unit || '',
        aiModel: response.model
      };
    }

    return {
      value: null,
      matchLevel: 0,
      matchMethod: '未匹配',
      confidence: 0,
      matchedKeyword: keyword,
      reasoning: 'AI 未在日志中找到匹配数据'
    };

  } catch (error) {
    return {
      value: null,
      matchLevel: 0,
      matchMethod: 'AI错误',
      confidence: 0,
      matchedKeyword: keyword,
      reasoning: `AI 调用失败: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * 提取相关日志片段
 * 策略：前100行 + 包含关键词的行及其上下文
 */
function extractRelevantSnippet(content, keyword, synonyms) {
  const lines = content.split('\n');
  const maxLines = 200;
  const relevantLines = new Set();

  // 总是包含前100行
  for (let i = 0; i < Math.min(100, lines.length); i++) {
    relevantLines.add(i);
  }

  // 搜索包含关键词的行
  const searchTerms = [keyword.toLowerCase(), ...synonyms.map(s => s.toLowerCase())];

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    for (const term of searchTerms) {
      if (lineLower.includes(term.toLowerCase())) {
        // 包含该行及其前后各5行
        for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) {
          relevantLines.add(j);
        }
        break;
      }
    }
  }

  // 按顺序提取行
  const sortedIndices = Array.from(relevantLines).sort((a, b) => a - b);
  const snippet = sortedIndices
    .slice(0, maxLines)
    .map(i => lines[i])
    .join('\n');

  // 如果内容太长，截断
  if (snippet.length > 4000) {
    return snippet.substring(0, 4000) + '\n... (内容已截断)';
  }

  return snippet || content.substring(0, 2000);
}

/**
 * 批量 AI 匹配（用于采集流程中传统匹配失败的情况）
 * @param {Array} failedRules - 传统匹配失败的规则
 * @param {Array} matchedFiles - 已匹配的文件列表
 * @param {object} options - 选项
 * @returns {Promise<Array>} AI 匹配结果
 */
export async function aiBatchMatch(failedRules, matchedFiles, options = {}) {
  const results = [];

  for (const rule of failedRules) {
    // 找到最相关的文件
    const relevantFile = findMostRelevantFile(rule, matchedFiles);

    if (relevantFile) {
      const result = await aiMatchParameter(rule, relevantFile.path, relevantFile.content, options);
      results.push({
        indicator: rule.indicator,
        ...result,
        filePath: relevantFile.path
      });
    } else {
      results.push({
        indicator: rule.indicator,
        value: null,
        matchLevel: 0,
        matchMethod: '无相关文件',
        confidence: 0,
        matchedKeyword: rule.keyword,
        reasoning: '未找到相关文件供 AI 分析'
      });
    }

    // 避免请求过快
    if (options.delayBetweenRequests) {
      await new Promise(resolve => setTimeout(resolve, options.delayBetweenRequests));
    }
  }

  return results;
}

/**
 * 找到最相关的文件
 */
function findMostRelevantFile(rule, matchedFiles) {
  const pattern = rule.file_pattern?.toLowerCase() || '';

  // 优先选择路径匹配的文件
  for (const file of matchedFiles) {
    if (file.path.toLowerCase().includes(pattern)) {
      return file;
    }
  }

  // 返回第一个文件
  return matchedFiles[0] || null;
}
