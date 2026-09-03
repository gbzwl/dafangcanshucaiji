import fs from 'fs';
import path from 'path';
import readline from 'readline';
import zlib from 'zlib';
import iconv from 'iconv-lite';

const TEXT_EXTENSIONS = new Set([
  '.log', '.txt', '.xml', '.csv', '.tsv', '.ini', '.cfg', '.conf',
  '.htm', '.html', '.mrs', '.json', '.gz'
]);

const DEFAULT_EXCLUDE_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'windows',
  'program files', 'program files (x86)', 'programdata',
  'node_modules', '.git', '__pycache__', '.cache',
  'appdata', 'perflogs', 'msocache', 'intel'
]);

const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_READ_LINES = 120;
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const YIELD_EVERY = 100;

const waitForYield = () => new Promise(resolve => setImmediate(resolve));

export const toolRegistry = {
  search_files: searchFiles,
  get_file_meta: getFileMeta,
  read_head: readHead,
  read_tail: readTail,
  read_sample: readSample,
  search_text: searchText,
  parse_xml: parseXml,
  count_rows: countRows,
  first_last_rows: firstLastRows,
  gunzip_preview: gunzipPreview
};

export function listTools() {
  return Object.keys(toolRegistry).map(name => ({
    name,
    description: getToolDescription(name)
  }));
}

export async function executeTool(name, args = {}) {
  const tool = toolRegistry[name];
  if (!tool) {
    return { success: false, error: `Unknown tool: ${name}` };
  }

  try {
    return await tool(args);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function searchFiles(args = {}) {
  const roots = normalizeRoots(args.roots || args.root || args.diskRoots || args.diskRoot);
  const patterns = normalizeList(args.patterns || args.pattern || args.query);
  const extensions = normalizeExtensions(args.extensions || args.exts);
  const maxResults = Number(args.maxResults || DEFAULT_MAX_RESULTS);
  const results = [];
  const checked = { dirs: 0, files: 0 };

  for (const root of roots) {
    await walkFiles(root, async filePath => {
      checked.files++;
      const ext = path.extname(stripGzipExt(filePath)).toLowerCase() || path.extname(filePath).toLowerCase();
      if (extensions.length && !extensions.includes(ext)) return;
      if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && !TEXT_EXTENSIONS.has(ext)) return;
      if (patterns.length && !patterns.some(pattern => matchPattern(filePath, pattern))) return;
      results.push(fileMeta(filePath));
    }, {
      maxFiles: Number(args.maxFiles || 100000),
      shouldStop: () => results.length >= maxResults,
      checked
    });
    if (results.length >= maxResults) break;
  }

  return {
    success: true,
    files: results.slice(0, maxResults),
    count: Math.min(results.length, maxResults),
    checked
  };
}

async function getFileMeta(args = {}) {
  const file = requireFile(args.file || args.path);
  return { success: true, file: fileMeta(file) };
}

async function readHead(args = {}) {
  const file = requireFile(args.file || args.path);
  const lines = Number(args.lines || DEFAULT_READ_LINES);
  const text = await readTextHead(file, lines);
  return { success: true, file, lines: text.split(/\r?\n/).slice(0, lines), text };
}

async function readTail(args = {}) {
  const file = requireFile(args.file || args.path);
  const lines = Number(args.lines || DEFAULT_READ_LINES);
  const text = readTextTail(file, lines, Number(args.maxBytes || DEFAULT_TAIL_BYTES));
  return { success: true, file, lines: text.split(/\r?\n/).filter(Boolean).slice(-lines), text };
}

async function readSample(args = {}) {
  const file = requireFile(args.file || args.path);
  const headLines = Number(args.headLines || 60);
  const tailLines = Number(args.tailLines || 60);
  const head = await readTextHead(file, headLines);
  const tail = readTextTail(file, tailLines, Number(args.maxBytes || DEFAULT_TAIL_BYTES));
  return {
    success: true,
    file,
    head: head.split(/\r?\n/).slice(0, headLines),
    tail: tail.split(/\r?\n/).filter(Boolean).slice(-tailLines)
  };
}

async function searchText(args = {}) {
  const file = requireFile(args.file || args.path);
  const query = String(args.query || args.keyword || args.regex || '');
  if (!query) return { success: false, error: 'query is required' };

  const maxMatches = Number(args.maxMatches || 50);
  const regex = args.regex
    ? new RegExp(query, args.flags || 'i')
    : new RegExp(escapeRegex(query), args.flags || 'i');
  const matches = [];

  await eachTextLine(file, async (line, lineNumber) => {
    if (regex.test(line)) {
      matches.push({ lineNumber, line: truncate(line.trim(), Number(args.maxLineLength || 500)) });
    }
    return matches.length < maxMatches;
  });

  return { success: true, file, query, matches, count: matches.length };
}

async function parseXml(args = {}) {
  const file = requireFile(args.file || args.path);
  const selector = String(args.selector || args.pathSelector || args.tag || '').trim();
  if (!selector) return { success: false, error: 'selector is required' };

  const text = readWholeTextSafe(file, Number(args.maxBytes || 64 * 1024 * 1024));
  const selectors = selector.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const matches = [];

  for (const item of selectors) {
    const parts = item.split(/[./>]+/).map(s => s.trim()).filter(Boolean);
    const values = parts.length === 1 ? findXmlTagValues(text, parts[0]) : findXmlPathValues(text, parts);
    for (const value of values) {
      matches.push({
        selector: item,
        value: value.value,
        evidence: truncate(value.evidence, Number(args.maxEvidenceLength || 500))
      });
    }
  }

  return { success: true, file, selector, matches, count: matches.length };
}

async function countRows(args = {}) {
  const file = requireFile(args.file || args.path);
  let rows = 0;
  await eachTextLine(file, async line => {
    if (args.nonEmptyOnly && !line.trim()) return true;
    rows++;
    return true;
  });
  return { success: true, file, rows };
}

async function firstLastRows(args = {}) {
  const file = requireFile(args.file || args.path);
  const firstCount = Number(args.first || args.firstLines || 1);
  const lastCount = Number(args.last || args.lastLines || 1);
  const first = [];
  const last = [];

  await eachTextLine(file, async (line, lineNumber) => {
    const row = { lineNumber, line: truncate(line, Number(args.maxLineLength || 800)) };
    if (first.length < firstCount) first.push(row);
    last.push(row);
    if (last.length > lastCount) last.shift();
    return true;
  });

  return { success: true, file, first, last };
}

async function gunzipPreview(args = {}) {
  const file = requireFile(args.file || args.path);
  const maxBytes = Number(args.maxBytes || 512 * 1024);
  const buffer = await readGzipPrefix(file, maxBytes);
  const text = decodeBuffer(buffer);
  const lines = text.split(/\r?\n/).slice(0, Number(args.lines || DEFAULT_READ_LINES));
  return { success: true, file, lines, text: lines.join('\n') };
}

async function walkFiles(root, onFile, options = {}) {
  const stack = [normalizeRoot(root)];
  const visited = new Set();

  while (stack.length) {
    if (options.shouldStop?.()) return;
    const dir = stack.pop();
    if (!dir || visited.has(dir)) continue;
    visited.add(dir);
    options.checked.dirs++;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDE_DIRS.has(lowerName)) stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      await onFile(fullPath);
      if (options.checked.files % YIELD_EVERY === 0) await waitForYield();
      if (options.shouldStop?.()) return;
      if (options.maxFiles && options.checked.files >= options.maxFiles) return;
    }
  }
}

async function readTextHead(file, lineLimit) {
  const lines = [];
  await eachTextLine(file, async line => {
    lines.push(line);
    return lines.length < lineLimit;
  });
  return lines.join('\n');
}

function readTextTail(file, lineLimit, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return decodeBuffer(buffer).split(/\r?\n/).slice(-lineLimit).join('\n');
  } finally {
    fs.closeSync(fd);
  }
}

async function eachTextLine(file, onLine) {
  if (file.toLowerCase().endsWith('.gz')) {
    const stream = fs.createReadStream(file).pipe(zlib.createGunzip());
    return eachStreamLine(stream, onLine);
  }
  return eachStreamLine(fs.createReadStream(file), onLine);
}

async function eachStreamLine(stream, onLine) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const chunk of rl) {
    lineNumber++;
    const keepGoing = await onLine(String(chunk), lineNumber);
    if (!keepGoing) {
      rl.close();
      stream.destroy();
      break;
    }
  }
}

function readWholeTextSafe(file, maxBytes) {
  if (file.toLowerCase().endsWith('.gz')) {
    const data = zlib.gunzipSync(fs.readFileSync(file));
    return decodeBuffer(data.subarray(0, maxBytes));
  }

  const stat = fs.statSync(file);
  const bytes = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    return decodeBuffer(buffer);
  } finally {
    fs.closeSync(fd);
  }
}

function findXmlPathValues(text, parts) {
  if (parts.length === 0) return [];
  const [head, ...rest] = parts;
  const escaped = escapeRegex(head);
  const tagRegex = new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const matches = [];
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const evidence = match[0];
    const inner = match[2] || '';
    if (rest.length === 0) {
      matches.push({ value: inner.replace(/<[^>]+>/g, '').trim(), evidence });
    } else {
      matches.push(...findXmlPathValues(inner, rest));
    }
  }

  return matches;
}

function findXmlTagValues(text, tagName) {
  const escaped = escapeRegex(tagName);
  const tagRegex = new RegExp(`<${escaped}(\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi');
  const matches = [];
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const evidence = match[0];
    const inner = match[2] || '';
    matches.push({
      value: inner.replace(/<[^>]+>/g, '').trim(),
      evidence
    });
    if (matches.length >= 50) break;
  }
  return matches;
}

function fileMeta(filePath) {
  const stat = fs.statSync(filePath);
  const parsed = path.parse(filePath);
  return {
    path: filePath,
    name: parsed.base,
    ext: path.extname(stripGzipExt(filePath)).toLowerCase() || parsed.ext.toLowerCase(),
    size: stat.size,
    sizeMB: Math.round((stat.size / 1024 / 1024) * 100) / 100,
    modifiedTime: stat.mtime.toISOString(),
    createdTime: stat.birthtime.toISOString(),
    pathFragment: stripDrive(path.dirname(filePath)),
    isGzip: filePath.toLowerCase().endsWith('.gz')
  };
}

function requireFile(file) {
  const value = String(file || '').trim();
  if (!value) throw new Error('file is required');
  if (!fs.existsSync(value)) throw new Error(`file not found: ${value}`);
  const stat = fs.statSync(value);
  if (!stat.isFile()) throw new Error(`not a file: ${value}`);
  return value;
}

function normalizeRoots(value) {
  const roots = normalizeList(value).map(normalizeRoot);
  if (roots.length === 0) throw new Error('root/roots is required');
  return roots;
}

function normalizeRoot(root) {
  const value = String(root || '').trim();
  if (/^[a-z]:$/i.test(value)) return `${value}\\`;
  return value;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || '').trim()).filter(Boolean);
  return String(value || '').split(/[,\n;]/).map(v => v.trim()).filter(Boolean);
}

function normalizeExtensions(value) {
  return normalizeList(value).map(ext => ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`);
}

function matchPattern(filePath, pattern) {
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/').toLowerCase();
  if (!normalizedPattern) return true;
  if (normalizedPattern.includes('*') || normalizedPattern.includes('?')) {
    return globToRegex(normalizedPattern).test(normalizedPath)
      || globToRegex(path.posix.basename(normalizedPattern)).test(path.basename(normalizedPath));
  }
  return normalizedPath.includes(normalizedPattern);
}

function globToRegex(pattern) {
  const source = escapeRegex(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp(source, 'i');
}

function stripDrive(filePath) {
  return String(filePath || '').replace(/^[a-z]:[\\/]/i, '').replace(/\\/g, '/');
}

function stripGzipExt(filePath) {
  return filePath.toLowerCase().endsWith('.gz') ? filePath.slice(0, -3) : filePath;
}

function decodeBuffer(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return iconv.decode(buffer, 'latin1');
}

function truncate(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getToolDescription(name) {
  const descriptions = {
    search_files: 'Search files by roots, path/name patterns and extensions.',
    get_file_meta: 'Return file size, times, extension and normalized path fragment.',
    read_head: 'Read the first N text lines.',
    read_tail: 'Read the last N text lines with large-file protection.',
    read_sample: 'Read head and tail samples.',
    search_text: 'Search literal text or regex inside a text/gzip file.',
    parse_xml: 'Extract values from an XML path selector such as A.B.C.',
    count_rows: 'Count text rows without loading the whole file.',
    first_last_rows: 'Return first and last rows from a text file.',
    gunzip_preview: 'Read a limited preview from a gzip text file.'
  };
  return descriptions[name] || '';
}

async function readGzipPrefix(file, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const input = fs.createReadStream(file);
    const gunzip = zlib.createGunzip();

    gunzip.on('data', chunk => {
      if (total >= maxBytes) return;
      const remaining = maxBytes - total;
      const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(piece);
      total += piece.length;
      if (total >= maxBytes) {
        input.destroy();
        gunzip.destroy();
        resolve(Buffer.concat(chunks));
      }
    });
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    input.on('error', reject);
    input.pipe(gunzip);
  });
}
