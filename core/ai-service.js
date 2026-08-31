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
  }
};

/**
 * 调用 AI 模型
 * @param {string} prompt - 提示词
 * @param {object} options - 选项
 * @returns {Promise<object>} AI 响应
 */
export async function callAI(prompt, options = {}) {
  const backend = options.backend || 'ollama';
  const config = AI_BACKENDS[backend];

  if (backend === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
    throw new Error('DeepSeek API 需要设置 DEEPSEEK_API_KEY 环境变量');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout);

  try {
    let response;

    if (backend === 'ollama') {
      response = await fetch(`${config.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model || config.defaultModel,
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
      response = await fetch(`${config.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens ?? 2048
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
    if (backend === 'ollama') {
      content = data.response || '';
    } else {
      content = data.choices?.[0]?.message?.content || '';
    }

    return {
      content,
      raw: data,
      backend,
      model: backend === 'ollama' ? (options.model || config.defaultModel) : config.model
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
export async function checkAIService(backend = 'ollama') {
  const config = AI_BACKENDS[backend];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    if (backend === 'ollama') {
      const response = await fetch(`${config.url}/api/tags`, {
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
        available: !!process.env.DEEPSEEK_API_KEY,
        backend,
        local: false,
        message: process.env.DEEPSEEK_API_KEY ? 'API Key 已配置' : '需要设置 DEEPSEEK_API_KEY'
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
    name: key === 'ollama' ? 'Ollama (本地)' : 'DeepSeek API',
    local: config.local,
    defaultModel: config.defaultModel || config.model,
    requiresApiKey: config.requiresApiKey || false
  }));
}
