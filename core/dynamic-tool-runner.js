import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const FORBIDDEN_PATTERNS = [
  /\bwriteFile(?:Sync)?\b/,
  /\bappendFile(?:Sync)?\b/,
  /\bunlink(?:Sync)?\b/,
  /\brm(?:Sync)?\b/,
  /\brmdir(?:Sync)?\b/,
  /\brename(?:Sync)?\b/,
  /\bchmod(?:Sync)?\b/,
  /\bchown(?:Sync)?\b/,
  /\btruncate(?:Sync)?\b/,
  /\bexec(?:File|Sync)?\b/,
  /\bspawn(?:Sync)?\b/,
  /\bprocess\.kill\b/,
  /\bfetch\s*\(/,
  /\bhttps?\b/
];

export async function executeGeneratedTool(tool = {}, context = {}) {
  const code = String(tool.code || tool.sourceCode || '').trim();
  if (!code) return failure('生成工具没有代码');
  if (code.length > Number(context.maxCodeChars || 30000)) return failure('生成工具代码过长');

  const violation = FORBIDDEN_PATTERNS.find(pattern => pattern.test(code));
  if (violation) return failure(`生成工具包含非只读能力：${violation}`);

  const roots = normalizeRoots(context.roots || []);
  if (!roots.length) return failure('没有允许访问的根目录');

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-tool-'));
  const inputPath = path.join(runDir, 'input.json');
  const scriptPath = path.join(runDir, 'tool.mjs');
  const input = {
    roots,
    args: tool.args || {},
    limits: {
      maxFiles: clamp(tool.args?.maxFiles, 1, 20000, 5000),
      maxReadBytes: clamp(tool.args?.maxReadBytes, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024),
      maxResults: clamp(tool.args?.maxResults, 1, 500, 100)
    }
  };

  const wrapper = `
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';
const context = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const startedAt = Date.now();
async function generatedTool(context) {
${code}
}
try {
  context.reportProgress = progress => process.stdout.write('\\n@@AGENT_PROGRESS@@' + JSON.stringify(progress || {}) + '\\n');
  const result = await generatedTool(context);
  process.stdout.write('@@AGENT_RESULT@@' + JSON.stringify({ success: true, result, durationMs: Date.now() - startedAt }));
} catch (error) {
  process.stdout.write('@@AGENT_RESULT@@' + JSON.stringify({ success: false, error: error.message, durationMs: Date.now() - startedAt }));
  process.exitCode = 1;
}
`;

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');
  fs.writeFileSync(scriptPath, wrapper, 'utf8');

  try {
    return await runNodeTool(scriptPath, inputPath, {
      idleTimeoutMs: clamp(context.idleTimeoutMs, 10000, 10 * 60 * 1000, 3 * 60 * 1000),
      hardTimeoutMs: clamp(context.hardTimeoutMs, 60000, 30 * 60 * 1000, 15 * 60 * 1000),
      maxOutputChars: clamp(context.maxOutputChars, 1000, 100000, 30000),
      signal: context.signal,
      onProgress: context.onProgress
    });
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function runNodeTool(scriptPath, inputPath, options) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [scriptPath, inputPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const stop = reason => {
      child.kill();
      finish(failure(reason));
    };
    const abort = () => stop('生成工具执行已停止');
    let idleTimer;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop('生成工具长时间没有报告扫描进度'), options.idleTimeoutMs);
    };
    resetIdleTimer();
    const hardTimer = setTimeout(() => stop('生成工具达到单次执行安全上限'), options.hardTimeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8');
      const progressMatches = [...text.matchAll(/@@AGENT_PROGRESS@@([^\r\n]+)/g)];
      for (const match of progressMatches) {
        resetIdleTimer();
        try { options.onProgress?.(JSON.parse(match[1])); } catch {}
      }
      stdout += text.replace(/@@AGENT_PROGRESS@@[^\r\n]+[\r\n]*/g, '');
      if (stdout.length > options.maxOutputChars) stop('生成工具输出超过限制');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on('error', error => finish(failure(error.message)));
    child.on('close', () => {
      if (settled) return;
      const marker = '@@AGENT_RESULT@@';
      const position = stdout.lastIndexOf(marker);
      if (position < 0) return finish(failure(stderr || '生成工具没有返回结构化结果'));
      try {
        finish(JSON.parse(stdout.slice(position + marker.length)));
      } catch {
        finish(failure('生成工具返回了无效 JSON'));
      }
    });
  });
}

function normalizeRoots(roots) {
  return roots.map(root => path.resolve(String(root || '').trim())).filter(Boolean);
}

function failure(error) {
  return { success: false, error, durationMs: 0 };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}
