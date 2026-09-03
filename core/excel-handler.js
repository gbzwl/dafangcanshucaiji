/**
 * Excel 处理模块 - 模板解析（支持新旧格式）与结果生成（含可信度）
 */
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// 新模板列名映射（支持中英文，4列简化版）
const NEW_TEMPLATE_COLUMNS = {
  '指标名称': 'indicator', '指标': 'indicator', 'indicator': 'indicator',
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
  '文件路径': 'file_pattern', 'file_path': 'file_pattern',
  '关键字': 'keyword', 'keyword': 'keyword',
  '关键字和含义': 'keywordMeaning', '关键字段及含义': 'keywordMeaning', '含义': 'keywordMeaning',
  'keywordMeaning': 'keywordMeaning', 'keywordmeaning': 'keywordMeaning', 'keyword_meaning': 'keywordMeaning'
};

/**
 * 解析 Excel 模板（自动识别新旧格式）
 * @param {Buffer} buffer - Excel 文件 buffer
 * @returns {Array<{indicator: string, file_pattern: string, keyword: string, synonyms: string[], dataType: string, unit: string}>}
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
    ['指标名称', '参考文件', '关键字', '标准关键词', '备用关键字', '备用关键词', '关键字和含义', '关键字段及含义', '数据类型', '单位'].includes(h)
  );

  const columnMap = isNewFormat ? NEW_TEMPLATE_COLUMNS : OLD_TEMPLATE_COLUMNS;

  // 构建列索引映射
  const columnIndex = {};
  headers.forEach((header, index) => {
    const normalizedHeader = header.toLowerCase().trim();
    const fieldName = columnMap[normalizedHeader] || columnMap[header];
    if (fieldName && !columnIndex[fieldName]) {
      columnIndex[fieldName] = index;
    }
  });

  // 验证必要列
  if (columnIndex.indicator === undefined) {
    throw new Error('模板缺少"指标名称"列');
  }
  if (columnIndex.file_pattern === undefined) {
    throw new Error('模板缺少"参考文件"列');
  }
  if (columnIndex.keyword === undefined) {
    throw new Error('模板缺少"标准关键词"列');
  }

  const rules = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    const indicator = row[columnIndex.indicator];
    const filePattern = row[columnIndex.file_pattern];
    const keyword = row[columnIndex.keyword];

    if (!indicator) continue;

    const rule = {
      indicator: String(indicator).trim(),
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
  const resultHeaders = ['序号', '指标', '文件路径', '匹配关键字', '关键字和含义', '匹配行内容'];
  const resultData = [resultHeaders];

  let rowIndex = 1;
  for (const item of results) {
    resultData.push([
      rowIndex++,
      item.indicator || '',
      item.file_path || item.filePath || '-',
      item.matchedKeyword || '-',
      item.keywordMeaning || item.keyword_meaning || '-',
      item.match_line || item.evidence || item.line || '-'
    ]);
  }

  const wsResult = XLSX.utils.aoa_to_sheet(resultData);

  // 设置列宽
  wsResult['!cols'] = [
    { wch: 8 }, { wch: 20 }, { wch: 55 }, { wch: 24 },
    { wch: 36 }, { wch: 70 }
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
  const missingHeaders = ['指标', '参考文件', '标准关键词', '备用关键词', '关键字和含义', '原因'];
  const missingData = [missingHeaders];
  const missingItems = results.filter(r => !isSuccessfulResult(r));

  for (const item of missingItems) {
    missingData.push([
      item.indicator || '',
      item.file_pattern || '',
      item.keyword || '',
      Array.isArray(item.synonyms) ? item.synonyms.join('; ') : (item.synonyms || ''),
      item.keywordMeaning || item.keyword_meaning || '',
      '文件未找到或关键字未匹配'
    ]);
  }

  const wsMissing = XLSX.utils.aoa_to_sheet(missingData);
  wsMissing['!cols'] = [{ wch: 20 }, { wch: 25 }, { wch: 25 }, { wch: 30 }, { wch: 36 }, { wch: 25 }];
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
 * 生成新格式模板示例
 */
export function generateTemplateExample(outputPath) {
  const wb = XLSX.utils.book_new();

  const headers = ['指标名称', '参考文件', '关键字', '备用关键字', '关键字和含义'];
  const exampleData = [
    headers,
    ['磁场强度', 'MedCom/log', 'FieldStrength', 'Field;B0;Magnet', 'FieldStrength 表示系统磁场强度'],
    ['射频功率', 'MedCom/log', 'RF_Power', 'RF Power;TransmitPower', 'RF_Power 表示射频发射功率'],
    ['梯度线圈温度', 'MriSiteData', 'GradientTemp', 'Gradient Coil Temp;GTemp', 'GradientTemp 表示梯度线圈温度'],
    ['液氦水平', 'MriSiteData', 'Helium MPS Level', 'Helium Level;He Level;HeMPS', 'Helium MPS Level 表示液氦水平'],
    ['系统运行时长', 'SysUtil', 'UptimeHours', 'System Uptime;Up Time', 'UptimeHours 表示系统运行时长'],
    ['冷头压力', 'MriSiteData', 'ColdHeadPressure', 'Cold Head;Pressure', 'ColdHeadPressure 表示冷头压力'],
    ['系统版本', 'SysUtil', 'SystemVersion', 'SW Version;Syngo Ver', 'SystemVersion 表示系统软件版本'],
    ['最后校准时间', 'MriSiteData', 'LastCalibration', 'Calibration Date;LastCal', 'LastCalibration 表示最后校准时间'],
    ['患者ID', 'MedCom/log', 'Patient ID', 'PatID;PatientID', 'Patient ID 表示患者编号字段'],
    ['序列名称', 'MedCom/log', 'SequenceName', 'Sequence;Seq Name', 'SequenceName 表示扫描序列名称']
  ];

  const ws = XLSX.utils.aoa_to_sheet(exampleData);
  ws['!cols'] = [
    { wch: 16 }, { wch: 16 }, { wch: 22 }, { wch: 30 }, { wch: 40 }
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

  XLSX.utils.book_append_sheet(wb, ws, '采集规则');

  // 说明 Sheet
  const helpData = [
    ['字段说明', ''],
    ['字段名', '说明'],
    ['指标名称', '要采集的参数名称，将显示在结果中'],
    ['参考文件', '日志文件的路径片段或文件名片段（模糊匹配，不区分大小写）'],
    ['标准关键词', '在日志文件中搜索的主要关键字'],
    ['备用关键词', '当标准关键词未匹配时，依次尝试的同义词（用分号分隔）'],
    ['数据类型', '参数的数据类型：数字/文本（用于结果校验）'],
    ['单位', '参数的单位（如 ℃、K、%、T、W 等）'],
    ['', ''],
    ['匹配规则说明', ''],
    ['1. 精确匹配（可信度100%）', '关键词直接出现在日志中，如 FieldStrength = 3.0T'],
    ['2. 模糊匹配（可信度60-90%）', '关键词拆分为多个单词，部分匹配即可'],
    ['3. 同义词匹配（可信度50-80%）', '使用备用关键词进行匹配'],
    ['', ''],
    ['路径匹配说明', ''],
    ['参考文件字段支持', '文件名、文件夹名、路径片段、通配符(*.log)'],
    ['示例: MedCom/log', '匹配路径中包含 MedCom/log 的文件'],
    ['示例: gradient', '匹配文件名或文件夹名包含 gradient 的文件'],
    ['示例: *.mrs', '匹配所有 .mrs 扩展名的文件'],
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
