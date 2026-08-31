/**
 * 参数提取模块 - 精确匹配引擎
 * 
 * 匹配优先级：
 * 1. 关键字（keyword）- 精确匹配
 * 2. 备用关键字（synonyms）- 按顺序精确匹配
 * 3. 指标名称（indicator）- 精确匹配
 */
import fs from 'fs';
import iconv from 'iconv-lite';

/**
 * 从文件中提取参数（精确匹配）
 * @param {string} filePath - 文件路径
 * @param {string} keyword - 关键字
 * @param {string[]} synonyms - 备用关键字列表
 * @param {string} indicator - 指标名称
 * @returns {{success: boolean, value: string|null, matchedKeyword: string, matchLine: string, lineNumber: number, file_path: string}}
 */
export function extractParameter(filePath, keyword, synonyms = [], indicator = '') {
  const result = {
    success: false,
    value: null,
    matchedKeyword: null,
    matchLine: null,
    lineNumber: null,
    matchType: null,
    file_path: filePath
  };

  // 读取文件内容
  let contentLines = null;
  try {
    contentLines = readFileLines(filePath);
  } catch (err) {
    result.value = `读取错误: ${err.message}`;
    return result;
  }

  if (!contentLines || contentLines.length === 0) {
    return result;
  }

  // 构建搜索关键字列表：关键字 → 备用关键字 → 指标名称
  const searchKeywords = [];
  if (keyword && keyword.trim()) searchKeywords.push(keyword.trim());
  if (synonyms && synonyms.length > 0) {
    for (const syn of synonyms) {
      if (syn && syn.trim()) searchKeywords.push(syn.trim());
    }
  }
  if (indicator && indicator.trim() && !searchKeywords.includes(indicator.trim())) {
    searchKeywords.push(indicator.trim());
  }

  // 按优先级搜索
  for (const searchKey of searchKeywords) {
    const exactResult = exactMatch(contentLines, searchKey);
    if (exactResult.found) {
      result.success = true;
      result.value = exactResult.value;
      result.matchedKeyword = searchKey;
      result.matchLine = exactResult.line;
      result.lineNumber = exactResult.lineNumber;
      result.matchType = exactResult.matchType || 'exact';
      result.matchedWord = exactResult.matchedWord || searchKey;
      return result;
    }
  }

  return result;
}

/**
 * 单词拆分匹配提取
 */
export function extractParameterWithWordMatch(filePath, keyword, words, indicator = '') {
  const result = {
    success: false,
    value: null,
    matchedKeyword: null,
    matchLine: null,
    lineNumber: null,
    matchType: 'partial',
    file_path: filePath
  };

  let contentLines = null;
  try {
    contentLines = readFileLines(filePath);
  } catch (err) {
    return result;
  }

  if (!contentLines || contentLines.length === 0) {
    return result;
  }

  const wordMatchResult = wordMatch(contentLines, keyword);
  if (wordMatchResult.found) {
    result.success = true;
    result.value = wordMatchResult.value;
    result.matchedKeyword = keyword;
    result.matchLine = wordMatchResult.line;
    result.lineNumber = wordMatchResult.lineNumber;
    result.matchType = 'partial';
    result.matchedWord = wordMatchResult.matchedWord || keyword;
  }

  return result;
}

/**
 * 一级：精确匹配（完整关键字）
 * 尝试多种精确匹配模式
 */
function exactMatch(lines, keyword) {
  const escapedKeyword = escapeRegex(keyword);

  const patterns = [
    // keyword = value / keyword: value
    new RegExp(`\\b${escapedKeyword}\\b\\s*[=:]\\s*(.+)`, 'i'),
    // keyword 后跟数字+单位
    new RegExp(`\\b${escapedKeyword}\\b\\s*[:=]?\\s*(-?[\\d.]+\\s*[a-zA-Zμ°%\\/³]+)`, 'i'),
    // keyword 后跟带引号的字符串
    new RegExp(`\\b${escapedKeyword}\\b\\s*[:=]?\\s*["']([^"']+)["']`, 'i'),
    // XML 标签: <keyword>value</keyword>
    new RegExp(`<[^>]*\\b${escapedKeyword}\\b[^>]*>([^<]+)</`, 'i'),
    // XML 属性: keyword="value"
    new RegExp(`\\b${escapedKeyword}\\b\\s*=\\s*["']([^"']+)["']`, 'i'),
    // 时间格式
    new RegExp(`\\b${escapedKeyword}\\b\\s*[:=]?\\s*(\\d{4}[-/]\\d{2}[-/]\\d{2}[\\sT]\\d{2}:\\d{2}(?::\\d{2})?)`, 'i'),
    // 纯数值
    new RegExp(`\\b${escapedKeyword}\\b\\s*[:=]?\\s*(-?[\\d.]+)`, 'i'),
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const value = match[1].trim();
        if (value) {
          const trimmedLine = line.trim();
          const displayLine = truncateLine(trimmedLine, keyword);
          return { found: true, value, line: displayLine, lineNumber: i + 1, matchType: 'exact', matchedWord: keyword };
        }
      }
    }
  }

  return { found: false };
}

/**
 * 二级：单词拆分匹配
 * 将关键字拆分为单词，只要有一个单词匹配就算
 */
function wordMatch(lines, keyword) {
  const words = splitIntoWords(keyword);
  if (words.length <= 1) {
    return { found: false };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    for (const word of words) {
      if (word.length < 2) continue;

      const escapedWord = escapeRegex(word);
      const patterns = [
        new RegExp(`\\b${escapedWord}\\b\\s*[=:]\\s*(.+)`, 'i'),
        new RegExp(`\\b${escapedWord}\\b\\s*[:=]?\\s*(-?[\\d.]+\\s*[a-zA-Zμ°%\\/³]+)`, 'i'),
        new RegExp(`\\b${escapedWord}\\b\\s*[:=]?\\s*["']([^"']+)["']`, 'i'),
        new RegExp(`\\b${escapedWord}\\b\\s*[:=]?\\s*(-?[\\d.]+)`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const value = match[1].trim();
          if (value) {
            const trimmedLine = line.trim();
            const displayLine = truncateLine(trimmedLine, word);
            return { found: true, value, line: displayLine, lineNumber: i + 1, matchType: 'partial', matchedWord: word };
          }
        }
      }
    }
  }

  return { found: false };
}

/**
 * 截取行内容：超过100字符时取关键字前后各50字符
 */
function truncateLine(line, keyword) {
  if (line.length <= 100) return line;

  const keywordIndex = line.toLowerCase().indexOf(keyword.toLowerCase());
  if (keywordIndex >= 0) {
    const start = Math.max(0, keywordIndex - 50);
    const end = Math.min(line.length, keywordIndex + keyword.length + 50);
    return (start > 0 ? '...' : '') + line.substring(start, end) + (end < line.length ? '...' : '');
  }

  return line.substring(0, 100) + '...';
}

/**
 * 二级：模糊匹配
 * 将关键词拆分为单词，查找所有单词或部分单词出现在同一行的情况
 */
function fuzzyMatch(lines, keyword) {
  // 拆分关键词为单词（按空格、下划线、驼峰拆分）
  const words = splitIntoWords(keyword);
  if (words.length <= 1) {
    // 只有一个单词，无法进行模糊匹配
    return { found: false };
  }

  let bestMatch = null;
  let bestConfidence = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase();

    // 计算有多少个单词出现在这一行
    let matchedWords = 0;
    const matchedWordList = [];

    for (const word of words) {
      if (word.length < 2) continue; // 跳过太短的单词
      const escapedWord = escapeRegex(word);
      const wordBoundaryPattern = new RegExp(`\\b${escapedWord}\\b`, 'i');
      if (wordBoundaryPattern.test(line)) {
        matchedWords++;
        matchedWordList.push(word);
      }
    }

    // 至少需要匹配 50% 的单词
    const ratio = matchedWords / words.length;
    if (ratio < 0.5) continue;

    // 计算可信度：基于匹配比例
    const confidence = Math.round(ratio * 90);

    if (confidence > bestConfidence) {
      // 尝试从匹配行中提取值
      const value = extractValueFromLine(line, matchedWordList);
      if (value) {
        bestConfidence = confidence;
        bestMatch = {
          found: true,
          value,
          confidence,
          line: line.trim(),
          lineNumber: i + 1,
          matchedWord: matchedWordList[0] // 返回第一个匹配到的单词
        };
      }
    }
  }

  return bestMatch || { found: false };
}

/**
 * 将关键词拆分为单词
 * 支持空格、下划线、驼峰命名拆分
 */
function splitIntoWords(keyword) {
  // 先按下划线和空格拆分
  let parts = keyword.split(/[\s_]+/).filter(Boolean);

  // 再对每个部分进行驼峰拆分
  const words = [];
  for (const part of parts) {
    // 驼峰拆分: FieldStrength -> Field, Strength
    const camelParts = part.replace(/([a-z])([A-Z])/g, '$1 $2')
                          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
                          .split(/\s+/)
                          .filter(w => w.length >= 2);
    words.push(...camelParts);
  }

  return [...new Set(words)]; // 去重
}

/**
 * 从匹配行中提取值
 */
function extractValueFromLine(line, matchedWords) {
  // 尝试多种提取模式
  for (const word of matchedWords) {
    const escaped = escapeRegex(word);

    // 模式1: word = value / word: value
    const kvMatch = line.match(new RegExp(`${escaped}[^=:]*[=:]\\s*(.+)`, 'i'));
    if (kvMatch) {
      const val = kvMatch[1].trim().replace(/[;,]\s*$/, '');
      if (val) return val;
    }

    // 模式2: word 后跟数字+单位
    const numMatch = line.match(new RegExp(`${escaped}[^=:]*[:=]?\\s*(-?[\\d.]+\\s*[a-zA-Zμ°%\\/³]+)`, 'i'));
    if (numMatch) return numMatch[1].trim();
  }

  // 模式3: 行中最后一个数值
  const lastNum = line.match(/(-?[\d.]+\s*[a-zA-Zμ°%\\/³]*)\s*$/);
  if (lastNum) return lastNum[1].trim();

  return null;
}

/**
 * 提取文件内容片段（用于 AI 分析）
 * 读取文件前 N 行，并截取与关键词相关的上下文
 * @param {string} filePath - 文件路径
 * @param {string} keyword - 关键词
 * @param {number} maxLines - 最大行数（默认 100）
 * @returns {string} 截取的内容
 */
export function extractFileSnippet(filePath, keyword, maxLines = 100) {
  try {
    const encodings = ['utf-8', 'gbk', 'gb2312', 'latin-1'];
    let lines = null;

    for (const enc of encodings) {
      try {
        const content = fs.readFileSync(filePath, { encoding: enc });
        lines = content.split(/\r?\n/);
        break;
      } catch {
        continue;
      }
    }

    if (!lines) return '[无法读取文件]';

    // 如果文件行数少于 maxLines，返回全部内容
    if (lines.length <= maxLines) {
      return lines.join('\n');
    }

    // 查找关键词所在行
    const keywordLower = keyword.toLowerCase();
    let targetLine = -1;

    for (let i = 0; i < Math.min(lines.length, 500); i++) {
      if (lines[i].toLowerCase().includes(keywordLower)) {
        targetLine = i;
        break;
      }
    }

    if (targetLine >= 0) {
      // 返回关键词所在行及其上下文（前后各 20 行）
      const start = Math.max(0, targetLine - 20);
      const end = Math.min(lines.length, targetLine + 20);
      const snippet = lines.slice(start, end);
      return `... (第${start + 1}-${end}行，共${lines.length}行) ...\n` + snippet.join('\n');
    }

    // 未找到关键词，返回前 maxLines 行
    return lines.slice(0, maxLines).join('\n') + `\n... (共${lines.length}行)`;
  } catch (err) {
    return `[读取文件失败: ${err.message}]`;
  }
}

/**
 * 批量提取参数
 * @param {Array<{indicator: string, keyword: string, synonyms?: string[], files: string[]}>} tasks
 */
export function batchExtract(tasks) {
  const results = [];

  for (const task of tasks) {
    // 构建搜索关键字列表：关键字 → 备用关键字 → 指标名称
    const searchKeywords = [];
    if (task.keyword && task.keyword.trim()) searchKeywords.push({ text: task.keyword.trim(), source: 'keyword' });
    if (task.synonyms && task.synonyms.length > 0) {
      for (const syn of task.synonyms) {
        if (syn && syn.trim()) searchKeywords.push({ text: syn.trim(), source: 'synonym' });
      }
    }
    if (task.indicator && task.indicator.trim() && !searchKeywords.some(k => k.text === task.indicator.trim())) {
      searchKeywords.push({ text: task.indicator.trim(), source: 'indicator' });
    }

    // 对每个关键字都进行搜索，每个关键字一行结果
    for (const searchKey of searchKeywords) {
      const result = {
        indicator: task.indicator,
        value: null,
        success: false,
        matchedKeyword: searchKey.text,
        matchType: null,
        file_path: null,
        line_number: null,
        match_line: null,
        file_pattern: task.file_pattern
      };

      // 如果有数据类型约束，记录
      if (task.dataType) result.dataType = task.dataType;
      if (task.unit) result.unit = task.unit;

      // 依次尝试每个文件
      let found = false;
      for (const filePath of task.files || []) {
        // 一级：完整关键字精确匹配
        let extractResult = extractParameter(filePath, searchKey.text, [], task.indicator);

        if (extractResult.success && extractResult.value) {
          // 数据类型校验
          if (task.dataType === 'number') {
            const numMatch = String(extractResult.value).match(/-?[\d.]+/);
            if (numMatch) {
              result.value = numMatch[0];
            } else {
              continue;
            }
          } else {
            result.value = extractResult.value;
          }

          result.success = true;
          result.matchedKeyword = searchKey.text;
          result.matchType = extractResult.matchType || 'exact';
          result.file_path = filePath;
          result.line_number = extractResult.lineNumber;
          result.match_line = extractResult.matchLine;
          found = true;
          break;
        }

        // 二级：单词拆分匹配（仅对多单词关键字）
        const words = splitIntoWords(searchKey.text);
        if (words.length > 1) {
          extractResult = extractParameterWithWordMatch(filePath, searchKey.text, words, task.indicator);

          if (extractResult.success && extractResult.value) {
            if (task.dataType === 'number') {
              const numMatch = String(extractResult.value).match(/-?[\d.]+/);
              if (numMatch) {
                result.value = numMatch[0];
              } else {
                continue;
              }
            } else {
              result.value = extractResult.value;
            }

            result.success = true;
            result.matchedKeyword = searchKey.text;
            result.matchType = 'partial';
            result.matchedWord = extractResult.matchedWord || searchKey.text;
            result.file_path = filePath;
            result.line_number = extractResult.lineNumber;
            result.match_line = extractResult.matchLine;
            found = true;
            break;
          }
        }
      }

      results.push(result);
    }
  }

  return results;
}

/**
 * 读取文件行（支持多编码）
 */
function readFileLines(filePath) {
  const buffer = fs.readFileSync(filePath);

  const encodings = ['utf-8', 'gbk', 'gb2312', 'utf-16le', 'latin-1'];

  for (const enc of encodings) {
    try {
      let content;
      if (enc === 'utf-8') {
        // 检查 UTF-8 BOM
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
          content = buffer.toString('utf-8', 3);
        } else {
          content = buffer.toString('utf-8');
        }
        // 验证是否为有效 UTF-8
        if (!content.includes('\uFFFD')) {
          return content.split(/\r?\n/);
        }
      } else {
        content = iconv.decode(buffer, enc);
        if (content && !content.includes('\uFFFD')) {
          return content.split(/\r?\n/);
        }
      }
    } catch {
      continue;
    }
  }

  // 兜底：latin-1
  return iconv.decode(buffer, 'latin-1').split(/\r?\n/);
}

/**
 * 转义正则特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
