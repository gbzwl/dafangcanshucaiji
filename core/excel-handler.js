/**
 * Excel 处理模块 - 模板解析（支持新旧格式）与结果生成（含可信度）
 */
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// 采集任务模板列名映射：只描述本次要采集什么，路径/关键字由 Agent 动态判断
const NEW_TEMPLATE_COLUMNS = {
  '序号': 'index', 'no': 'index', '序列': 'index',
  '指标名称': 'indicator', '指标': 'indicator', 'indicator': 'indicator',
  '基础数据指标': 'indicator', '数据指标': 'indicator',
  '指标标识': 'indicatorCode', '指标编码': 'indicatorCode', '字段标识': 'indicatorCode',
  '英文名': 'indicatorCode', 'indicator_code': 'indicatorCode', 'code': 'indicatorCode',
  '参考文件': 'file_pattern', '文件路径': 'file_pattern', 'file_pattern': 'file_pattern', 'file_path': 'file_pattern',
  '关键字': 'keyword', '标准关键词': 'keyword', 'keyword': 'keyword',
  '备用关键字': 'synonyms', '备用关键词': 'synonyms', '同义词': 'synonyms', 'synonyms': 'synonyms',
  '关键字和含义': 'keywordMeaning', '关键字段及含义': 'keywordMeaning', '含义': 'keywordMeaning',
  'keywordMeaning': 'keywordMeaning', 'keywordmeaning': 'keywordMeaning', 'keyword_meaning': 'keywordMeaning',
  '数据类型': 'dataType', 'data_type': 'dataType',
  '单位': 'unit', 'unit': 'unit'
};

// 旧模板列名映射
const OLD_TEMPLATE_COLUMNS = {
  '数据指标': 'indicator', '指标': 'indicator', 'indicator': 'indicator',
  '指标标识': 'indicatorCode', '指标编码': 'indicatorCode', '字段标识': 'indicatorCode',
  '英文名': 'indicatorCode', 'indicator_code': 'indicatorCode', 'code': 'indicatorCode',
  '文件路径': 'file_pattern', 'file_path': 'file_pattern',
  '关键字': 'keyword', 'keyword': 'keyword',
  '关键字和含义': 'keywordMeaning', '关键字段及含义': 'keywordMeaning', '含义': 'keywordMeaning',
  'keywordMeaning': 'keywordMeaning', 'keywordmeaning': 'keywordMeaning', 'keyword_meaning': 'keywordMeaning'
};

/**
 * 解析 Excel 模板（自动识别新旧格式）
 * @param {Buffer} buffer - Excel 文件 buffer
 * @returns {Array<{indicator: string, indicatorCode: string, file_pattern: string, keyword: string, synonyms: string[], dataType: string, unit: string}>}
 */
export function parseTemplate(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

  if (data.length < 2) {
    throw new Error('模板文件为空或格式不正确');
  }

  const headers = data[0].map(h => String(h || '').trim());

  // 检测是新格式还是旧格式
  const isNewFormat = headers.some(h =>
    ['序号', '指标名称', '指标', '基础数据指标', '指标标识', '指标编码', '参考文件', '文件路径', '关键字', '标准关键词', '备用关键字', '备用关键词', '关键字和含义', '关键字段及含义', '数据类型', '单位'].includes(h)
  );

  const columnMap = isNewFormat ? NEW_TEMPLATE_COLUMNS : OLD_TEMPLATE_COLUMNS;

  // 构建列索引映射
  const columnIndex = {};
  headers.forEach((header, index) => {
    const normalizedHeader = header.toLowerCase().trim();
    const fieldName = columnMap[normalizedHeader] || columnMap[header];
    if (fieldName && columnIndex[fieldName] === undefined) {
      columnIndex[fieldName] = index;
    }
  });

  // 验证必要列
  if (columnIndex.indicator === undefined) {
    throw new Error('模板缺少"指标名称"列');
  }
  const rules = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    const indicator = row[columnIndex.indicator];
    const indicatorCode = columnIndex.indicatorCode !== undefined ? row[columnIndex.indicatorCode] : '';
    const filePattern = columnIndex.file_pattern !== undefined ? row[columnIndex.file_pattern] : '';
    const keyword = columnIndex.keyword !== undefined ? row[columnIndex.keyword] : '';

    if (!indicator) continue;

    const rule = {
      indicator: String(indicator).trim(),
      indicatorCode: indicatorCode ? String(indicatorCode).trim() : '',
      file_pattern: filePattern ? String(filePattern).trim() : '',
      keyword: keyword ? String(keyword).trim() : '',
      synonyms: [],
      keywordMeaning: '',
      dataType: '',
      unit: ''
    };

    // 解析备用关键词（新格式）
    if (columnIndex.synonyms !== undefined && row[columnIndex.synonyms]) {
      const synonymsStr = String(row[columnIndex.synonyms]).trim();
      rule.synonyms = synonymsStr
        .split(/[;；,，]/)
        .map(s => s.trim())
        .filter(Boolean);
    }

    if (columnIndex.keywordMeaning !== undefined && row[columnIndex.keywordMeaning]) {
      rule.keywordMeaning = String(row[columnIndex.keywordMeaning]).trim();
    }

    // 解析数据类型（新格式）
    if (columnIndex.dataType !== undefined && row[columnIndex.dataType]) {
      rule.dataType = String(row[columnIndex.dataType]).trim();
    }

    // 解析单位（新格式）
    if (columnIndex.unit !== undefined && row[columnIndex.unit]) {
      rule.unit = String(row[columnIndex.unit]).trim();
    }

    rules.push(rule);
  }

  if (rules.length === 0) {
    throw new Error('模板中没有有效的采集规则');
  }

  return rules;
}

/**
 * 生成结果 Excel（含可信度列）
 * @param {Array} results - 采集结果
 * @param {Object} scanLog - 扫描日志
 * @param {string} outputPath - 输出路径
 */
export function generateResultExcel(results, scanLog, outputPath) {
  const wb = XLSX.utils.book_new();

  // Sheet 1: 采集结果
  const resultHeaders = ['序号', '指标', '采集值', '文件路径', '匹配关键字', '关键字和含义', '证据内容', '置信度', '状态'];
  const resultData = [resultHeaders];

  let rowIndex = 1;
  for (const item of results) {
    resultData.push([
      rowIndex++,
      item.indicator || '',
      item.value || '-',
      item.file_path || item.filePath || '-',
      item.matchedKeyword || '-',
      item.keywordMeaning || item.keyword_meaning || '-',
      item.match_line || item.evidence || item.line || '-',
      item.confidence || 0,
      item.status || (isSuccessfulResult(item) ? 'success' : 'not_found')
    ]);
  }

  const wsResult = XLSX.utils.aoa_to_sheet(resultData);

  // 设置列宽
  wsResult['!cols'] = [
    { wch: 8 }, { wch: 20 }, { wch: 18 }, { wch: 55 }, { wch: 24 },
    { wch: 36 }, { wch: 70 }, { wch: 12 }, { wch: 14 }
  ];

  // 表头样式
  for (let c = 0; c < resultHeaders.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (!wsResult[cellRef]) continue;
    wsResult[cellRef].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '2B579A' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    };
  }

  XLSX.utils.book_append_sheet(wb, wsResult, '采集结果');

  // Sheet 2: 未找到列表
  const missingHeaders = ['指标', '指标标识', '文件路径', '匹配关键字', '关键字和含义', '原因'];
  const missingData = [missingHeaders];
  const missingItems = results.filter(r => !isSuccessfulResult(r));

  for (const item of missingItems) {
    missingData.push([
      item.indicator || '',
      item.indicatorCode || item.indicator_code || '',
      item.file_pattern || '',
      item.matchedKeyword || item.keyword || '',
      item.keywordMeaning || item.keyword_meaning || '',
      item.reason || '未找到可验证证据'
    ]);
  }

  const wsMissing = XLSX.utils.aoa_to_sheet(missingData);
  wsMissing['!cols'] = [{ wch: 20 }, { wch: 28 }, { wch: 40 }, { wch: 25 }, { wch: 36 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsMissing, '未找到列表');

  // Sheet 3: 扫描日志
  const logData = [
    ['项目', '值'],
    ['扫描时间', scanLog.scan_time],
    ['目标磁盘', scanLog.disk],
    ['扫描文件总数', scanLog.total_files],
    ['成功采集数', scanLog.success_count],
    ['失败/未找到数', scanLog.fail_count],
    ['总指标数', scanLog.total_indicators],
    ['耗时(秒)', scanLog.duration],
    ['模板规则数', scanLog.template_rules],
    ['使用索引', scanLog.used_index ? '是' : '否'],
    [''],
    ['匹配方式分布', ''],
  ];

  // 统计匹配方式分布
  const methodStats = {};
  for (const r of results) {
    const method = r.matchMethod || r.match_method || r.agentMethod || (r.status ? `Agent ${r.status}` : '未匹配');
    methodStats[method] = (methodStats[method] || 0) + 1;
  }
  for (const [method, count] of Object.entries(methodStats)) {
    logData.push([method, `${count} 个指标`]);
  }

  // 可信度统计
  logData.push(['']);
  logData.push(['可信度分布', '']);
  const confidenceRanges = { '100%（精确匹配）': 0, '80-99%（高可信）': 0, '60-79%（中可信）': 0, '<60%（低可信）': 0 };
  for (const r of results) {
    if (!isSuccessfulResult(r)) continue;
    const c = r.confidence || 0;
    if (c >= 100) confidenceRanges['100%（精确匹配）']++;
    else if (c >= 80) confidenceRanges['80-99%（高可信）']++;
    else if (c >= 60) confidenceRanges['60-79%（中可信）']++;
    else confidenceRanges['<60%（低可信）']++;
  }
  for (const [range, count] of Object.entries(confidenceRanges)) {
    if (count > 0) logData.push([range, `${count} 个指标`]);
  }

  const wsLog = XLSX.utils.aoa_to_sheet(logData);
  wsLog['!cols'] = [{ wch: 25 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsLog, '扫描日志');

  // 写入文件
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(outputPath, wbout);
}

function isSuccessfulResult(result) {
  if (!result) return false;
  if (result.success === true) return true;
  if (result.status === 'success' || result.status === 'verified') return true;
  if (result.value && result.value !== '未找到') return true;
  return false;
}

/**
 * 生成采集任务模板示例
 */
export function generateTemplateExample(outputPath) {
  const wb = XLSX.utils.book_new();

  const headers = ['序号', '指标', '指标标识'];
  const exampleData = [
    headers,
    [1, '磁场强度', 'FieldStrength'],
    [2, '射频功率', 'RFPower'],
    [3, '梯度线圈温度', 'GradientTemperature'],
    [4, '液氦水平', 'HeliumLevel'],
    [5, '系统运行时长', 'SystemUptime'],
    [6, '冷头压力', 'ColdHeadPressure'],
    [7, '系统版本', 'SystemVersion'],
    [8, '最后校准时间', 'LastCalibrationTime'],
    [9, '设备序列号', 'SerialNumber'],
    [10, '球管曝光次数', 'TubeExposureCount']
  ];

  const ws = XLSX.utils.aoa_to_sheet(exampleData);
  ws['!cols'] = [
    { wch: 8 }, { wch: 22 }, { wch: 28 }
  ];

  // 表头样式
  for (let c = 0; c < headers.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (!ws[cellRef]) continue;
    ws[cellRef].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '2B579A' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    };
  }

  XLSX.utils.book_append_sheet(wb, ws, '采集任务');

  // 说明 Sheet
  const helpData = [
    ['字段说明', ''],
    ['字段名', '说明'],
    ['序号', '可选，用于人工排序'],
    ['指标', '必填。本次需要采集的中文指标名称'],
    ['指标标识', '可选。根据历史经验推测的英文名、字段名或缩写，供 Agent 参考'],
    ['', ''],
    ['使用说明', '采集任务模板只表示“本次要找什么”，不要把旧表经验、路径、关键字说明填到这里'],
    ['路径和关键字', '由 Agent 在采集时结合知识库和模型推测，再调用工具验证'],
    ['旧表知识库', '请使用“采集经验库 -> 导入旧表”入口导入历史经验']
  ];

  const wsHelp = XLSX.utils.aoa_to_sheet(helpData);
  wsHelp['!cols'] = [{ wch: 35 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, wsHelp, '使用说明');

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(outputPath, wbout);
}

/**
 * 生成旧表/知识库导入模板示例
 */
export function generateKnowledgeImportTemplateExample(outputPath) {
  const wb = XLSX.utils.book_new();
  const headers = ['序号', '指标', '指标标识', '文件路径', '关键字及含义'];
  const data = [
    headers,
    [1, '设备序列号', 'SerialNumber', 'C:/logs/ctconfig.xml', 'SerialNumber=ABC123，表示设备序列号'],
    [2, '球管曝光次数', 'TubeExposureCount', 'C:/logs/tube_history_*.log', 'Exposure Count: 123，表示球管累计曝光次数'],
    [3, '系统版本', 'SystemVersion', '', 'SystemVersion 或 Software Version 通常表示系统软件版本'],
    [4, '冷头压力', 'ColdHeadPressure', '', '']
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [
    { wch: 8 }, { wch: 22 }, { wch: 28 }, { wch: 46 }, { wch: 70 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, '旧表经验');

  const helpData = [
    ['字段说明', ''],
    ['序号', '可选，用于人工排序'],
    ['指标', '建议填写。历史经验对应的中文指标名'],
    ['指标标识', '可选。历史经验中推测出的英文名、字段名或缩写'],
    ['文件路径', '可选。历史找到过的路径，可以包含文件名，盘符不同也没关系'],
    ['关键字及含义', '可选。历史证据摘要、结果描述、关键字段说明，可包含中文说明和英文日志片段'],
    ['', ''],
    ['使用说明', '这个模板只用于补充知识库，不会作为本次采集任务执行'],
    ['空值处理', '除指标外都可以为空；程序会尽量保留原始信息，后续由 Agent 拆解和验证']
  ];
  const wsHelp = XLSX.utils.aoa_to_sheet(helpData);
  wsHelp['!cols'] = [{ wch: 20 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsHelp, '使用说明');

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  fs.writeFileSync(outputPath, wbout);
}
