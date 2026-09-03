import path from 'path';
import { executeTool } from './tools/agent-tools.js';

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_RESULTS = 40;
const DEFAULT_TOP_FILES = 10;

export async function validateKnowledgeCandidate(candidate = {}, options = {}) {
  const roots = normalizeRoots(options.roots || options.root || options.diskRoots || options.diskRoot);
  if (roots.length === 0) {
    return validationResult(candidate, {
      status: 'invalid',
      confidence: 0,
      reason: 'roots is required',
      files: [],
      evidence: [],
      checked: {}
    });
  }

  const fileSearch = await findCandidateFiles(candidate, roots, options);
  const rankedFiles = rankFiles(fileSearch.files || [], candidate).slice(0, Number(options.topFiles || DEFAULT_TOP_FILES));

  if (rankedFiles.length === 0) {
    return validationResult(candidate, {
      status: 'no_files',
      confidence: reduceConfidence(candidate.confidence, 35),
      reason: '没有找到候选规则指向的文件',
      files: [],
      evidence: [],
      checked: fileSearch.checked || {}
    });
  }

  const evidence = [];
  const errors = [];

  for (const file of rankedFiles) {
    try {
      const fileEvidence = await validateFileWithCandidate(file.path, candidate, options);
      evidence.push(...fileEvidence);
    } catch (error) {
      errors.push({ file: file.path, error: error.message });
    }
    if (evidence.length >= Number(options.maxEvidence || 20)) break;
  }

  const status = evidence.length > 0 ? 'verified' : 'file_only';
  const confidence = evidence.length > 0
    ? improveConfidence(candidate.confidence, Math.min(30, evidence.length * 8))
    : reduceConfidence(candidate.confidence, 15);

  return validationResult(candidate, {
    status,
    confidence,
    reason: evidence.length > 0 ? '候选规则已找到文件证据' : '找到候选文件，但未命中选择器或关键字',
    files: rankedFiles,
    evidence,
    checked: fileSearch.checked || {},
    errors
  });
}

export async function validateKnowledgeCandidates(candidates = [], options = {}) {
  const results = [];
  for (const candidate of candidates) {
    results.push(await validateKnowledgeCandidate(candidate, options));
  }
  return results;
}

async function findCandidateFiles(candidate, roots, options) {
  const patterns = buildSearchPatterns(candidate);
  const extensions = buildExtensions(candidate);
  const args = {
    roots,
    patterns: patterns.length ? patterns : undefined,
    extensions: extensions.length ? extensions : undefined,
    maxFiles: Number(options.maxFiles || DEFAULT_MAX_FILES),
    maxResults: Number(options.maxResults || DEFAULT_MAX_RESULTS)
  };

  return executeTool('search_files', args);
}

async function validateFileWithCandidate(filePath, candidate, options) {
  const evidence = [];
  const parserType = String(candidate.parserType || '').toLowerCase();
  const ruleType = String(candidate.ruleType || '').toLowerCase();
  const operation = String(candidate.operation || '').toLowerCase();
  const keywords = normalizeList(candidate.keywords);

  if ((parserType === 'xml' || ruleType === 'xml_selector') && candidate.selector) {
    const parsed = await executeTool('parse_xml', {
      file: filePath,
      selector: candidate.selector,
      maxEvidenceLength: Number(options.maxEvidenceLength || 500)
    });
    for (const match of parsed.matches || []) {
      evidence.push({
        type: 'xml_selector',
        file: filePath,
        selector: match.selector,
        value: match.value,
        line: '',
        evidence: match.evidence
      });
    }
  }

  if (operation === 'count_rows' || ruleType === 'row_count') {
    const counted = await executeTool('count_rows', { file: filePath, nonEmptyOnly: true });
    if (counted.success) {
      evidence.push({
        type: 'row_count',
        file: filePath,
        value: counted.rows,
        line: '',
        evidence: `non-empty rows: ${counted.rows}`
      });
    }
  }

  if (operation === 'first_last_rows' || ruleType === 'first_last_rows') {
    const rows = await executeTool('first_last_rows', {
      file: filePath,
      first: 1,
      last: 1,
      maxLineLength: Number(options.maxLineLength || 500)
    });
    for (const row of [...(rows.first || []), ...(rows.last || [])]) {
      evidence.push({
        type: 'first_last_rows',
        file: filePath,
        value: '',
        lineNumber: row.lineNumber,
        line: row.line,
        evidence: row.line
      });
    }
  }

  if (operation === 'check_presence' || ruleType === 'file_presence') {
    evidence.push({
      type: 'file_presence',
      file: filePath,
      value: true,
      line: '',
      evidence: path.basename(filePath)
    });
  }

  for (const keyword of keywords) {
    const matched = await executeTool('search_text', {
      file: filePath,
      query: keyword,
      maxMatches: Number(options.maxMatchesPerKeyword || 5),
      maxLineLength: Number(options.maxLineLength || 500)
    });
    for (const match of matched.matches || []) {
      evidence.push({
        type: 'text_keyword',
        file: filePath,
        keyword,
        value: '',
        lineNumber: match.lineNumber,
        line: match.line,
        evidence: match.line
      });
    }
  }

  return evidence;
}

function buildSearchPatterns(candidate) {
  const values = [
    ...normalizeList(candidate.fileNamePatterns || candidate.file_name_patterns),
    ...normalizeList(candidate.filePatterns || candidate.file_patterns)
  ];
  return unique(values).slice(0, 30);
}

function buildExtensions(candidate) {
  const values = [
    ...normalizeList(candidate.fileNamePatterns || candidate.file_name_patterns),
    ...normalizeList(candidate.filePatterns || candidate.file_patterns)
  ];
  return unique(values.map(value => {
    const clean = String(value || '').toLowerCase().replace(/\.gz$/i, '');
    return path.extname(clean);
  }).filter(Boolean));
}

function rankFiles(files, candidate) {
  const namePatterns = normalizeList(candidate.fileNamePatterns || candidate.file_name_patterns);
  const pathPatterns = normalizeList(candidate.filePatterns || candidate.file_patterns);

  return [...files]
    .map(file => ({
      ...file,
      rankScore: scoreFile(file, namePatterns, pathPatterns)
    }))
    .sort((a, b) => b.rankScore - a.rankScore || a.size - b.size);
}

function scoreFile(file, namePatterns, pathPatterns) {
  const filePath = String(file.path || '').replace(/\\/g, '/').toLowerCase();
  const name = String(file.name || path.basename(filePath)).toLowerCase();
  let score = 0;

  for (const pattern of namePatterns) {
    const normalized = String(pattern || '').replace(/\\/g, '/').toLowerCase();
    if (!normalized) continue;
    if (matchesPattern(name, normalized)) score += 60;
    else if (filePath.includes(normalized.replaceAll('*', ''))) score += 25;
  }

  for (const pattern of pathPatterns) {
    const normalized = String(pattern || '').replace(/\\/g, '/').toLowerCase();
    if (!normalized) continue;
    if (matchesPattern(filePath, normalized)) score += 40;
    else if (filePath.includes(normalized.replaceAll('*', ''))) score += 20;
  }

  if (file.isGzip) score += 5;
  return score;
}

function matchesPattern(value, pattern) {
  if (pattern.includes('*') || pattern.includes('?')) {
    const source = escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
    return new RegExp(source, 'i').test(value);
  }
  return value.includes(pattern);
}

function validationResult(candidate, result) {
  return {
    candidateId: candidate.id || null,
    rawExperienceId: candidate.rawExperienceId || null,
    indicatorName: candidate.indicatorName || '',
    indicatorCode: candidate.indicatorCode || '',
    ruleType: candidate.ruleType || 'unknown',
    parserType: candidate.parserType || '',
    status: result.status,
    confidence: result.confidence,
    reason: result.reason,
    files: result.files || [],
    evidence: result.evidence || [],
    checked: result.checked || {},
    errors: result.errors || []
  };
}

function normalizeRoots(value) {
  return normalizeList(value).map(root => {
    const text = String(root || '').trim();
    return /^[a-z]:$/i.test(text) ? `${text}\\` : text;
  });
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(/\r?\n|;|；|,/).map(item => item.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function improveConfidence(value, amount) {
  return clamp(Number(value || 0) + amount, 0, 100);
}

function reduceConfidence(value, amount) {
  return clamp(Number(value || 0) - amount, 0, 100);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
