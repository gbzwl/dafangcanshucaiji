/**
 * AI 智能模板生成模块
 * 根据用户自然语言需求，自动生成采集模板
 */

import { callAI, extractJSON } from './ai-service.js';
import fs from 'fs';
import path from 'path';

/**
 * 模板生成 Prompt 模板
 */
const TEMPLATE_GEN_PROMPT_TEMPLATE = `你是MRI设备数据采集专家。用户需要采集以下类型的数据：

用户需求：{userRequest}

以下是设备日志中可用的字段（从实际日志文件中提取）：

{availableFields}

请根据用户需求，生成采集模板规则。

按以下JSON格式回答（不要添加其他内容）：
{
  "templateName": "模板名称",
  "description": "模板描述",
  "rules": [
    {
      "indicator": "中文指标名称",
      "file_pattern": "参考文件路径（如 MedCom/log、MriSiteData、SysUtil）",
      "keyword": "标准关键词",
      "synonyms": ["备用关键词1", "备用关键词2"],
      "dataType": "数字或文本",
      "unit": "单位（如T、°C、%、psi等，没有则为-）",
      "reason": "为什么采集这个参数"
    }
  ],
  "totalRules": 规则数量,
  "coverage": "覆盖范围说明"
}

要求：
1. 只生成与用户需求直接相关的指标
2. 每个指标必须有明确的关键词
3. 优先选择日志中实际存在的字段
4. 规则数量控制在5-15条之间`;

/**
 * AI 生成采集模板
 * @param {string} userRequest - 用户需求（自然语言）
 * @param {Array} availableFields - 可用字段列表
 * @param {object} options - 选项
 * @returns {Promise<object>} 生成的模板
 */
export async function generateTemplate(userRequest, availableFields = [], options = {}) {
  // 构建可用字段文本
  const fieldsText = availableFields.length > 0
    ? availableFields
        .slice(0, 80)
        .map(f => `- ${f.field}: ${f.value || 'N/A'} (来自 ${f.file})`)
        .join('\n')
    : '（未提供可用字段，请基于MRI设备常见参数生成）';

  const prompt = TEMPLATE_GEN_PROMPT_TEMPLATE
    .replace('{userRequest}', userRequest)
    .replace('{availableFields}', fieldsText);

  try {
    const response = await callAI(prompt, {
      temperature: 0.5,
      maxTokens: 4096,
      ...options
    });

    const result = extractJSON(response.content);

    if (result && result.rules && result.rules.length > 0) {
      return {
        success: true,
        template: result,
        aiModel: response.model
      };
    }

    return {
      success: false,
      message: 'AI 未生成有效模板',
      rawResponse: response.content.substring(0, 500)
    };

  } catch (error) {
    return {
      success: false,
      message: `AI 调用失败: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * 将生成的模板保存为 Excel 文件
 * @param {object} template - 模板数据
 * @param {string} outputPath - 输出路径
 * @returns {string} 保存的文件路径
 */
export async function saveTemplateToExcel(template, outputPath) {
  // 动态导入 xlsx
  const XLSX = await import('xlsx');

  const wb = XLSX.utils.book_new();

  // 创建数据行
  const data = [
    ['指标名称', '参考文件', '标准关键词', '备用关键词', '数据类型', '单位']
  ];

  for (const rule of template.rules) {
    data.push([
      rule.indicator,
      rule.file_pattern,
      rule.keyword,
      (rule.synonyms || []).join(';'),
      rule.dataType || '文本',
      rule.unit || '-'
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);

  // 设置列宽
  ws['!cols'] = [
    { wch: 16 },  // 指标名称
    { wch: 16 },  // 参考文件
    { wch: 22 },  // 标准关键词
    { wch: 35 },  // 备用关键词
    { wch: 10 },  // 数据类型
    { wch: 10 }   // 单位
  ];

  XLSX.utils.book_append_sheet(wb, ws, '采集规则');

  // 添加说明 sheet
  const infoData = [
    ['模板名称', template.templateName || 'AI生成模板'],
    ['描述', template.description || ''],
    ['规则数量', template.totalRules || template.rules.length],
    ['覆盖范围', template.coverage || ''],
    ['生成时间', new Date().toISOString()],
    ['AI模型', template.aiModel || '']
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(infoData);
  wsInfo['!cols'] = [{ wch: 15 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, '模板信息');

  // 写入文件
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(outputPath, buf);

  return outputPath;
}

/**
 * 从目录中提取可用字段（用于模板生成）
 * @param {string} dirPath - 目录路径
 * @returns {Promise<Array>} 字段列表
 */
export async function extractAvailableFields(dirPath) {
  const { extractFieldsFromFile, scanLogFiles } = await import('./ai-discoverer.js');

  const files = scanLogFiles(dirPath);
  const allFields = [];

  for (const file of files.slice(0, 20)) { // 限制文件数量
    const fields = extractFieldsFromFile(file.path, file.content);
    allFields.push(...fields);
  }

  // 去重
  return Array.from(
    new Map(allFields.map(f => [f.field.toLowerCase(), f])).values()
  );
}
