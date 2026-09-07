/**
 * AI 服务层 - 统一的 AI 模型调用接口
 * 支持 Ollama（本地）和 DeepSeek API
 * 数据不上传云端（使用 Ollama 时）
 */

const AI_BACKENDS = {
  ollama: {
    url: process.env.OLLAMA_URL || 'http://localhost:11434',
    defaultModel: process.env.OLLAMA_MODEL || 'deepseek-r1:7b',
    timeout: 120000,
    local: true
  },
  deepseek: {
    url: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    timeout: 60000,
    local: false,
    requiresApiKey: true
  },
  openai: {
    url: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    timeout: 60000,
    local: false,
    requiresApiKey: true
  },
  custom: {
    url: '',
    model: '',
    timeout: 60000,
    local: false,
    requiresApiKey: false
  }
};

/**
 * 调用 AI 模型
 * @param {string} prompt - 提示词
 * @param {object} options - 选项
 * @returns {Promise<object>} AI 响应
 */
export async function callAI(prompt, options = {}) {
  const runtime = resolveRuntimeConfig(options);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), runtime.timeout);

  try {
    let response;

    if (runtime.provider === 'ollama') {
      response = await fetch(`${runtime.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: runtime.model,
          prompt: prompt,
          stream: false,
          format: 'json',
          options: {
            temperature: options.temperature ?? 0.3,
            num_predict: options.maxTokens ?? 2048
          }
        }),
        signal: controller.signal
      });
    } else {
      response = await fetch(getChatCompletionsUrl(runtime.baseUrl), {
        method: 'POST',
        headers: getApiHeaders(runtime),
        body: JSON.stringify({
          model: runtime.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 2048,
          ...(runtime.responseFormatJson ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI 请求失败 (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // 解析响应内容
    let content = '';
    if (runtime.provider === 'ollama') {
      content = data.response || '';
    } else {
      content = data.choices?.[0]?.message?.content || '';
    }

    return {
      content,
      response: content,
      raw: data,
      backend: runtime.backend,
      provider: runtime.provider,
      model: runtime.model
    };

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('AI 请求超时，请检查模型是否正在运行');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 流式调用 AI 模型，onToken 会收到模型实时输出片段。
 */
export async function callAIStream(prompt, options = {}, onToken = () => {}) {
  const runtime = resolveRuntimeConfig(options);

  const controller = new AbortController();
  let timedOutByIdle = false;
  let timeoutId = null;
  const resetIdleTimeout = () => {
    if (!options.timeout) return;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOutByIdle = true;
      controller.abort();
    }, options.timeout);
  };
  resetIdleTimeout();
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    options.signal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    let response;

    if (runtime.provider === 'ollama') {
      response = await fetch(`${runtime.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: runtime.model,
          prompt,
          stream: true,
          ...(options.formatJson === false ? {} : { format: 'json' }),
          options: {
            temperature: options.temperature ?? 0.3,
            num_predict: options.maxTokens ?? 2048
          }
        }),
        signal: controller.signal
      });
    } else {
      response = await fetch(getChatCompletionsUrl(runtime.baseUrl), {
        method: 'POST',
        headers: getApiHeaders(runtime),
        body: JSON.stringify({
          model: runtime.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 2048,
          stream: true,
          ...(runtime.responseFormatJson ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: controller.signal
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI 请求失败 (${response.status}): ${errorText}`);
    }

    const decoder = new TextDecoder();
    let content = '';
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let token = '';
        if (runtime.provider === 'ollama') {
          const data = JSON.parse(line);
          token = data.response || '';
        } else {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          const data = JSON.parse(payload);
          token = data.choices?.[0]?.delta?.content || '';
        }

        if (token) {
          content += token;
          resetIdleTimeout();
          onToken(token);
        }
      }
    }

    return {
      content,
      response: content,
      backend: runtime.backend,
      provider: runtime.provider,
      model: runtime.model
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      if (timedOutByIdle) {
        throw new Error('AI 长时间没有新输出，已判断为卡住并跳到下一项');
      }
      if (options.signal?.aborted) {
        throw new Error('AI 补全已停止');
      }
      throw new Error('AI 请求超时，请检查模型是否正在运行');
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortFromCaller);
    }
  }
}

/**
 * 从 AI 响应中提取 JSON
 * @param {string} content - AI 响应文本
 * @returns {object|null} 解析后的 JSON 对象
 */
export function extractJSON(content) {
  // 尝试直接解析
  try {
    return JSON.parse(content);
  } catch {
    // 尝试从 markdown 代码块中提取
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        // 继续尝试其他方法
      }
    }

    // 尝试找到第一个 { 和最后一个 } 之间的内容
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(content.substring(start, end + 1));
      } catch {
        // 解析失败
      }
    }

    return null;
  }
}

/**
 * 检查 AI 服务是否可用
 * @param {string} backend - 后端类型
 * @returns {Promise<object>} 服务状态
 */
export async function checkAIService(backend = 'ollama', options = {}) {
  const config = AI_BACKENDS[backend] || AI_BACKENDS.custom;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    if (backend === 'ollama') {
      const response = await fetch(`${options.baseUrl || config.url}/api/tags`, {
        signal: controller.signal
      });

      if (response.ok) {
        const data = await response.json();
        const models = data.models?.map(m => m.name) || [];
        return {
          available: true,
          backend,
          models,
          defaultModel: config.defaultModel,
          local: true
        };
      }
    } else {
      return {
        available: !!(options.apiKey || getEnvApiKey(backend)),
        backend,
        local: false,
        message: (options.apiKey || getEnvApiKey(backend)) ? 'API Key 已配置' : '需要配置 API Key'
      };
    }

    clearTimeout(timeoutId);
  } catch (error) {
    return {
      available: false,
      backend,
      error: error.message,
      local: config.local
    };
  }

  return { available: false, backend, error: '服务未响应' };
}

/**
 * 获取可用的 AI 后端列表
 */
export function getAvailableBackends() {
  return Object.entries(AI_BACKENDS).map(([key, config]) => ({
    id: key,
    name: getBackendName(key),
    local: config.local,
    defaultModel: config.defaultModel || config.model,
    requiresApiKey: config.requiresApiKey || false
  }));
}

export async function testAIConnection(options = {}) {
  const runtime = resolveRuntimeConfig({ ...options, maxTokens: options.maxTokens || 24 });
  if (runtime.provider === 'ollama') {
    const status = await checkAIService('ollama', { baseUrl: runtime.baseUrl });
    const models = status.models || [];
    if (!status.available) {
      return {
        success: false,
        provider: runtime.provider,
        backend: runtime.backend,
        model: runtime.model,
        baseUrl: runtime.baseUrl,
        message: status.error || 'Ollama 不可用',
        models
      };
    }
    if (!runtime.model) {
      return {
        success: false,
        provider: runtime.provider,
        backend: runtime.backend,
        model: runtime.model,
        baseUrl: runtime.baseUrl,
        message: '请填写 Ollama 本地模型名称',
        models
      };
    }
    if (models.length && !models.includes(runtime.model)) {
      return {
        success: false,
        provider: runtime.provider,
        backend: runtime.backend,
        model: runtime.model,
        baseUrl: runtime.baseUrl,
        message: `Ollama 未安装模型 ${runtime.model}`,
        models
      };
    }
    return {
      success: true,
      provider: runtime.provider,
      backend: runtime.backend,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      message: 'Ollama 连接成功',
      models
    };
  }

  const startedAt = Date.now();
  const result = await callAI('只回复 OK', {
    ...options,
    provider: runtime.provider,
    backend: runtime.backend,
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    temperature: 0,
    maxTokens: 16
  });

  return {
    success: true,
    provider: runtime.provider,
    backend: runtime.backend,
    model: runtime.model,
    baseUrl: runtime.baseUrl,
    latencyMs: Date.now() - startedAt,
    message: result.content || '连接成功'
  };
}

export function normalizeAIOptions(options = {}) {
  const runtime = resolveRuntimeConfig(options);
  return {
    provider: runtime.provider,
    backend: runtime.backend,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    hasApiKey: !!runtime.apiKey,
    local: runtime.local,
    timeout: runtime.timeout,
    outputMode: runtime.outputMode
  };
}

function resolveRuntimeConfig(options = {}) {
  const backend = options.backend || options.provider || 'ollama';
  const provider = normalizeProvider(options.provider || backend);
  const defaults = AI_BACKENDS[provider] || AI_BACKENDS.custom;
  const baseUrl = trimTrailingSlash(options.baseUrl || options.url || defaults.url);
  const model = options.model || options.aiModel || defaults.defaultModel || defaults.model;
  const apiKey = options.apiKey || getEnvApiKey(provider);

  if (provider !== 'ollama' && !baseUrl) {
    throw new Error('API Base URL 不能为空');
  }
  if (provider !== 'ollama' && !model) {
    throw new Error('模型名称不能为空');
  }
  if (defaults.requiresApiKey && !apiKey) {
    throw new Error(`${getBackendName(provider)} 需要配置 API Key`);
  }

  return {
    provider,
    backend,
    baseUrl,
    model,
    apiKey,
    timeout: Number(options.timeout || defaults.timeout || 60000),
    local: !!defaults.local,
    outputMode: options.outputMode || 'auto',
    responseFormatJson: options.outputMode === 'strict_json'
  };
}

function normalizeProvider(value) {
  const provider = String(value || 'ollama').trim().toLowerCase();
  if (provider === 'openai-compatible' || provider === 'compatible') return 'custom';
  if (provider === 'api') return 'custom';
  return AI_BACKENDS[provider] ? provider : 'custom';
}

function getEnvApiKey(provider) {
  if (provider === 'deepseek') return process.env.DEEPSEEK_API_KEY || '';
  if (provider === 'openai') return process.env.OPENAI_API_KEY || '';
  return process.env.AI_API_KEY || '';
}

function getApiHeaders(runtime) {
  const headers = { 'Content-Type': 'application/json' };
  if (runtime.apiKey) headers.Authorization = `Bearer ${runtime.apiKey}`;
  return headers;
}

function getChatCompletionsUrl(baseUrl) {
  const clean = trimTrailingSlash(baseUrl);
  if (clean.endsWith('/chat/completions')) return clean;
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getBackendName(key) {
  const names = {
    ollama: 'Ollama 本地模型',
    deepseek: 'DeepSeek API',
    openai: 'OpenAI API',
    custom: 'OpenAI 兼容 API'
  };
  return names[key] || key;
}
