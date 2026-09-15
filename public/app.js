/**
 * CT/MR/DR device collection Agent frontend.
 */

// ============ 状态管理 ============
const state = {
  selectedDisk: null,
  selectedDisks: [],
  templateRules: [],
  templateFilename: '',
  indexBuilt: false,
  collectAbortController: null,
  agentSessionId: '',
  agentStreamingMessage: null,
  agentReasoningMessage: null,
  agentCurrentIntent: 'chat',
  agentFollowBottom: true,
  agentEditingLocked: false,
  agentLastErrorMessage: '',
  rawExperienceImportFile: null,
  agentProfiles: [],
  agentConfig: {
    profileId: 0,
    provider: 'api',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
    outputMode: 'auto'
  }
};

const DEFAULT_AGENT_PROFILE = `你是医疗设备数据采集场景中的决策大脑/分析师，不直接碰文件系统。

你的工作是：理解待采指标，结合知识库和当前设备上下文推测可能位置，生成完成本次探索所需的只读代码，判断执行结果是否可信，最终输出结构化结论。

分工边界：
- 你是决策者/分析师：负责理解、推测、决策、判定。
- 程序是执行器/验证器：负责执行你生成的只读代码、记录过程并验证结构化结果。
- 你不能臆造值，不能假装已经读取文件。
- 所有结论必须基于本地程序执行代码后返回的真实证据。

知识使用原则：
- 你不预设任何固定设备路径或固定指标规则。
- 你可以参考知识库、旧表经验、指标标识、历史路径和证据摘要。
- 所有参考信息都只是线索，必须通过当前设备文件重新验证。
- 验证失败的路径和关键字应标记为无效线索，避免重复尝试。

证据红线：
- 无证据绝不标成功。
- 仅关键词命中属于 WEAK，进入待人工确认。
- 精确 selector、结构化字段、格式匹配、可信文件来源一致时，可作为 MEDIUM。
- 多个独立可信来源互相印证，或结构化字段与日志证据一致时，可作为 STRONG。
- 每个结果必须尽量带 data_timestamp、file_mtime、file_path、evidence。
- 患者检查类参数必须来自同一检查上下文，优先同一源文件；跨文件时必须有明确关联字段。
- test、template、demo、sample、systemstatus、testProtConfig 等文件不得作为正式结果来源。

输出约束：
- 决策步骤必须输出结构化 JSON。
- 如果需要探索，输出 code_call 并生成本次所需的只读 JavaScript。
- 如果证据不足，输出 not_found 或 needs_review。
- 最终结果必须包含 value、evidence、confidence、evidence_level、reason。`;

// ============ DOM 元素 ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // 检测平台
  try {
    const res = await fetch('/api/v1/health');
    const data = await res.json();
    const platformNames = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
    $('#platformBadge').textContent = platformNames[data.platform] || data.platform;
    state.agentSessionId = data.sessionId || '';
    await loadAgentSessionMessages();
  } catch (e) {
    showToast('服务连接失败', 'error');
  }

  // 加载磁盘列表
  await loadDisks();

  // 加载设备模板列表
  await loadIndicatorCatalogs();

  // 绑定事件
  bindEvents();
  initAgentProfile();
  updateCollectButton();

  updateFooterStatus('就绪');
}
async function loadAgentSessionMessages() {
  if (!state.agentSessionId) return;
  try {
    const res = await fetch(`/api/v1/agent/session/${encodeURIComponent(state.agentSessionId)}/messages`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.messages) || data.messages.length === 0) return;
    const list = $('#agentMessages');
    if (!list) return;
    list.innerHTML = '';
    for (const message of data.messages) {
      addAgentMessage(message.role === 'user' ? 'user' : 'agent', message.content || '');
    }
  } catch {
    // 会话恢复失败不影响本次使用。
  }
}

// ============ 磁盘管理 ============
async function loadDisks() {
  try {
    const res = await fetch('/api/v1/disks');
    const data = await res.json();
    renderDiskList(data.disks);
  } catch (e) {
    $('#diskList').innerHTML = '<div class="error-placeholder">磁盘检测失败</div>';
  }
}

function renderDiskList(disks) {
  if (!disks || disks.length === 0) {
    $('#diskList').innerHTML = '<div class="error-placeholder">未检测到磁盘</div>';
    return;
  }

  $('#diskList').innerHTML = disks.map(disk => {
    const total = disk.totalGB || disk.total || 0;
    const free = disk.freeGB || disk.free || 0;
    const used = disk.usedGB || disk.used || (total - free);
    const usedPercent = total > 0 ? Math.round((used / total) * 100) : 0;
    const mountPoint = disk.letter || disk.mount || disk.path;
    const label = disk.label || mountPoint;
    const isSystem = mountPoint === 'C:' || mountPoint === '/' || (mountPoint && mountPoint.startsWith('C'));
    const diskType = disk.type || '本地磁盘';
    return `
      <div class="disk-item ${state.selectedDisks.includes(mountPoint) ? 'selected' : ''}" data-path="${mountPoint}">
        <div class="disk-icon">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="6" width="20" height="12" rx="2"/>
            <circle cx="18" cy="12" r="2"/>
            <line x1="6" y1="12" x2="14" y2="12"/>
          </svg>
        </div>
        <div class="disk-info">
          <div class="disk-name">${label}</div>
          <div class="disk-detail">${total} GB 总容量 | ${free} GB 可用</div>
          <div class="disk-progress">
            <div class="disk-progress-bar" style="width:${usedPercent}%"></div>
          </div>
        </div>
        <div class="disk-badge">${diskType}</div>
      </div>
    `;
  }).join('');

  // 绑定磁盘选择事件
  $$('.disk-item').forEach(el => {
    el.addEventListener('click', () => selectDisk(el.dataset.path));
  });
}

function selectDisk(diskPath) {
  if (state.agentEditingLocked) {
    showToast('Agent 采集中，暂时不能切换磁盘', 'warning');
    return;
  }
  if (state.selectedDisks.includes(diskPath)) {
    state.selectedDisks = state.selectedDisks.filter(disk => disk !== diskPath);
  } else {
    state.selectedDisks.push(diskPath);
  }
  state.selectedDisk = state.selectedDisks[0] || null;

  $$('.disk-item').forEach(el => {
    el.classList.toggle('selected', state.selectedDisks.includes(el.dataset.path));
  });

  const diskText = getSelectedDiskText();
  $('#infoDisk').textContent = diskText || '未选择';
  $('#btnBuildIndex').disabled = state.selectedDisks.length === 0;
  updateCollectButton();
  updateFooterStatus(diskText ? `已选择磁盘: ${diskText}` : '未选择磁盘');

  // 更新步骤指示器
  updateStep(2);

  // 检查索引状态
  checkSelectedIndexStatus();
}

function getSelectedDisks() {
  return state.selectedDisks.length > 0 ? state.selectedDisks : (state.selectedDisk ? [state.selectedDisk] : []);
}

function getSelectedDiskText() {
  return getSelectedDisks().join(', ');
}

function updateStep(currentStep) {
  $$('.step').forEach((el) => {
    const stepNum = parseInt(el.dataset.step);
    el.classList.remove('active', 'completed');
    if (stepNum < currentStep) {
      el.classList.add('completed');
    } else if (stepNum === currentStep) {
      el.classList.add('active');
    }
  });
}

// ============ 文件索引 ============
async function checkIndexStatus(diskRoot) {
  try {
    const encoded = encodeURIComponent(diskRoot);
    const res = await fetch(`/api/v1/index/status/${encoded}`);
    const data = await res.json();

    const statusEl = $('#indexStatus');
    const textEl = $('#indexStatusText');

    if (data.available && data.fresh) {
      statusEl.style.display = 'flex';
      textEl.textContent = `索引有效 | ${data.stats?.totalFiles || 0} 个文件 | 最后扫描: ${data.stats?.lastScan || '-'}`;
      statusEl.className = 'index-status index-fresh';
      state.indexBuilt = true;
    } else if (data.available) {
      statusEl.style.display = 'flex';
      textEl.textContent = '索引已过期，建议重新构建';
      statusEl.className = 'index-status index-stale';
      state.indexBuilt = false;
    } else {
      statusEl.style.display = 'flex';
      textEl.textContent = '索引未构建';
      statusEl.className = 'index-status index-none';
      state.indexBuilt = false;
    }
  } catch (e) {
    // 忽略
  }
}

async function checkSelectedIndexStatus() {
  const disks = getSelectedDisks();
  if (disks.length === 0) return;

  if (disks.length === 1) {
    await checkIndexStatus(disks[0]);
    return;
  }

  const statusEl = $('#indexStatus');
  const textEl = $('#indexStatusText');
  statusEl.style.display = 'flex';
  textEl.textContent = `已选择 ${disks.length} 个磁盘，索引状态将在采集时分别判断`;
  statusEl.className = 'index-status index-stale';
  state.indexBuilt = false;
}

async function buildIndex() {
  const disks = getSelectedDisks();
  if (disks.length === 0) return;

  $('#btnBuildIndex').disabled = true;
  updateFooterStatus('正在构建文件索引...');
  showProgress(true, `正在为 ${disks.length} 个磁盘构建索引...`);

  try {
    let total = 0;
    let inserted = 0;
    let updated = 0;

    for (const diskRoot of disks) {
      updateFooterStatus(`正在构建索引: ${diskRoot}`);
      const res = await fetch('/api/v1/index/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diskRoot })
      });
      const data = await res.json();

      if (!data.success) {
        throw new Error(`${diskRoot}: ${data.error}`);
      }

      total += data.stats.total || 0;
      inserted += data.stats.inserted || 0;
      updated += data.stats.updated || 0;
    }

    state.indexBuilt = true;
    showToast(`索引构建完成: ${total} 个文件, 新增 ${inserted}, 更新 ${updated}`, 'success');
    checkSelectedIndexStatus();
  } catch (e) {
    showToast('索引构建失败: ' + e.message, 'error');
  } finally {
    $('#btnBuildIndex').disabled = false;
    showProgress(false);
    updateFooterStatus('就绪');
  }
}

// ============ 设备模板管理 ============
async function loadIndicatorCatalogs() {
  try {
    const response = await fetch('/api/v1/indicator-catalogs');
    const data = await response.json();
    if (!data.success) throw new Error(data.error || '固定指标目录加载失败');
    state.indicatorCatalogs = data.catalogs || [];
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function loadIndicatorCatalog(deviceType) {
  const type = String(deviceType || '').trim().toUpperCase();
  if (!type) {
    state.templateRules = [];
    state.templateFilename = '';
    renderTemplatePreview();
    updateCollectButton();
    return;
  }
  try {
    const response = await fetch(`/api/v1/indicator-catalogs/${encodeURIComponent(type)}`);
    const data = await response.json();
    if (!data.success) throw new Error(data.error || '固定指标目录加载失败');
    state.templateRules = (data.indicators || []).map(item => ({
      indicatorId: item.id,
      indicator: item.indicator,
      indicatorCode: item.indicatorCode || '',
      enabled: item.enabled !== false
    }));
    state.templateFilename = `${type} 固定指标`;
    renderTemplatePreview();
    updateCollectButton();
    updateStep(2);
    showToast(`已生成 ${data.count || 0} 个 ${type} 采集指标，可直接编辑`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function uploadTemplate(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    updateFooterStatus('正在解析模板...');
    const res = await fetch('/api/v1/template/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.success) {
      // 移除"保存修改到经验库"按钮（如果存在）
      const saveEditBtn = $('#saveEditBtnContainer');
      if (saveEditBtn) saveEditBtn.remove();
      
      // 清除编辑经验库状态
      state.editingExperienceId = null;
      
      // 转换字段名为驼峰格式
      state.templateRules = data.rules.map(r => ({
        indicator: r.indicator || '',
        indicatorCode: r.indicatorCode || r.indicator_code || '',
        filePattern: '',
        keyword: '',
        synonyms: [],
        keywordMeaning: ''
      }));
      state.templateFilename = data.filename;
      renderTemplatePreview();
      updateCollectButton();
      updateStep(2);
      showToast(`采集任务模板解析成功: ${data.count} 个指标`, 'success');
    } else {
      showToast('模板解析失败: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('模板上传失败: ' + e.message, 'error');
  } finally {
    updateFooterStatus('就绪');
  }
}

function renderTemplatePreview() {
  const rules = state.templateRules;
  if (!rules) return;

  $('#templatePreview').style.display = 'block';
  $('#ruleCount').textContent = `${rules.length} 条规则`;

  const tbody = $('#templateTable tbody');
  if (rules.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#888;padding:20px;">暂无指标，点击"+ 添加行"或上传采集任务模板</td></tr>';
    return;
  }

  tbody.innerHTML = rules.map((rule, i) => `
    <tr data-index="${i}">
      <td>${i + 1}</td>
      <td><input type="text" class="rule-input" data-field="indicator" data-index="${i}" value="${escapeHtml(rule.indicator || '')}" placeholder="中文指标名称"></td>
      <td><input type="text" class="rule-input" data-field="indicatorCode" data-index="${i}" value="${escapeHtml(rule.indicatorCode || rule.indicator_code || '')}" placeholder="可选，英文名/字段名/缩写"></td>
      <td><button class="btn-icon btn-delete-rule" data-index="${i}" title="删除此行">✕</button></td>
    </tr>
  `).join('');

  // 绑定输入事件
  tbody.querySelectorAll('.rule-input').forEach(input => {
    input.addEventListener('change', handleRuleEdit);
  });

  // 绑定删除按钮
  tbody.querySelectorAll('.btn-delete-rule').forEach(btn => {
    btn.addEventListener('click', handleDeleteRule);
  });

  $('#infoRules').textContent = `${rules.length} 条规则 (${state.templateFilename || '手动编辑'})`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}

function handleRuleEdit(e) {
  if (state.agentEditingLocked) return;
  const idx = parseInt(e.target.dataset.index);
  const field = e.target.dataset.field;
  const value = e.target.value.trim();

  state.templateRules[idx][field] = value;
}

function handleDeleteRule(e) {
  if (state.agentEditingLocked) {
    showToast('Agent 采集中，暂时不能修改模板', 'warning');
    return;
  }
  const idx = parseInt(e.target.dataset.index);
  state.templateRules.splice(idx, 1);
  renderTemplatePreview();
  showToast('已删除该行', 'info');
}

function addRuleRow() {
  if (state.agentEditingLocked) {
    showToast('Agent 采集中，暂时不能修改模板', 'warning');
    return;
  }
  if (!state.templateRules) state.templateRules = [];
  state.templateRules.push({ indicatorId: `CUSTOM_${Date.now()}`, indicator: '', indicatorCode: '' });
  renderTemplatePreview();
  // 聚焦到新增行的指标名称输入框
  const inputs = document.querySelectorAll('#templateTable tbody .rule-input[data-field="indicator"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// ============ 采集任务 ============
async function startCollection() {
  const selectedDisks = getSelectedDisks();
  if (state.collectAbortController) return;

  const btn = $('#btnStartCollect');
  const btnStopCollect = $('#btnStopCollect');
  const input = $('#agentUserInput');
  const instruction = input?.value.trim() || (state.templateRules.length ? '请根据当前模板和目标磁盘开始采集所有指标。' : '');
  if (!instruction) {
    showToast('请输入对话内容', 'warning');
    return;
  }

  state.collectAbortController = new AbortController();
  state.agentStreamingMessage = null;
  state.agentReasoningMessage = null;
  state.agentCurrentIntent = 'chat';
  state.agentFollowBottom = true;
  state.agentLastErrorMessage = '';
  setAgentRequestBusy(true);
  if (input) input.disabled = true;

  showProgress(true, 'Agent 正在处理...');
  updateFooterStatus('Agent 处理中...');
  updateStep(3);
  addAgentMessage('user', instruction);
  if (input) input.value = '';

  let agentEventSource = null;
  try {
    agentEventSource = new EventSource('/api/v1/agent/stream');
    await waitForEventSourceOpen(agentEventSource, 5000);
    agentEventSource.onmessage = event => {
      const data = JSON.parse(event.data);
      handleAgentEvent(data);
    };

    const agentOptions = getAgentAIOptions();
    const res = await fetch('/api/v1/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.collectAbortController.signal,
      body: JSON.stringify({
        message: instruction,
        sessionId: state.agentSessionId,
        roots: selectedDisks,
        vendor: $('#vendorInput')?.value || '',
        deviceType: $('#deviceTypeInput')?.value || '',
        model: $('#deviceModelInput')?.value || '',
        instruction,
        indicators: state.templateRules.map(rule => ({
          indicatorId: rule.indicatorId || rule.id || '',
          indicator: rule.indicator,
          indicatorCode: rule.indicatorCode || rule.indicator_code || '',
          enabled: rule.enabled !== false,
          keyword: '',
          synonyms: [],
          filePattern: '',
          keywordMeaning: ''
        })),
        provider: agentOptions.provider,
        backend: agentOptions.backend,
        baseUrl: agentOptions.baseUrl,
        apiKey: agentOptions.apiKey,
        aiModel: agentOptions.model,
        agentProfile: getAgentProfile(),
        outputMode: agentOptions.outputMode || 'auto'
      })
    });
    const data = await res.json();

    if (data.success && data.mode === 'collect') {
      state.agentSessionId = data.sessionId || state.agentSessionId;
      renderResults(data.results || [], data.scanLog || {});
      updateStep(4);
      addAgentMessage('agent', `采集完成：成功 ${data.scanLog?.success_count || 0}/${data.scanLog?.total_indicators || 0}，结果已生成，可下载 Excel。`);
      showToast(`Agent 采集完成: ${data.scanLog?.success_count || 0}/${data.scanLog?.total_indicators || 0} 成功`, 'success');
      showSaveExperienceButton(data.results || []);
    } else if (data.success) {
      state.agentSessionId = data.sessionId || state.agentSessionId;
      if (data.answer) finishAgentAnswer(data.answer);
    } else {
      const errorMessage = data.error || 'Agent 处理失败';
      if (state.agentLastErrorMessage !== errorMessage) addAgentMessage('error', errorMessage);
      showToast('Agent 处理失败: ' + (data.error || ''), 'error');
    }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    addAgentMessage(aborted ? 'muted' : 'error', aborted ? '已停止。' : `处理失败：${e.message}`);
    showToast(aborted ? '已停止' : 'Agent 处理失败: ' + e.message, aborted ? 'info' : 'error');
  } finally {
    if (agentEventSource) agentEventSource.close();
    state.collectAbortController = null;
    state.agentStreamingMessage = null;
    state.agentReasoningMessage = null;
    setAgentEditingLocked(false);
    setAgentRequestBusy(false);
    if (input) input.disabled = false;
    showProgress(false);
    updateFooterStatus('就绪');
  }
}

function waitForEventSourceOpen(source, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent 流连接超时')), timeout);
    source.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    source.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Agent 流连接失败'));
    };
  });
}

function handleAgentEvent(data) {
  if (!data || data.type === 'init') return;
  if (data.type === 'chat_intent') {
    state.agentCurrentIntent = data.intent || 'chat';
    if (data.intent === 'collect') setAgentEditingLocked(true);
    return;
  }
  if (data.type === 'error') {
    state.agentLastErrorMessage = data.message || '';
  }
  if (data.type === 'model_reasoning_delta') {
    appendAgentReasoningDelta(data.content || '');
    return;
  }
  if (data.type === 'chat_processing') {
    appendAgentReasoningDelta(`${data.message || '模型正在分析'}\n`);
    return;
  }
  if (data.type === 'model_delta') {
    if (state.agentCurrentIntent !== 'collect') appendAgentDelta(data.content || '');
    return;
  }
  if (data.type === 'model_step') {
    state.agentStreamingMessage = null;
    state.agentReasoningMessage = null;
  }

  const text = formatAgentEvent(data);
  if (!text) return;

  const type = data.type === 'error' || data.type === 'parse_error' ? 'error'
    : data.type === 'code_call' || data.type === 'code_result' ? 'tool'
    : data.type === 'complete' || data.type === 'indicator_complete' ? 'agent'
    : 'muted';
  addAgentMessage(type, text);
}

function formatAgentEvent(data) {
  if (data.type === 'parse_repair') {
    return `模型输出格式不标准，正在纠正：${data.indicator || '当前指标'} 第 ${data.step || '-'} 步`;
  }
  if (data.type === 'parse_error') {
    return `模型没有返回有效 JSON：${data.indicator || '当前指标'} 第 ${data.step || '-'} 步`;
  }
  const indicator = data.indicator ? `「${data.indicator}」` : '';
  if (data.type === 'request') return `收到采集任务：${data.indicatorCount || 0} 个指标，${(data.roots || []).join(', ')}`;
  if (data.type === 'start') return data.message || 'Agent 开始采集';
  if (data.type === 'planning') return data.message || '正在制定整批指标的共享探索计划';
  if (data.type === 'plan_ready') return `共享探索计划已生成：${(data.groups || []).length} 个指标分组${data.strategy ? `\n${data.strategy}` : ''}`;
  if (data.type === 'planning_fallback') return data.message || '共享计划不可用，按当前指标顺序继续';
  if (data.type === 'indicator_start') return `开始分析指标 ${indicator}（${data.index}/${data.total}）`;
  if (data.type === 'knowledge') return `知识库候选：${indicator} 找到 ${data.count || 0} 条`;
  if (data.type === 'model_step') return `模型决策：${indicator} 第 ${data.step}/${data.maxSteps} 步`;
  if (data.type === 'code_call') return `生成并执行 ${data.tool}：${data.thought || '探索当前磁盘并获取证据'}`;
  if (data.type === 'tool_progress') {
    const progress = data.progress || {};
    return `扫描进度 ${data.tool || ''}：已检查 ${progress.checkedFiles || 0} 个文件${progress.matches !== undefined ? `，匹配 ${progress.matches}` : ''}${progress.currentPath ? `\n${progress.currentPath}` : ''}`;
  }
  if (data.type === 'stagnation') return data.message || `检测到 ${indicator} 重复探索，正在重新规划`;
  if (data.type === 'code_result') return `执行结果 ${data.tool}：${data.summary || (data.success ? '成功' : '失败')}`;
  if (data.type === 'indicator_complete') return `指标完成 ${indicator}：${data.status}，置信度 ${data.confidence || 0}%`;
  if (data.type === 'complete') return data.message || 'Agent 采集完成';
  if (data.type === 'error') return `错误：${data.message || 'Agent 执行失败'}`;
  return data.message || '';
}

function addAgentMessage(role, text) {
  const list = $('#agentMessages');
  if (!list) return;
  const entry = document.createElement('div');
  const className = role === 'user' ? 'agent-message-user'
    : role === 'tool' ? 'agent-message-tool'
    : role === 'error' ? 'agent-message-error'
    : role === 'muted' ? 'agent-message-muted'
    : 'agent-message-agent';
  const avatar = role === 'user' ? '你' : role === 'tool' ? '工具' : role === 'error' ? '!' : 'AI';
  entry.className = `agent-message ${className}`;
  entry.innerHTML = `
    <div class="agent-avatar">${escapeHtml(avatar)}</div>
    <div class="agent-bubble">${escapeHtml(text)}</div>
  `;
  list.appendChild(entry);
  trimAgentMessages(list);
  scrollAgentMessagesToBottom();
  return entry;
}

function appendAgentDelta(content) {
  if (!content) return;
  const list = $('#agentMessages');
  if (!list) return;

  if (!state.agentStreamingMessage || !list.contains(state.agentStreamingMessage)) {
    state.agentStreamingMessage = addAgentMessage('agent', '');
  }

  const bubble = state.agentStreamingMessage?.querySelector('.agent-bubble');
  if (!bubble) return;

  const nextText = `${bubble.textContent || ''}${content}`;
  bubble.textContent = compactAgentStreamingText(nextText);
  scrollAgentMessagesToBottom();
}

function appendAgentReasoningDelta(content) {
  if (!content) return;
  const list = $('#agentMessages');
  if (!list) return;
  if (!state.agentReasoningMessage || !list.contains(state.agentReasoningMessage)) {
    const entry = document.createElement('div');
    entry.className = 'agent-message agent-message-muted agent-message-reasoning';
    entry.innerHTML = `
      <div class="agent-avatar">AI</div>
      <details class="agent-reasoning" open>
        <summary>处理过程</summary>
        <div class="agent-reasoning-content"></div>
      </details>
    `;
    list.appendChild(entry);
    state.agentReasoningMessage = entry;
  }
  const target = state.agentReasoningMessage.querySelector('.agent-reasoning-content');
  if (!target) return;
  target.textContent = compactAgentStreamingText(`${target.textContent || ''}${content}`);
  scrollAgentMessagesToBottom();
}

function finishAgentAnswer(answer) {
  const text = String(answer || '').trim();
  if (!text) return;
  const reasoning = state.agentReasoningMessage?.querySelector('.agent-reasoning');
  if (reasoning) reasoning.open = false;
  const bubble = state.agentStreamingMessage?.querySelector('.agent-bubble');
  if (bubble) {
    bubble.textContent = text;
    state.agentStreamingMessage = null;
    scrollAgentMessagesToBottom();
    return;
  }
  addAgentMessage('agent', text);
}

function setAgentRequestBusy(isBusy) {
  const btn = $('#btnStartCollect');
  const btnStopCollect = $('#btnStopCollect');
  if (btn) btn.disabled = isBusy || !canStartAgentCollect();
  if (btnStopCollect) btnStopCollect.style.display = isBusy ? 'inline-flex' : 'none';
}

function setAgentEditingLocked(isLocked) {
  state.agentEditingLocked = isLocked;

  const disabledSelectors = [
    '#fileInput',
    '#btnAddRule',
    '#btnRefreshDisks',
    '#btnBuildIndex',
    '#vendorInput',
    '#deviceTypeInput',
    '#deviceModelInput',
    '#agentProvider',
    '#agentProfileSelect',
    '#agentBaseUrl',
    '#agentModelName',
    '#agentApiKey',
    '#agentOutputMode',
    '#agentProfileInput',
    '#btnResetAgentProfile',
    '#btnAgentTest',
    '#btnDeleteAgentProfile',
    '#btnImportRawExperience',
    '#btnConfirmImportRawExperience',
    '#btnDownloadRawExperienceTemplate',
    '#btnBatchDeleteExp'
  ];

  disabledSelectors.forEach(selector => {
    const el = $(selector);
    if (el) el.disabled = isLocked;
  });

  $$('#templateTable .rule-input, #templateTable .btn-delete-rule').forEach(el => {
    el.disabled = isLocked;
  });

  $$('.disk-item').forEach(el => {
    el.classList.toggle('disabled', isLocked);
    el.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
  });

  const uploadZone = $('#uploadZone');
  if (uploadZone) {
    uploadZone.classList.toggle('disabled', isLocked);
    uploadZone.style.pointerEvents = isLocked ? 'none' : '';
  }
}

function initAgentProfile() {
  const input = $('#agentProfileInput');
  if (!input) return;
  input.value = localStorage.getItem('agentProfile') || DEFAULT_AGENT_PROFILE;
  input.addEventListener('input', () => {
    localStorage.setItem('agentProfile', input.value);
  });

  const btnReset = $('#btnResetAgentProfile');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      input.value = DEFAULT_AGENT_PROFILE;
      localStorage.setItem('agentProfile', DEFAULT_AGENT_PROFILE);
      showToast('已恢复默认 Agent 设定', 'success');
    });
  }
}

function getAgentProfile() {
  return $('#agentProfileInput')?.value.trim() || DEFAULT_AGENT_PROFILE;
}

function compactAgentStreamingText(text) {
  const value = String(text || '');
  if (value.length <= 1200) return value;
  return `${value.slice(0, 500)}\n...\n${value.slice(-650)}`;
}

function trimAgentMessages(list) {
  const max = 220;
  while (list.children.length > max) {
    list.firstElementChild?.remove();
  }
}

function scrollAgentMessagesToBottom() {
  const list = $('#agentMessages');
  const bottomBtn = $('#btnAgentScrollBottom');
  if (!list) return;
  if (!state.agentFollowBottom) {
    if (bottomBtn) bottomBtn.style.display = 'block';
    return;
  }
  list.scrollTop = list.scrollHeight;
  if (bottomBtn) bottomBtn.style.display = 'none';
}

function canStartAgentCollect() {
  return !state.collectAbortController;
}

function renderResults(results = [], scanLog = {}) {
  const panel = $('#panel-result');
  if (panel) panel.style.display = 'block';

  $('#statTotal').textContent = scanLog.total_indicators ?? results.length;
  $('#statSuccess').textContent = scanLog.success_count ?? results.filter(r => r.status === 'success').length;
  $('#statFail').textContent = scanLog.fail_count ?? results.filter(r => r.status !== 'success').length;
  $('#statTime').textContent = `${scanLog.duration || '0.00'}s`;

  const tbody = $('#resultTable tbody');
  if (!tbody) return;

  tbody.innerHTML = results.map((r, index) => {
    const status = r.status || (r.success ? 'success' : 'not_found');
    const confidence = Number(r.confidence || 0);
    const statusText = getAgentStatusText(status);
    const confidenceClass = getConfidenceClass(confidence);
    const filePath = r.filePath || r.file_path || '';
    const evidence = r.evidence || r.match_line || r.line || '';
    const keywordMeaning = r.keywordMeaning || r.keyword_meaning || r.reason || '';
    const synonyms = Array.isArray(r.synonyms) ? r.synonyms.join('; ') : (r.synonyms || '');
    const matchMethod = r.matchMethod || r.match_method || '';
    const sourceType = r.sourceType || r.source_type || 'agent_collection';

    return `
      <tr>
        <td>${index + 1}</td>
        <td class="indicator-cell"><strong>${escapeHtml(r.indicator || '')}</strong></td>
        <td>${escapeHtml(r.indicatorCode || r.indicator_code || '-')}</td>
        <td>${escapeHtml(r.value || '-')}</td>
        <td class="file-path-full" title="${escapeHtml(filePath)}">${escapeHtml(filePath || '-')}</td>
        <td class="keyword-cell">${r.matchedKeyword ? `<code>${escapeHtml(r.matchedKeyword)}</code>` : '<span class="text-muted">-</span>'}</td>
        <td>${escapeHtml(synonyms || '-')}</td>
        <td class="keyword-meaning-cell">${keywordMeaning ? escapeHtml(keywordMeaning) : '<span class="text-muted">-</span>'}</td>
        <td class="match-line-cell">${evidence ? escapeHtml(evidence) : '<span class="text-muted">-</span>'}</td>
        <td>${escapeHtml(r.dataTimestamp || r.data_timestamp || '-')}</td>
        <td>${escapeHtml(r.fileMtime || r.file_mtime || '-')}</td>
        <td><span class="agent-status-badge">${escapeHtml(r.evidenceLevel || r.evidence_level || 'NONE')}</span></td>
        <td><span class="confidence ${confidenceClass}">${confidence}%</span></td>
        <td>${escapeHtml(matchMethod || '-')}</td>
        <td><span class="agent-status-badge agent-status-${escapeHtml(status)}">${escapeHtml(statusText)}</span></td>
        <td>${escapeHtml(sourceType)}</td>
      </tr>
    `;
  }).join('');

  panel?.scrollIntoView({ behavior: 'smooth' });
}

function getAgentStatusText(status) {
  const map = {
    success: '成功',
    failed: '失败',
    not_found: '未找到',
    dry_run: '预演',
    verified: '已验证',
    user_verified: '人工确认',
    machine_validated: '程序验证',
    historical_import: '历史导入',
    candidate: '候选'
  };
  map.needs_tool = '需要工具';
  map.needs_review = '待确认';
  return map[status] || status || '-';
}

function getConfidenceClass(confidence) {
  if (!confidence) return '';
  if (confidence >= 100) return 'confidence-high';
  if (confidence >= 80) return 'confidence-medium';
  if (confidence >= 60) return 'confidence-low';
  return 'confidence-very-low';
}

function getMatchLevelClass(level) {
  if (level === 1) return 'exact';
  if (level === 2) return 'fuzzy';
  if (level === 3) return 'synonym';
  return '';
}

function formatPath(filePath) {
  if (!filePath) return '-';
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-3).join('/');
}

function updateCollectButton() {
  const btn = $('#btnStartCollect');
  if (btn) btn.disabled = !canStartAgentCollect();
}

function showProgress(show, text) {
  $('#progressSection').style.display = show ? 'block' : 'none';
  if (text) $('#progressText').textContent = text;
  if (show) {
    $('#progressBar').style.width = '70%';
    $('#progressBar').classList.add('active');
  } else {
    $('#progressBar').style.width = '100%';
    setTimeout(() => {
      $('#progressBar').style.width = '0%';
      $('#progressBar').classList.remove('active');
    }, 500);
  }
}

function updateFooterStatus(text) {
  $('#footerStatus').textContent = text;
}

function showToast(message, type = 'info') {
  const container = $('#toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ 采集经验库 ============
function showSaveExperienceButton(results) {
  // 存储结果供保存使用
  window._lastCollectionResults = results;

  // 在结果区域后面显示"保存到知识库"按钮（不自动弹窗）
  const resultPanel = $('#panel-result');
  if (!resultPanel) return;

  // 移除旧的按钮容器（如果存在）
  const oldBtn = $('#saveToExperienceBtn');
  if (oldBtn) oldBtn.remove();

  // 创建按钮容器
  const btnContainer = document.createElement('div');
  btnContainer.id = 'saveToExperienceBtn';
  btnContainer.style.cssText = 'margin-top: 16px; text-align: center;';
  btnContainer.innerHTML = `
    <button class="btn btn-primary" onclick="openSaveExperienceModal()">
      💾 保存到知识库
    </button>
  `;
  resultPanel.appendChild(btnContainer);
}

function openSaveExperienceModal() {
  const modal = $('#saveConfirmModal');
  if (!modal) return;

  modal.style.display = 'flex';

  // 绑定保存按钮事件（先移除旧的避免重复绑定）
  const btn = $('#btnConfirmSave');
  if (btn) {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', saveExperienceFromModal);
  }
}

function closeSaveModal() {
  const modal = $('#saveConfirmModal');
  if (modal) modal.style.display = 'none';
}

async function saveExperienceFromModal() {
  const vendor = $('#saveVendor') ? $('#saveVendor').value : '';
  const deviceType = $('#saveDeviceType') ? $('#saveDeviceType').value : '';
  const model = $('#saveModel') ? $('#saveModel').value : '';

  if (!vendor || !deviceType) {
    showToast('请选择厂商和设备类型', 'error');
    return;
  }

  const results = Array.isArray(window._lastCollectionResults) ? window._lastCollectionResults : [];
  if (results.length === 0) {
    showToast('没有可保存的采集结果', 'error');
    return;
  }

  try {
    const res = await fetch('/api/v1/experience/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        deviceType,
        model: model || '通用',
        rules: results.map(r => ({
          indicator: r.indicator,
          indicatorCode: r.indicatorCode || r.indicator_code || '',
          value: r.value || '',
          filePattern: r.filePath || r.file_path || r.filePattern || '',
          keyword: r.matchedKeyword || r.keyword || '',
          synonyms: Array.isArray(r.synonyms) ? r.synonyms.join(';') : (r.synonyms || ''),
          keywordMeaning: r.keywordMeaning || r.keyword_meaning || '',
          actualPath: r.filePath || r.file_path || r.actualPath || '',
          evidence: r.evidence || r.match_line || r.line || '',
          dataTimestamp: r.dataTimestamp || r.data_timestamp || '',
          fileMtime: r.fileMtime || r.file_mtime || '',
          evidenceLevel: r.evidenceLevel || r.evidence_level || 'NONE',
          confidence: r.confidence || 0,
          matchMethod: r.matchMethod || r.match_method || '',
          status: (r.value || r.evidence) && !['not_found', 'failed'].includes(r.status) ? 'user_verified' : (r.status || 'not_found'),
          sourceType: r.sourceType || r.source_type || 'collection_result'
        })),
        successRate: Math.round((results.filter(r => (r.value || r.evidence) && !['not_found', 'failed'].includes(r.status)).length / Math.max(results.length, 1)) * 100)
      })
    });
    const data = await res.json();

    if (data.success) {
      const knowledge = data.knowledge || {};
      showToast(`经验已保存：已验证 ${knowledge.verified || 0} 条，待确认 ${knowledge.pending || 0} 条，失败经验 ${knowledge.failed || 0} 条`, 'success');
      closeSaveModal();
      loadExperienceRecords();
    } else {
      showToast('保存失败: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

function openImportRawExperienceModal() {
  const modal = $('#importRawExpModal');
  if (!modal) return;

  const vendor = $('#vendorInput')?.value.trim() || '';
  const deviceType = $('#deviceTypeInput')?.value.trim() || '';
  const model = $('#deviceModelInput')?.value.trim() || '';
  if ($('#rawExpVendor')) $('#rawExpVendor').value = vendor;
  if ($('#rawExpDeviceType')) $('#rawExpDeviceType').value = deviceType;
  if ($('#rawExpModel')) $('#rawExpModel').value = model;
  if ($('#rawExpGenerateCandidates')) $('#rawExpGenerateCandidates').checked = true;
  if ($('#rawExpFileState')) $('#rawExpFileState').textContent = '未选择文件';
  state.rawExperienceImportFile = null;
  modal.style.display = 'flex';
}

function closeImportRawExperienceModal() {
  const modal = $('#importRawExpModal');
  if (modal) modal.style.display = 'none';
  state.rawExperienceImportFile = null;
  const input = $('#rawExperienceFileInput');
  if (input) input.value = '';
}

function chooseRawExperienceFile() {
  const input = $('#rawExperienceFileInput');
  if (input) input.click();
}

async function importSelectedRawExperience() {
  if (!state.rawExperienceImportFile) {
    chooseRawExperienceFile();
    return;
  }

  const vendor = $('#rawExpVendor')?.value.trim() || '';
  const deviceType = $('#rawExpDeviceType')?.value.trim() || '';
  const model = $('#rawExpModel')?.value.trim() || '';
  const shouldGenerate = $('#rawExpGenerateCandidates')?.checked === true;

  if (!vendor || !deviceType) {
    showToast('请填写厂商和设备类型', 'warning');
    return;
  }

  const btn = $('#btnConfirmImportRawExperience');
  const oldText = btn?.textContent || '';
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '导入中...';
    }

    const aiOptions = getAgentAIOptions();
    const form = new FormData();
    form.append('file', state.rawExperienceImportFile);
    form.append('vendor', vendor);
    form.append('deviceType', deviceType);
    form.append('model', model);
    form.append('generateCandidates', shouldGenerate ? 'true' : 'false');
    form.append('provider', aiOptions.provider || '');
    form.append('backend', aiOptions.backend || aiOptions.provider || '');
    form.append('baseUrl', aiOptions.baseUrl || '');
    form.append('apiKey', aiOptions.apiKey || '');
    form.append('aiModel', aiOptions.model || '');

    const res = await fetch('/api/v1/raw-experience/import', {
      method: 'POST',
      body: form
    });
    const data = await res.json();
    if (!data.success) {
      showToast('导入失败: ' + (data.error || '未知错误'), 'error');
      return;
    }

    showToast(`已导入 ${data.count || 0} 条旧表记录，已形成 ${data.baselineCount || 0} 条基础经验${data.generationQueued ? '，正在批量提炼' : ''}`, 'success');
    closeImportRawExperienceModal();
    loadExperienceRecords();
    if (data.generationJobId) pollKnowledgeGeneration(data.generationJobId);
  } catch (error) {
    showToast('导入失败: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '选择并导入';
    }
  }
}

async function pollKnowledgeGeneration(jobId) {
  try {
    const response = await fetch(`/api/v1/knowledge-generation/${encodeURIComponent(jobId)}`);
    const data = await response.json();
    if (!data.success) return;
    const job = data.job || {};
    updateFooterStatus(`经验提炼中：${job.processed || 0}/${job.total || 0}`);
    if (job.status === 'queued' || job.status === 'running') {
      setTimeout(() => pollKnowledgeGeneration(jobId), 1500);
      return;
    }
    loadExperienceRecords();
    updateFooterStatus('就绪');
    if (job.status === 'completed') {
      showToast(`经验提炼完成：生成 ${job.generated || 0} 条`, 'success');
    } else {
      showToast(`经验提炼完成：生成 ${job.generated || 0} 条，失败 ${job.failed || 0} 条`, 'warning');
    }
  } catch (error) {
    updateFooterStatus('经验提炼状态查询失败');
  }
}

// ============ 经验库面板 ============
async function toggleExperiencePanel() {
  const panel = $('#experiencePanel');
  if (!panel) return;

  // 滚动到经验库面板
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // 刷新经验库列表
  await loadExperienceRecords();
}

// ============ 事件绑定 ============
function bindEvents() {
  const deviceTypeInput = $('#deviceTypeInput');
  if (deviceTypeInput) {
    deviceTypeInput.addEventListener('change', event => loadIndicatorCatalog(event.target.value));
  }
  // 刷新磁盘
  $('#btnRefreshDisks').addEventListener('click', loadDisks);

  // 构建索引
  $('#btnBuildIndex').addEventListener('click', buildIndex);

  // 下载模板示例
  $('#btnDownloadExample').addEventListener('click', () => {
    const deviceType = $('#deviceTypeInput')?.value || '';
    if (!deviceType) {
      showToast('请先选择 CT、MR 或 DR', 'warning');
      return;
    }
    window.open(`/api/v1/indicator-catalogs/${encodeURIComponent(deviceType)}/download`, '_blank');
  });

  // 添加规则行
  $('#btnAddRule').addEventListener('click', addRuleRow);

  const agentMessages = $('#agentMessages');
  if (agentMessages) {
    agentMessages.addEventListener('scroll', () => {
      const distanceToBottom = agentMessages.scrollHeight - agentMessages.scrollTop - agentMessages.clientHeight;
      state.agentFollowBottom = distanceToBottom < 80;
      const bottomBtn = $('#btnAgentScrollBottom');
      if (bottomBtn) bottomBtn.style.display = state.agentFollowBottom ? 'none' : 'block';
    });
  }

  const btnAgentScrollBottom = $('#btnAgentScrollBottom');
  if (btnAgentScrollBottom) {
    btnAgentScrollBottom.addEventListener('click', () => {
      state.agentFollowBottom = true;
      scrollAgentMessagesToBottom();
    });
  }

  // 文件上传 - 拖拽
  const uploadZone = $('#uploadZone');
  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });
  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && /\.(xlsx|xls)$/i.test(file.name)) {
      uploadTemplate(file);
    } else {
      showToast('请上传 .xlsx 或 .xls 文件', 'error');
    }
  });
  uploadZone.addEventListener('click', () => {
    $('#fileInput').click();
  });
  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) uploadTemplate(file);
    e.target.value = '';
  });

  // 开始采集
  $('#btnStartCollect').addEventListener('click', startCollection);
  const agentInput = $('#agentUserInput');
  if (agentInput) {
    agentInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        startCollection();
      }
    });
  }

  const btnStopCollect = $('#btnStopCollect');
  if (btnStopCollect) {
    btnStopCollect.addEventListener('click', stopCollection);
  }

  // 下载结果
  $('#btnDownloadResult').addEventListener('click', () => {
    window.open('/api/v1/result/download', '_blank');
  });

  // 初始化 AI 状态
  bindAgentApiConfig();

  // 经验库按钮
  const btnRefreshExp = $('#btnRefreshExp');
  if (btnRefreshExp) btnRefreshExp.addEventListener('click', loadExperienceRecords);

  const btnImportRawExperience = $('#btnImportRawExperience');
  if (btnImportRawExperience) btnImportRawExperience.addEventListener('click', openImportRawExperienceModal);

  const btnConfirmImportRawExperience = $('#btnConfirmImportRawExperience');
  if (btnConfirmImportRawExperience) btnConfirmImportRawExperience.addEventListener('click', importSelectedRawExperience);

  const btnDownloadRawExperienceTemplate = $('#btnDownloadRawExperienceTemplate');
  if (btnDownloadRawExperienceTemplate) {
    btnDownloadRawExperienceTemplate.addEventListener('click', () => {
      window.open('/api/v1/raw-experience/template', '_blank');
    });
  }

  const rawExperienceFileInput = $('#rawExperienceFileInput');
  if (rawExperienceFileInput) {
    rawExperienceFileInput.addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!/\.(xlsx|xls)$/i.test(file.name)) {
        showToast('请上传 .xlsx 或 .xls 文件', 'error');
        event.target.value = '';
        return;
      }
      state.rawExperienceImportFile = file;
      const fileState = $('#rawExpFileState');
      if (fileState) fileState.textContent = `已选择：${file.name}`;
      importSelectedRawExperience();
    });
  }

  const btnBatchDeleteExp = $('#btnBatchDeleteExp');
  if (btnBatchDeleteExp) btnBatchDeleteExp.addEventListener('click', () => {
    showToast('批量删除功能开发中', 'info');
  });
}

function stopCollection() {
  if (!state.collectAbortController) return;
  state.collectAbortController.abort();
  addAgentMessage('muted', '正在停止当前 Agent 采集...');
}

// ==================== AI 功能 ====================

function bindAgentApiConfig() {
  const providerSelect = $('#agentProvider');
  const profileSelect = $('#agentProfileSelect');
  const baseUrlInput = $('#agentBaseUrl');
  const modelInput = $('#agentModelName');
  const apiKeyInput = $('#agentApiKey');
  const outputModeSelect = $('#agentOutputMode');
  const btnTest = $('#btnAgentTest');
  const btnDelete = $('#btnDeleteAgentProfile');

  if (!providerSelect || !baseUrlInput || !modelInput || !apiKeyInput) return;

  providerSelect.addEventListener('change', () => {
    applyAgentProviderDefaults(providerSelect.value);
    syncAiEngineFromAgentProvider();
  });

  profileSelect?.addEventListener('change', () => {
    if (profileSelect.value) activateAgentProfile(profileSelect.value);
    else {
      state.agentConfig = {
        profileId: 0,
        provider: 'api',
        backend: 'api',
        baseUrl: defaultAgentBaseUrl(),
        model: defaultAgentModel(),
        apiKey: '',
        hasApiKey: false,
        outputMode: 'auto'
      };
      renderAgentConfig(state.agentConfig);
    }
  });

  [baseUrlInput, modelInput, apiKeyInput, outputModeSelect].filter(Boolean).forEach(input => {
    input.addEventListener('input', () => {
      state.agentConfig = readAgentConfigForm();
    });
  });

  if (btnTest) btnTest.addEventListener('click', testAgentConnection);
  if (btnDelete) btnDelete.addEventListener('click', deleteSelectedAgentProfile);
  loadAgentConfig();
}

async function loadAgentConfig() {
  try {
    const res = await fetch('/api/v1/agent/config');
    const data = await res.json();
    if (data.success && data.config) {
      state.agentProfiles = data.profiles || [];
      state.agentConfig = {
        ...state.agentConfig,
        ...data.config,
        apiKey: ''
      };
      renderAgentConfig(data.config);
      syncAiEngineFromAgentProvider();
    }
  } catch {
    setAgentStatus('配置未加载', 'warning');
  }
}

function renderAgentConfig(config = {}) {
  const provider = $('#agentProvider');
  const profileSelect = $('#agentProfileSelect');
  const baseUrl = $('#agentBaseUrl');
  const model = $('#agentModelName');
  const apiKey = $('#agentApiKey');
  const outputMode = $('#agentOutputMode');
  renderAgentProfiles(config.profileId);
  const providerValue = 'api';
  if (provider && config.provider) provider.value = config.provider;
  if (baseUrl) baseUrl.value = config.baseUrl || defaultAgentBaseUrl(providerValue);
  if (model) {
    model.value = config.model || defaultAgentModel();
  }
  if (outputMode) outputMode.value = config.outputMode || 'auto';
  if (profileSelect) profileSelect.value = config.profileId ? String(config.profileId) : '';
  if (apiKey) {
    apiKey.value = '';
    apiKey.placeholder = config.hasApiKey
      ? `服务器已保存 ${config.apiKeyHint || 'API Key'}`
      : '输入后由服务器加密保存';
  }
  const deleteButton = $('#btnDeleteAgentProfile');
  if (deleteButton) deleteButton.disabled = !config.profileId;
  setAgentStatus(config.hasApiKey ? '服务器已保存 Key' : '未配置 Key', config.hasApiKey ? 'success' : 'info');
}

function renderAgentProfiles(selectedId = 0) {
  const select = $('#agentProfileSelect');
  if (!select) return;
  select.innerHTML = '<option value="">新配置</option>';
  for (const profile of state.agentProfiles) {
    const option = document.createElement('option');
    option.value = String(profile.id);
    option.textContent = `${profile.name}${profile.apiKeyHint ? ` · ${profile.apiKeyHint}` : ''}`;
    select.appendChild(option);
  }
  select.value = selectedId ? String(selectedId) : '';
}

function readAgentConfigForm() {
  const provider = 'api';
  return {
    profileId: Number($('#agentProfileSelect')?.value || state.agentConfig.profileId || 0),
    provider,
    backend: provider,
    baseUrl: $('#agentBaseUrl')?.value.trim() || defaultAgentBaseUrl(provider),
    model: $('#agentModelName')?.value.trim() || defaultAgentModel(provider),
    apiKey: $('#agentApiKey')?.value.trim() || '',
    outputMode: $('#agentOutputMode')?.value || 'auto'
  };
}

async function activateAgentProfile(profileId) {
  try {
    setAgentStatus('正在切换配置...', 'info');
    const res = await fetch('/api/v1/agent/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: Number(profileId) })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '切换配置失败');
    state.agentProfiles = data.profiles || [];
    state.agentConfig = { ...data.config, apiKey: '' };
    renderAgentConfig(state.agentConfig);
  } catch (error) {
    setAgentStatus(error.message, 'error');
    showToast(error.message, 'error');
  }
}

async function deleteSelectedAgentProfile() {
  const profileId = Number($('#agentProfileSelect')?.value || 0);
  if (!profileId) return;
  if (!window.confirm('确定删除这条 API 历史配置吗？')) return;
  try {
    const res = await fetch(`/api/v1/agent/config/${profileId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || '删除配置失败');
    state.agentProfiles = data.profiles || [];
    state.agentConfig = { ...data.config, apiKey: '' };
    renderAgentConfig(state.agentConfig);
    showToast('API 历史配置已删除', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function applyAgentProviderDefaults(provider) {
  const baseUrl = $('#agentBaseUrl');
  const model = $('#agentModelName');
  if (baseUrl) baseUrl.value = defaultAgentBaseUrl(provider);
  if (model) model.value = defaultAgentModel(provider);
  state.agentConfig = readAgentConfigForm();
  setAgentStatus('未测试', 'info');
}

function syncAiEngineFromAgentProvider() {}

function getAgentAIOptions() {
  state.agentConfig = readAgentConfigForm();
  return state.agentConfig;
}

async function testAgentConnection() {
  const btn = $('#btnAgentTest');
  const config = readAgentConfigForm();
  state.agentConfig = config;

  if (!config.apiKey && !config.profileId) {
    setAgentStatus('请先输入 API Key', 'error');
    showToast('请先输入 API Key', 'warning');
    return;
  }

  try {
    if (btn) btn.disabled = true;
    setAgentStatus('测试中...', 'info');
    const res = await fetch('/api/v1/agent/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.success) {
      state.agentProfiles = data.profiles || state.agentProfiles;
      state.agentConfig = { ...data.config, apiKey: '' };
      renderAgentConfig(state.agentConfig);
      setAgentStatus(`连接成功：${data.model || config.model || config.provider}`, 'success');
      showToast('API 模型连接成功', 'success');
    } else {
      const message = data.message || data.error || '连接失败';
      setAgentStatus(message, 'error');
      showToast('API 模型连接失败: ' + message, 'error');
    }
  } catch (error) {
    setAgentStatus('连接失败', 'error');
    showToast('API 模型连接失败: ' + error.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setAgentStatus(text, type = 'info') {
  const el = $('#agentApiStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.status = type;
}

function defaultAgentBaseUrl(provider) {
  return 'https://api.deepseek.com';
}

function defaultAgentModel(provider) {
  return 'deepseek-chat';
}

// ==================== 采集经验库 ====================
async function loadExperienceRecords() {
  try {
    const [savedRes, rawRes, knowledgeRes] = await Promise.all([
      fetch('/api/v1/experience/list'),
      fetch('/api/v1/raw-experience/list?limit=5000'),
      fetch('/api/v1/knowledge-candidates?limit=5000')
    ]);
    const savedData = await savedRes.json();
    const rawData = await rawRes.json();
    const knowledgeData = await knowledgeRes.json();
    renderExperienceList(
      savedData.success ? savedData.records : [],
      rawData.success ? rawData.records : [],
      knowledgeData.success ? knowledgeData.records : []
    );
  } catch (err) {
    console.error('加载经验库失败:', err);
  }
}

function renderExperienceList(records, rawRecords = [], knowledgeRecords = []) {
  const container = $('#expList');
  if (!container) return;

  const rawGroups = groupRawExperienceRecords(rawRecords);
  const knowledgeGroups = groupKnowledgeCandidates(knowledgeRecords);
  if ((!records || records.length === 0) && rawGroups.length === 0 && knowledgeGroups.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无采集记录</p><p class="hint">可以导入以前扫过的表，或保存 Agent 采集结果</p></div>';
    return;
  }

  let html = '<div class="experience-list">';
  for (const group of rawGroups) {
    html += `
      <div class="experience-item experience-item-raw">
        <div class="experience-main">
          <div class="experience-header">
            <span class="experience-source-badge">旧表</span>
            <span class="experience-vendor">${escapeHtml(group.vendor || '未知')}</span>
            <span class="experience-type">${escapeHtml(group.deviceType || '-')}</span>
            <span class="experience-model">${escapeHtml(group.model || '通用')}</span>
            <span class="experience-date">${escapeHtml(group.importedAt || '-')}</span>
          </div>
          <div class="experience-summary">
            ${escapeHtml(group.sourceFile || '未命名表格')}，${group.count} 条原始经验，示例指标：${escapeHtml(group.sampleIndicators.join('、') || '-')}
          </div>
        </div>
        <div class="experience-actions">
          <button class="btn-sm btn-warn" onclick="editRawExperienceGroup('${escapeAttr(group.key)}')">编辑</button>
          <button class="btn-sm btn-danger" onclick="deleteRawExperienceGroup('${escapeAttr(group.key)}')">删除</button>
        </div>
      </div>
    `;
  }

  for (const group of knowledgeGroups) {
    html += `
      <details class="experience-item knowledge-experience-group">
        <summary>
          <span class="experience-source-badge ${group.status === 'verified' ? 'saved' : ''}">${group.status === 'verified' ? '已验证经验' : '候选经验'}</span>
          <span class="experience-vendor">${escapeHtml(group.vendor || '未知')}</span>
          <span class="experience-type">${escapeHtml(group.deviceType || '-')}</span>
          <span class="experience-model">${escapeHtml(group.model || '通用')}</span>
          <span class="experience-summary">${group.records.length} 条，来源：${escapeHtml(group.sourceLabel)}</span>
        </summary>
        <div class="knowledge-record-list">
          ${group.records.map(renderKnowledgeCandidate).join('')}
        </div>
      </details>`;
  }

  for (const rec of records || []) {
    html += `
      <div class="experience-item">
        <div class="experience-main">
          <div class="experience-header">
            <span class="experience-source-badge saved">采集</span>
            <span class="experience-vendor">${escapeHtml(rec.vendor || '未知')}</span>
            <span class="experience-type">${escapeHtml(rec.deviceType || '-')}</span>
            <span class="experience-model">${escapeHtml(rec.model || '通用')}</span>
            <span class="experience-date">${escapeHtml(rec.savedAt || '-')}</span>
          </div>
          <div class="experience-summary">
            ${rec.indicatorCount || 0} 条结果，确认率 ${rec.successRate || 0}%
          </div>
        </div>
        <div class="experience-actions">
          <button class="btn-sm btn-warn" onclick="editExperience('${rec.id}')">编辑</button>
          <button class="btn-sm btn-danger" onclick="deleteExperience('${rec.id}')">删除</button>
        </div>
      </div>
    `;
  }
  html += '</div>';
  container.innerHTML = html;
}

function groupKnowledgeCandidates(records = []) {
  const groups = new Map();
  for (const record of records) {
    const sourceLabel = String(record.createdBy || '').startsWith('collection_result') ? '采集结果' : String(record.createdBy || '').startsWith('ai:') ? '外部 API 提炼' : '旧表基础字段';
    const key = [record.vendor, record.deviceType, record.model, record.status, sourceLabel].join('||');
    if (!groups.has(key)) groups.set(key, { vendor: record.vendor, deviceType: record.deviceType, model: record.model, status: record.status, sourceLabel, records: [] });
    groups.get(key).records.push(record);
  }
  return Array.from(groups.values());
}

function renderKnowledgeCandidate(record) {
  const field = (label, value, wide = false) => `
    <div class="knowledge-field ${wide ? 'knowledge-field-wide' : ''}">
      <span>${escapeHtml(label)}</span>
      <div>${escapeHtml(Array.isArray(value) ? value.join('；') : (value || '-'))}</div>
    </div>`;
  return `
    <article class="knowledge-record">
      <div class="knowledge-record-title">
        <strong>${escapeHtml(record.indicatorName || '未命名指标')}</strong>
        <code>${escapeHtml(record.indicatorCode || '-')}</code>
        <span class="agent-status-badge">${escapeHtml(record.status || 'draft')}</span>
      </div>
      <div class="knowledge-field-grid">
        ${field('规则类型', record.ruleType)}
        ${field('解析方式', record.parserType)}
        ${field('操作', record.operation)}
        ${field('置信度', `${record.confidence || 0}%`)}
        ${field('文件路径模式', record.filePatterns, true)}
        ${field('文件名模式', record.fileNamePatterns, true)}
        ${field('关键词', record.keywords, true)}
        ${field('选择器', record.selector, true)}
        ${field('值提取模式', record.valuePattern, true)}
        ${field('含义', record.meaning, true)}
        ${field('证据示例', record.evidenceExample, true)}
        ${field('形成依据', record.aiReason, true)}
      </div>
    </article>`;
}

function groupRawExperienceRecords(records = []) {
  const groups = new Map();
  for (const rec of records) {
    const key = [
      rec.sourceFile || '',
      rec.vendor || '',
      rec.deviceType || '',
      rec.model || '',
      rec.importedAt || ''
    ].join('||');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        sourceFile: rec.sourceFile || '',
        vendor: rec.vendor || '',
        deviceType: rec.deviceType || '',
        model: rec.model || '',
        importedAt: rec.importedAt || '',
        count: 0,
        sampleIndicators: [],
        records: []
      });
    }
    const group = groups.get(key);
    group.count += 1;
    group.records.push(rec);
    if (rec.indicatorName && group.sampleIndicators.length < 3 && !group.sampleIndicators.includes(rec.indicatorName)) {
      group.sampleIndicators.push(rec.indicatorName);
    }
  }
  const orderedGroups = Array.from(groups.values()).map(group => {
    group.records.sort((a, b) => Number(a.rowNumber || 0) - Number(b.rowNumber || 0));
    group.sampleIndicators = [];
    for (const record of group.records) {
      if (record.indicatorName && group.sampleIndicators.length < 3 && !group.sampleIndicators.includes(record.indicatorName)) {
        group.sampleIndicators.push(record.indicatorName);
      }
    }
    return group;
  });
  window._rawExperienceGroups = Object.fromEntries(orderedGroups.map(group => [group.key, group]));
  return orderedGroups;
}

function renderExperienceEditField(label, className, field, value, options = {}) {
  const wide = options.wide ? ' experience-edit-field-wide' : '';
  const control = options.textarea
    ? `<textarea class="${className}" data-field="${field}" rows="${options.rows || 3}">${escapeHtml(value || '')}</textarea>`
    : `<input class="${className}" ${options.type ? `type="${options.type}"` : ''} ${options.type === 'number' ? 'min="0" max="100"' : ''} data-field="${field}" value="${escapeAttr(value || '')}">`;
  return `<label class="experience-edit-field${wide}"><span>${escapeHtml(label)}</span>${control}</label>`;
}

function renderExperienceEditRecord(index, record, className, fields, id = '') {
  return `
    <article class="experience-edit-record" ${id ? `data-id="${escapeAttr(id)}"` : ''}>
      <div class="experience-edit-index">${index + 1}</div>
      <div class="experience-edit-grid">
        ${fields.map(field => renderExperienceEditField(field.label, className, field.name, record[field.name], field)).join('')}
      </div>
    </article>`;
}

function activateAutoGrowTextareas(container) {
  container?.querySelectorAll('textarea').forEach(textarea => {
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(88, textarea.scrollHeight + 2)}px`;
    };
    textarea.addEventListener('input', resize);
    resize();
  });
}

function editRawExperienceGroup(groupKey) {
  const group = window._rawExperienceGroups?.[groupKey];
  if (!group) {
    showToast('未找到旧表分组', 'error');
    return;
  }

  let modal = $('#rawExperienceEditModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'rawExperienceEditModal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }

  const rawFields = [
    { label: '指标', name: 'indicatorName' },
    { label: '指标标识', name: 'indicatorCode' },
    { label: '采集值', name: 'value' },
    { label: '文件路径', name: 'filePathRaw', wide: true },
    { label: '匹配关键字', name: 'matchedKeyword' },
    { label: '关键字及含义', name: 'keywordMeaningRaw', textarea: true, wide: true },
    { label: '证据内容', name: 'evidence', textarea: true, rows: 4, wide: true },
    { label: '数据时间', name: 'dataTimestamp' },
    { label: '文件修改时间', name: 'fileMtime' },
    { label: '证据等级', name: 'evidenceLevel' },
    { label: '置信度', name: 'confidence', type: 'number' },
    { label: '状态', name: 'status' }
  ];
  const rows = (group.records || []).map((record, index) => renderExperienceEditRecord(index, { ...record, status: record.status || 'historical_import' }, 'raw-exp-input', rawFields, record.id)).join('');

  modal.innerHTML = `
    <div class="modal modal-wide">
      <div class="modal-header">
        <h3>编辑旧表知识库</h3>
        <button class="modal-close" onclick="closeRawExperienceEditModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="raw-exp-group-meta">
          ${escapeHtml(group.vendor || '未知')} / ${escapeHtml(group.deviceType || '-')} / ${escapeHtml(group.model || '通用')}
          <span>${escapeHtml(group.sourceFile || '')}</span>
        </div>
        <div class="raw-exp-edit-wrapper experience-edit-list">${rows}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeRawExperienceEditModal()">取消</button>
        <button class="btn btn-primary" onclick="saveRawExperienceGroup('${escapeAttr(groupKey)}')">保存修改</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
  activateAutoGrowTextareas(modal);
}

function closeRawExperienceEditModal() {
  const modal = $('#rawExperienceEditModal');
  if (modal) modal.style.display = 'none';
}

async function saveRawExperienceGroup(groupKey) {
  const group = window._rawExperienceGroups?.[groupKey];
  const modal = $('#rawExperienceEditModal');
  if (!group || !modal) return;

  const rows = Array.from(modal.querySelectorAll('.experience-edit-record'));
  const updates = rows.map(row => {
    const payload = {};
    row.querySelectorAll('.raw-exp-input').forEach(input => {
      payload[input.dataset.field] = input.value.trim();
    });
    return { id: row.dataset.id, payload };
  }).filter(item => item.id);

  const saveButton = modal.querySelector('.modal-footer .btn-primary');
  if (saveButton) {
    saveButton.disabled = true;
    saveButton.textContent = '保存中...';
  }
  try {
    for (const item of updates) {
      const res = await fetch(`/api/v1/raw-experience/${encodeURIComponent(item.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '保存旧表记录失败');
    }

    showToast(`旧表已保存 ${updates.length} 条，基础经验已同步更新`, 'success');
    closeRawExperienceEditModal();
    loadExperienceRecords();
  } catch (error) {
    showToast('保存失败: ' + error.message, 'error');
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.textContent = '保存修改';
    }
  }
}

async function deleteRawExperienceGroup(groupKey) {
  const group = window._rawExperienceGroups?.[groupKey];
  if (!group) {
    showToast('未找到旧表分组', 'error');
    return;
  }
  if (!confirm(`确定删除这批旧表记录吗？共 ${group.count || 0} 条。`)) return;

  try {
    const res = await fetch('/api/v1/raw-experience', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor: group.vendor || '',
        deviceType: group.deviceType || '',
        model: group.model || '',
        sourceFile: group.sourceFile || '',
        importedAt: group.importedAt || ''
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '删除失败');
    showToast(`旧表记录已删除 ${data.count || 0} 条`, 'success');
    loadExperienceRecords();
  } catch (error) {
    showToast('删除失败: ' + error.message, 'error');
  }
}

async function deleteExperience(id) {
  if (!confirm('确定要删除这条采集记录吗？')) return;
  try {
    const res = await fetch(`/api/v1/experience/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('删除成功', 'success');
      loadExperienceRecords();
    }
  } catch (err) {
    showToast('删除失败：' + err.message, 'error');
  }
}

async function editExperience(id) {
  try {
    const res = await fetch(`/api/v1/experience/${id}`);
    const data = await res.json();
    if (data.success && data.record) {
      const rec = data.record;
      let modal = $('#experienceEditModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'experienceEditModal';
        modal.className = 'modal-overlay';
        document.body.appendChild(modal);
      }
      const savedFields = [
        { label: '指标', name: 'indicator' },
        { label: '指标标识', name: 'indicatorCode' },
        { label: '采集值', name: 'value' },
        { label: '文件路径', name: 'filePattern', wide: true },
        { label: '匹配关键字', name: 'keyword' },
        { label: '备用关键字', name: 'synonyms' },
        { label: '关键字和含义', name: 'keywordMeaning', textarea: true, wide: true },
        { label: '证据内容', name: 'evidence', textarea: true, rows: 4, wide: true },
        { label: '数据时间', name: 'dataTimestamp' },
        { label: '文件修改时间', name: 'fileMtime' },
        { label: '证据等级', name: 'evidenceLevel' },
        { label: '置信度', name: 'confidence', type: 'number' },
        { label: '匹配方式', name: 'matchMethod' },
        { label: '状态', name: 'status' },
        { label: '来源', name: 'sourceType' }
      ];
      const rows = (rec.rules || []).map((rule, index) => renderExperienceEditRecord(index, { ...rule, filePattern: rule.actualPath || rule.filePattern || '' }, 'saved-exp-input', savedFields)).join('');
      modal.innerHTML = `
        <div class="modal modal-wide">
          <div class="modal-header"><h3>编辑采集经验</h3><button class="modal-close" onclick="closeExperienceEditModal()">×</button></div>
          <div class="modal-body">
            <div class="raw-exp-group-meta">${escapeHtml(rec.vendor || '')} / ${escapeHtml(rec.deviceType || '')} / ${escapeHtml(rec.model || '通用')}</div>
            <div class="raw-exp-edit-wrapper experience-edit-list">${rows}</div>
          </div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="closeExperienceEditModal()">取消</button><button class="btn btn-primary" onclick="saveEditedExperience(${Number(id)})">保存修改</button></div>
        </div>`;
      modal.dataset.vendor = rec.vendor || '';
      modal.dataset.deviceType = rec.deviceType || '';
      modal.dataset.model = rec.model || '';
      modal.style.display = 'flex';
      activateAutoGrowTextareas(modal);
    }
  } catch (err) {
    showToast('加载失败：' + err.message, 'error');
  }
}

function closeExperienceEditModal() {
  const modal = $('#experienceEditModal');
  if (modal) modal.style.display = 'none';
}

async function saveEditedExperience(id) {
  try {
    const modal = $('#experienceEditModal');
    if (!modal) return;
    const rules = Array.from(modal.querySelectorAll('.experience-edit-record')).map(row => {
      const rule = {};
      row.querySelectorAll('.saved-exp-input').forEach(input => { rule[input.dataset.field] = input.value.trim(); });
      rule.actualPath = rule.filePattern || '';
      rule.sourceType = 'collection_result';
      return rule;
    });
    const updateRes = await fetch(`/api/v1/experience/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor: modal.dataset.vendor || '',
        deviceType: modal.dataset.deviceType || '',
        model: modal.dataset.model || '',
        rules,
        indicatorCount: rules.length
      })
    });
    const updateData = await updateRes.json();
    if (updateData.success) {
      showToast('更新成功', 'success');
      closeExperienceEditModal();
      loadExperienceRecords();
    }
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  }
}
