const DEFAULT_TIMEOUT = 120000;

export async function callAI(prompt, options = {}) {
  const runtime = resolveRuntimeConfig(options);
  const controller = linkedController(options.signal);
  const timer = setTimeout(() => controller.abort(), runtime.timeout);
  try {
    const response = await requestCompletion(prompt, runtime, options, false, controller.signal);
    if (!response.ok) throw await responseError(response);
    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    const content = normalizeContent(message.content);
    return { content, response: content, reasoning: normalizeContent(message.reasoning_content), raw: data, backend: 'api', provider: 'api', model: runtime.model };
  } catch (error) {
    throw normalizeRequestError(error, options.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function callAIStream(prompt, options = {}, onToken = () => {}) {
  const runtime = resolveRuntimeConfig(options);
  const controller = linkedController(options.signal);
  let timer;
  let idleTimeout = false;
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { idleTimeout = true; controller.abort(); }, runtime.timeout);
  };
  resetTimer();
  try {
    const response = await requestCompletion(prompt, runtime, options, true, controller.signal);
    if (!response.ok) throw await responseError(response);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      const reasoning = normalizeContent(message.reasoning_content);
      const content = normalizeContent(message.content);
      if (reasoning) onToken(reasoning, { type: 'reasoning' });
      if (content) onToken(content, { type: 'content' });
      return { content, response: content, reasoning, raw: data, streamed: false, backend: 'api', provider: 'api', model: runtime.model };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning = '';
    for await (const chunk of response.body) {
      resetTimer();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let data;
        try { data = JSON.parse(payload); } catch { continue; }
        const delta = data.choices?.[0]?.delta || {};
        const reasoningToken = normalizeContent(delta.reasoning_content || delta.reasoning);
        const contentToken = normalizeContent(delta.content);
        if (reasoningToken) { reasoning += reasoningToken; onToken(reasoningToken, { type: 'reasoning' }); }
        if (contentToken) { content += contentToken; onToken(contentToken, { type: 'content' }); }
      }
    }
    return { content, response: content, reasoning, streamed: true, backend: 'api', provider: 'api', model: runtime.model };
  } catch (error) {
    if (error.name === 'AbortError' && idleTimeout && !options.signal?.aborted) throw new Error('外部 API 长时间没有返回新内容，请稍后重试');
    throw normalizeRequestError(error, options.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function extractJSON(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === open) depth++;
      else if (char === close && --depth === 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  return null;
}

export async function checkAIService(_backend = 'api', options = {}) {
  try {
    const result = await testAIConnection(options);
    return { available: true, backend: 'api', local: false, model: result.model, latencyMs: result.latencyMs };
  } catch (error) {
    return { available: false, backend: 'api', local: false, error: error.message };
  }
}

export function getAvailableBackends() {
  return [{ id: 'api', name: '外部 API', local: false, requiresApiKey: true }];
}

export async function testAIConnection(options = {}) {
  const runtime = resolveRuntimeConfig(options);
  const startedAt = Date.now();
  const result = await callAIStream('只回复 OK', { ...options, baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, model: runtime.model, temperature: 0, maxTokens: 16, outputMode: 'auto', formatJson: false });
  return { success: true, provider: 'api', backend: 'api', model: runtime.model, baseUrl: runtime.baseUrl, protocol: 'openai-chat-completions', streaming: result.streamed === true, latencyMs: Date.now() - startedAt, message: result.content || '连接成功' };
}

export function normalizeAIOptions(options = {}) {
  const runtime = resolveRuntimeConfig(options);
  return { provider: 'api', backend: 'api', baseUrl: runtime.baseUrl, model: runtime.model, hasApiKey: !!runtime.apiKey, local: false, timeout: runtime.timeout, outputMode: runtime.outputMode, protocol: 'openai-chat-completions' };
}

function resolveRuntimeConfig(options = {}) {
  const baseUrl = trimTrailingSlash(options.baseUrl || options.url || process.env.AI_BASE_URL || 'https://api.deepseek.com');
  const model = String(options.model || options.aiModel || process.env.AI_MODEL || 'deepseek-chat').trim();
  const apiKey = String(options.apiKey || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!baseUrl) throw new Error('API URL 不能为空');
  if (!model) throw new Error('模型名称不能为空');
  if (!apiKey) throw new Error('请填写 API Key');
  return { baseUrl, chatUrl: chatCompletionsUrl(baseUrl), model, apiKey, timeout: Math.max(10000, Number(options.timeout || DEFAULT_TIMEOUT)), outputMode: options.outputMode || 'auto' };
}

function buildRequest(prompt, runtime, options, stream) {
  return {
    model: runtime.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 2048,
    stream,
    ...(runtime.outputMode === 'strict_json' || options.formatJson === true ? { response_format: { type: 'json_object' } } : {})
  };
}

async function requestCompletion(prompt, runtime, options, stream, signal) {
  const request = buildRequest(prompt, runtime, options, stream);
  let response = await fetch(runtime.chatUrl, {
    method: 'POST', headers: apiHeaders(runtime), body: JSON.stringify(request), signal
  });
  if (!response.ok && request.response_format && [400, 404, 422].includes(response.status)) {
    delete request.response_format;
    response = await fetch(runtime.chatUrl, {
      method: 'POST', headers: apiHeaders(runtime), body: JSON.stringify(request), signal
    });
  }
  return response;
}

function apiHeaders(runtime) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.apiKey}` };
}

function chatCompletionsUrl(baseUrl) {
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  return /\/v1$/i.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
}

async function responseError(response) {
  const text = await response.text();
  let detail = text;
  try { const parsed = JSON.parse(text); detail = parsed.error?.message || parsed.message || text; } catch {}
  return new Error(`外部 API 请求失败 (${response.status})：${String(detail).slice(0, 1000)}`);
}

function linkedController(signal) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

function normalizeRequestError(error, callerSignal) {
  if (error.name !== 'AbortError') return error;
  return new Error(callerSignal?.aborted ? '外部 API 调用已停止' : '外部 API 请求超时');
}

function normalizeContent(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(item => typeof item === 'string' ? item : item?.text || '').join('');
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}
