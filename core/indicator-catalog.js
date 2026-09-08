import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const SUPPORTED_TYPES = new Set(['CT', 'MR', 'DR']);

export function normalizeDeviceType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (type === 'MRI') return 'MR';
  return SUPPORTED_TYPES.has(type) ? type : '';
}

export function listIndicatorCatalogs(templatesDir) {
  return [...SUPPORTED_TYPES].map(deviceType => {
    const indicators = getIndicatorCatalog(templatesDir, deviceType);
    return { deviceType, count: indicators.length };
  });
}

export function getIndicatorCatalog(templatesDir, requestedType) {
  const deviceType = normalizeDeviceType(requestedType);
  if (!deviceType) {
    throw new Error('设备类型仅支持 CT、MR 或 DR');
  }

  const filePath = path.join(templatesDir, `${deviceType}采集任务模板.xlsx`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`未找到 ${deviceType} 固定指标模板`);
  }

  const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
  const sheet = workbook.Sheets['采集任务'] || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) return [];

  const headers = rows[0].map(value => String(value || '').trim());
  const indexColumn = headers.findIndex(value => ['序号', '顺序', 'no'].includes(value.toLowerCase()));
  const nameColumn = headers.findIndex(value => ['指标', '指标名称'].includes(value));
  const codeColumn = headers.findIndex(value => ['指标标识', '指标编码', '字段标识'].includes(value));
  if (nameColumn < 0) throw new Error(`${deviceType} 固定指标模板缺少“指标”列`);

  return rows.slice(1).map((row, offset) => {
    const order = Number(indexColumn >= 0 ? row[indexColumn] : offset + 1) || offset + 1;
    const indicator = String(row[nameColumn] || '').trim();
    const indicatorCode = String(codeColumn >= 0 ? row[codeColumn] || '' : '').trim();
    return {
      id: `${deviceType}_${String(order).padStart(3, '0')}`,
      deviceType,
      order,
      indicator,
      indicatorCode,
      enabled: true
    };
  }).filter(item => item.indicator);
}

export function getIndicatorTemplatePath(templatesDir, requestedType) {
  const deviceType = normalizeDeviceType(requestedType);
  if (!deviceType) throw new Error('设备类型仅支持 CT、MR 或 DR');
  const filePath = path.join(templatesDir, `${deviceType}采集任务模板.xlsx`);
  if (!fs.existsSync(filePath)) throw new Error(`未找到 ${deviceType} 固定指标模板`);
  return filePath;
}
