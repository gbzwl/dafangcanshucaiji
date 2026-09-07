/**
 * MRI设备日志参数采集工具 v2.0 - 前端逻辑
 */

// ============ 状态管理 ============
const state = {
  selectedDisk: null,
  selectedDisks: [],
  templateRules: [],
  templateFilename: '',
  devices: [],
  indexBuilt: false,
  aiLoading: false,
  aiAbortController: null,
  aiFollowBottom: true,
  scanFollowBottom: true,
  collectAbortController: null,
  agentStreamingMessage: null,
  agentFollowBottom: true,
  agentEditingLocked: false,
  agentLastErrorMessage: '',
  rawExperienceImportFile: null,
  agentConfig: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: '',
    apiKey: '',
    outputMode: 'auto'
  }
};

const DEFAULT_AGENT_PROFILE = `你是医疗设备数据采集场景中的决策大脑/分析师，不直接碰文件系统。

你的工作是：理解待采指标，结合知识库和当前设备上下文推测可能位置，决定下一步调用什么程序工具，判断工具返回结果是否可信，最终输出结构化结论。

分工边界：
- 你是决策者/分析师：负责理解、推测、决策、判定。
- 程序是执行器/验证器：负责搜文件、读片段、解析、统计、返回结构化结果。
- 你不能臆造值，不能假装已经读取文件。
- 所有结论必须基于程序工具返回的真实证据。

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
- 如果需要工具，输出 tool_call。
- 如果现有工具不足，输出 tool_request。
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
  } catch (e) {
    showToast('服务连接失败', 'error');
  }

  // 加载磁盘列表
  await loadDisks();

  // 加载设备模板列表
  await loadDevices();

  // 绑定事件
  bindEvents();
  initAgentProfile();
  updateCollectButton();

  updateFooterStatus('就绪');
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
async function loadDevices() {
  try {
    const res = await fetch('/api/v1/devices');
    const data = await res.json();
    state.devices = data.devices || [];

    const select = $('#deviceSelect');
    if (select) {
      select.innerHTML = '<option value="">-- 自定义模板 --</option>';
      for (const device of state.devices) {
        const opt = document.createElement('option');
        opt.value = device.id;
        opt.textContent = `${device.brand} ${device.model}`;
        select.appendChild(opt);
      }
    }
  } catch (e) {
    // 忽略
  }
}

async function loadDeviceTemplate(deviceId) {
  if (!deviceId) return;

  try {
    updateFooterStatus('正在加载设备模板...');
    const res = await fetch(`/api/v1/devices/${deviceId}/template`);
    const data = await res.json();

    if (data.success) {
      state.templateRules = data.rules;
      state.templateFilename = data.device.description;
      renderTemplatePreview();
      updateCollectButton();
      showToast(`已加载 ${data.device.description} 模板 (${data.count} 条规则)`, 'success');
    } else {
      showToast('加载模板失败: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('加载模板失败: ' + e.message, 'error');
  } finally {
    updateFooterStatus('就绪');
  }
}

// ============ 模板上传 ============
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
  if (state.aiLoading || state.agentEditingLocked) return;
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
  if (state.aiLoading) {
    showToast('AI补全中，请等待完成', 'warning');
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
  if (state.aiLoading) {
    showToast('AI补全中，请等待完成', 'warning');
    return;
  }
  if (!state.templateRules) state.templateRules = [];
  state.templateRules.push({ indicator: '', indicatorCode: '', filePattern: '', keyword: '', synonyms: [], keywordMeaning: '' });
  renderTemplatePreview();
  // 聚焦到新增行的指标名称输入框
  const inputs = document.querySelectorAll('#templateTable tbody .rule-input[data-field="indicator"]');
  if (inputs.length) inputs[inputs.length - 1].focus();
}

// ============ 采集任务 ============
async function startTraditionalCollection() {
  const selectedDisks = getSelectedDisks();
  if (selectedDisks.length === 0 || !state.templateRules.length) return;

  const btn = $('#btnStartCollect');
  const btnAiFill = $('#btnAiFill');
  const btnStopCollect = $('#btnStopCollect');
  state.collectAbortController = new AbortController();
  btn.disabled = true;
  if (btnStopCollect) btnStopCollect.style.display = 'inline-flex';
  if (btnAiFill) btnAiFill.disabled = true; // 采集时禁用AI补全
  showProgress(true, '正在扫描文件并提取参数...');
  updateFooterStatus('采集中...');

  // 显示扫描进度面板
  const scanProgressPanel = $('#panel-scan-progress');
  if (scanProgressPanel) {
    scanProgressPanel.style.display = 'block';
    $('#scanFileList').innerHTML = '';
    $('#scanFileCount').textContent = '0';
    $('#scanMatchCount').textContent = '0';
    $('#scanCurrentIndicator').textContent = '-';
    $('#scanCurrentLevel').textContent = '-';
    $('#scanStatusText').textContent = '连接中...';
    state.scanFollowBottom = true;
    const scanBottomBtn = $('#btnScanScrollBottom');
    if (scanBottomBtn) scanBottomBtn.style.display = 'none';
  }

  // 连接 SSE 监听扫描进度
  let scanEventSource = null;
  let scannedFileCount = 0;
  let matchedFileCount = 0;

  try {
    // 等待 SSE 连接建立后再开始采集
    scanEventSource = new EventSource('/api/v1/scan-stream');
    
    // 使用 Promise 等待连接建立
    await new Promise((resolve, reject) => {
      scanEventSource.onopen = () => {
        console.log('[SSE] 连接已建立');
        $('#scanStatusText').textContent = '已连接';
        resolve();
      };
      
      scanEventSource.onerror = (err) => {
        console.error('[SSE] 连接错误:', err);
        $('#scanStatusText').textContent = '连接失败';
        reject(new Error('SSE 连接失败'));
      };
      
      // 超时处理
      setTimeout(() => {
        reject(new Error('SSE 连接超时'));
      }, 5000);
    });
    
    scanEventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'start') {
        $('#scanStatusText').textContent = '扫描中...';
      } else if (data.type === 'disk_start') {
        $('#scanCurrentIndicator').textContent = data.diskRoot;
        addScanFileEntry('', `开始扫描磁盘：${data.diskRoot}`, 'info');
      } else if (data.type === 'rule_start') {
        $('#scanCurrentIndicator').textContent = data.indicator;
        addScanFileEntry('', `开始扫描指标：${data.indicator}`, 'scanning', data.diskRoot || '');
      } else if (data.type === 'scan_level_start') {
        $('#scanCurrentIndicator').textContent = data.indicator;
        $('#scanCurrentLevel').textContent = data.levelName || data.level || '-';
        $('#scanStatusText').textContent = `${data.levelName || data.level}...`;
        addScanFileEntry('', `${data.levelName || data.level}：${data.indicator}`, 'info', data.diskRoot || '');
      } else if (data.type === 'dir_enter') {
        $('#scanStatusText').textContent = '扫描目录中...';
        addScanFileEntry('', `${data.level || ''} 进入目录：${data.dir}`, 'scanning', data.diskRoot || '', true);
      } else if (data.type === 'file_check') {
        if (data.checkedFiles !== undefined) {
          scannedFileCount = Math.max(scannedFileCount, data.checkedFiles);
          $('#scanFileCount').textContent = scannedFileCount;
        }
        if (data.target) {
          addScanFileEntry('', `${data.level || ''} 检查文件：${data.file}`, 'scanning', data.indicator || '', true);
        }
      } else if (data.type === 'file_match') {
        addScanFileEntry('✅', `${data.level || ''} 匹配候选文件：${data.file}`, 'matched', data.indicator || '');
      } else if (data.type === 'full_scan') {
        addScanFileEntry('📂', `${data.diskRoot || ''} 全盘扫描完成：找到 ${data.totalFiles} 个候选日志文件`, 'info');
      } else if (data.type === 'rule_candidates') {
        addScanFileEntry('', `${data.levelName || data.level} 找到 ${data.filesFound} 个候选文件`, data.filesFound > 0 ? 'info' : 'complete', data.indicator || '');
      } else if (data.type === 'scan_level_complete') {
        addScanFileEntry(data.hit ? '✅' : '', `${data.levelName || data.level} ${data.hit ? '命中，停止升级' : '未命中，继续下一级'}`, data.hit ? 'matched' : 'info', data.indicator || '');
      } else if (data.type === 'rule_complete') {
        addScanFileEntry('✔️', `指标 ${data.indicator} 完成，找到 ${data.filesFound} 个候选文件`, 'complete', data.diskRoot || '');
      } else if (data.type === 'extract_start') {
        $('#scanStatusText').textContent = '提取参数中...';
        addScanFileEntry('', `开始读取候选文件并提取参数：${data.diskRoot}`, 'info');
      } else if (data.type === 'extract_file') {
        $('#scanCurrentIndicator').textContent = data.indicator;
        addScanFileEntry('', `检查关键字「${data.keyword}」：${data.file}`, 'scanning', data.indicator || '');
      } else if (data.type === 'keyword_hit') {
        matchedFileCount++;
        $('#scanMatchCount').textContent = matchedFileCount;
        const line = data.line ? `，第 ${data.lineNumber || '-'} 行：${data.line}` : '';
        addScanFileEntry('✅', `命中关键字「${data.keyword}」：${data.file}${line}`, 'matched', data.indicator || '');
      } else if (data.type === 'value_extracted') {
        const line = data.line ? `，第 ${data.lineNumber || '-'} 行：${data.line}` : '';
        addScanFileEntry('✔️', `提取成功「${data.keyword}」：${data.file}${line}`, 'complete', data.indicator || '');
      } else if (data.type === 'scan_complete') {
        $('#scanStatusText').textContent = '扫描完成';
        addScanFileEntry('', `扫描和提取完成！共发现 ${data.totalFiles} 个候选文件`, 'complete');
      } else if (data.type === 'scan_stopped') {
        $('#scanStatusText').textContent = '已停止';
        addScanFileEntry('', `采集已停止，已发现 ${data.totalFiles} 个候选文件`, 'info');
      }
    };

    const res = await fetch('/api/v1/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diskRoot: selectedDisks[0],
        diskRoots: selectedDisks,
        rules: state.templateRules.map(rule => ({
          ...rule,
          keyword: sanitizeEnglishKeyword(rule.keyword),
          synonyms: sanitizeEnglishKeywordList(rule.synonyms),
          keywordMeaning: rule.keywordMeaning || rule.keyword_meaning || ''
        })),
        useIndex: state.indexBuilt
      }),
      signal: state.collectAbortController.signal
    });
    const data = await res.json();

    if (data.success) {
      renderResults(data.results, data.scanLog);
      updateStep(4);
      
      // 显示采集结果，如果进行了全盘扫描则提示
      let msg = `采集完成: ${data.scanLog.success_count}/${data.scanLog.total_indicators} 成功`;
      if (data.scanLog.fallback_scan) {
        msg += ' (部分指标已启用全盘扫描)';
      }
      showToast(msg, 'success');

      // 显示保存经验按钮
      showSaveExperienceButton(data.results);
    } else {
      showToast('采集失败: ' + data.error, 'error');
    }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    showToast(aborted ? '采集已停止' : '采集失败: ' + e.message, aborted ? 'info' : 'error');
  } finally {
    btn.disabled = false;
    state.collectAbortController = null;
    if (btnStopCollect) btnStopCollect.style.display = 'none';
    if (btnAiFill) btnAiFill.disabled = false; // 恢复AI补全按钮
    showProgress(false);
    updateFooterStatus('就绪');
    
    // 关闭 SSE 连接
    if (scanEventSource) {
      scanEventSource.close();
    }
  }
}

// 添加扫描文件条目
function addScanFileEntry(icon, text, type, indicator = '', lowPriority = false) {
  const fileList = $('#scanFileList');
  if (!fileList) return;

  const entry = document.createElement('div');
  entry.className = `scan-file-entry scan-file-${type}`;
  if (lowPriority) entry.dataset.lowPriority = '1';
  
  const indicatorLabel = indicator ? `<span class="scan-file-indicator">[${indicator}]</span>` : '';
  entry.innerHTML = `
    <span class="scan-file-icon">${icon}</span>
    <span class="scan-file-text">${indicatorLabel}${text}</span>
  `;
  
  fileList.appendChild(entry);
  trimScanFileList(fileList);
  
  // 自动滚动到底部
  scrollScanProgressToBottom();
}

function trimScanFileList(fileList) {
  const maxEntries = 300;
  while (fileList.children.length > maxEntries) {
    const removable = fileList.querySelector('[data-low-priority="1"]');
    (removable || fileList.firstElementChild)?.remove();
  }
}

async function startCollection() {
  const selectedDisks = getSelectedDisks();
  if (state.collectAbortController) return;

  const btn = $('#btnStartCollect');
  const btnAiFill = $('#btnAiFill');
  const btnStopCollect = $('#btnStopCollect');
  const input = $('#agentUserInput');
  const instruction = input?.value.trim() || (state.templateRules.length ? '请根据当前模板和目标磁盘开始采集所有指标。' : '');
  if (!instruction) {
    showToast('请输入对话内容', 'warning');
    return;
  }

  state.collectAbortController = new AbortController();
  state.agentStreamingMessage = null;
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
        roots: selectedDisks,
        vendor: $('#vendorInput')?.value || '',
        deviceType: $('#deviceTypeInput')?.value || '',
        model: $('#deviceModelInput')?.value || '',
        instruction,
        indicators: state.templateRules.map(rule => ({
          indicator: rule.indicator,
          indicatorCode: rule.indicatorCode || rule.indicator_code || '',
          keyword: '',
          synonyms: [],
          filePattern: '',
          keywordMeaning: ''
        })),
        provider: agentOptions.provider,
        backend: agentOptions.backend,
        baseUrl: agentOptions.baseUrl,
        apiKey: agentOptions.apiKey,
        aiModel: agentOptions.provider === 'ollama'
          ? ($('#aiModelSelect')?.value || agentOptions.model || '')
          : agentOptions.model,
        maxSteps: readNumberInput('#agentMaxSteps', 10),
        maxDurationMs: readNumberInput('#agentMaxDuration', 300) * 1000,
        maxCandidates: readNumberInput('#agentMaxCandidates', 8),
        maxResultChars: readNumberInput('#agentMaxResultChars', 7000),
        agentProfile: getAgentProfile(),
        outputMode: agentOptions.outputMode || 'auto'
      })
    });
    const data = await res.json();

    if (data.success && data.mode === 'collect') {
      renderResults(data.results || [], data.scanLog || {});
      updateStep(4);
      addAgentMessage('agent', `采集完成：成功 ${data.scanLog?.success_count || 0}/${data.scanLog?.total_indicators || 0}，结果已生成，可下载 Excel。`);
      showToast(`Agent 采集完成: ${data.scanLog?.success_count || 0}/${data.scanLog?.total_indicators || 0} 成功`, 'success');
      showSaveExperienceButton(data.results || []);
    } else if (data.success) {
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
    if (data.intent === 'collect') setAgentEditingLocked(true);
    return;
  }
  if (data.type === 'error') {
    state.agentLastErrorMessage = data.message || '';
  }
  if (data.type === 'model_delta') {
    appendAgentDelta(data.content || '');
    return;
  }
  if (data.type === 'model_step') {
    state.agentStreamingMessage = null;
  }

  const text = formatAgentEvent(data);
  if (!text) return;

  const type = data.type === 'error' || data.type === 'parse_error' ? 'error'
    : data.type === 'tool_call' || data.type === 'tool_result' || data.type === 'tool_request' ? 'tool'
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
  if (data.type === 'tool_request') {
    const tool = data.tool || '未命名工具';
    const reason = data.reason || data.expectedOutput || '当前工具箱不能可靠完成这一步';
    return `工具需求：${tool}\n原因：${reason}`;
  }
  const indicator = data.indicator ? `「${data.indicator}」` : '';
  if (data.type === 'request') return `收到采集任务：${data.indicatorCount || 0} 个指标，${(data.roots || []).join(', ')}`;
  if (data.type === 'start') return data.message || 'Agent 开始采集';
  if (data.type === 'indicator_start') return `开始分析指标 ${indicator}（${data.index}/${data.total}）`;
  if (data.type === 'knowledge') return `知识库候选：${indicator} 找到 ${data.count || 0} 条`;
  if (data.type === 'model_step') return `模型决策：${indicator} 第 ${data.step}/${data.maxSteps} 步`;
  if (data.type === 'tool_call') return `调用工具 ${data.tool}：${data.thought || '准备获取证据'}`;
  if (data.type === 'tool_result') return `工具结果 ${data.tool}：${data.summary || (data.success ? '成功' : '失败')}`;
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

function finishAgentAnswer(answer) {
  const text = String(answer || '').trim();
  if (!text) return;
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
    '#agentMaxSteps',
    '#agentMaxDuration',
    '#agentMaxCandidates',
    '#agentMaxResultChars',
    '#agentProvider',
    '#agentBaseUrl',
    '#agentModelName',
    '#agentApiKey',
    '#agentOutputMode',
    '#agentProfileInput',
    '#btnResetAgentProfile',
    '#btnAgentTest',
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

function readNumberInput(selector, fallback) {
  const value = Number($(selector)?.value);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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

    return `
      <tr>
        <td>${index + 1}</td>
        <td class="indicator-cell"><strong>${escapeHtml(r.indicator || '')}</strong></td>
        <td>${escapeHtml(r.value || '-')}</td>
        <td class="file-path-full" title="${escapeHtml(filePath)}">${escapeHtml(filePath || '-')}</td>
        <td class="keyword-cell">${r.matchedKeyword ? `<code>${escapeHtml(r.matchedKeyword)}</code>` : '<span class="text-muted">-</span>'}</td>
        <td class="keyword-meaning-cell">${keywordMeaning ? escapeHtml(keywordMeaning) : '<span class="text-muted">-</span>'}</td>
        <td class="match-line-cell">${evidence ? escapeHtml(evidence) : '<span class="text-muted">-</span>'}</td>
        <td><span class="confidence ${confidenceClass}">${confidence}%</span></td>
        <td><span class="agent-status-badge agent-status-${escapeHtml(status)}">${escapeHtml(statusText)}</span></td>
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
    verified: '已验证'
  };
  map.needs_tool = '需要工具';
  map.needs_review = '待确认';
  return map[status] || status || '-';
}

function scrollScanProgressToBottom() {
  const fileList = $('#scanFileList');
  const bottomBtn = $('#btnScanScrollBottom');
  if (!fileList || !state.scanFollowBottom) {
    if (bottomBtn) bottomBtn.style.display = 'block';
    return;
  }

  fileList.scrollTop = fileList.scrollHeight;
  if (bottomBtn) bottomBtn.style.display = 'none';
}

// 添加 AI 思考过程条目
function addAiThinkingEntry(icon, text, type) {
  const list = $('#aiThinkingList');
  if (!list) return;

  const entry = document.createElement('div');
  entry.className = `ai-thinking-entry ai-thinking-${type}`;
  
  entry.innerHTML = `
    <span class="ai-thinking-icon">${icon}</span>
    <span class="ai-thinking-text">${text}</span>
  `;
  
  list.appendChild(entry);
  
  // 自动滚动到底部
  scrollAiThinkingToBottom();
}

function appendAiThinkingDelta(indicator, content) {
  if (!content) return;
  const card = ensureAiIndicatorCard(indicator);
  const rawEl = card.querySelector('.ai-raw-output');
  rawEl.textContent += content;
  updateAiSummaryFromRaw(card);
  scrollAiThinkingToBottom();
}

function ensureAiIndicatorCard(indicator) {
  const list = $('#aiThinkingList');
  const safeKey = makeAiKey(indicator);
  let card = list.querySelector(`[data-ai-indicator="${safeKey}"]`);
  if (card) return card;

  card = document.createElement('div');
  card.className = 'ai-indicator-card status-running';
  card.dataset.aiIndicator = safeKey;
  card.innerHTML = `
    <div class="ai-card-head">
      <div>
        <div class="ai-card-title">${escapeHtml(indicator || '未知指标')}</div>
        <div class="ai-card-subtitle">等待 AI 输出</div>
      </div>
      <span class="ai-card-status">分析中</span>
    </div>
    <div class="ai-card-summary"></div>
    <div class="ai-card-fields">
      <span>参考文件: <b data-ai-field="filePattern">-</b></span>
      <span>关键字: <b data-ai-field="keyword">-</b></span>
      <span>备用: <b data-ai-field="synonyms">-</b></span>
      <span>含义: <b data-ai-field="keywordMeaning">-</b></span>
    </div>
    <details class="ai-card-details">
      <summary>查看完整输出</summary>
      <pre class="ai-raw-output"></pre>
    </details>
  `;
  list.appendChild(card);
  return card;
}

function updateAiIndicatorCard(indicator, status, data = {}) {
  const card = ensureAiIndicatorCard(indicator);
  card.classList.remove('status-running', 'status-success', 'status-error', 'status-warning');
  card.classList.add(`status-${status}`);

  const statusText = {
    running: '分析中',
    success: '已完成',
    error: '失败',
    warning: '需检查'
  }[status] || status;

  card.querySelector('.ai-card-status').textContent = statusText;
  if (data.subtitle) card.querySelector('.ai-card-subtitle').textContent = data.subtitle;
  if (data.filePattern !== undefined) card.querySelector('[data-ai-field="filePattern"]').textContent = data.filePattern || '-';
  if (data.keyword !== undefined) card.querySelector('[data-ai-field="keyword"]').textContent = data.keyword || '-';
  if (data.synonyms !== undefined) card.querySelector('[data-ai-field="synonyms"]').textContent = Array.isArray(data.synonyms) ? data.synonyms.join(', ') || '-' : data.synonyms || '-';
  if (data.keywordMeaning !== undefined) card.querySelector('[data-ai-field="keywordMeaning"]').textContent = data.keywordMeaning || '-';
  if (data.message) card.querySelector('.ai-card-summary').textContent = compactAiSummary(data.message);
  if (data.summary) card.querySelector('.ai-card-summary').textContent = compactAiSummary(data.summary);
  scrollAiThinkingToBottom();
}

function updateAiSummaryFromRaw(card) {
  const raw = card.querySelector('.ai-raw-output').textContent;
  card.querySelector('.ai-card-summary').textContent = compactAiSummary(raw) || '正在接收模型输出...';
}

function compactAiSummary(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';

  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('{') && !line.startsWith('"') && !line.startsWith('}') && !line.startsWith('```'))
    .map(line => line.replace(/^分析[:：]\s*/, ''))
    .filter(line => line.length > 0)
    .slice(0, 3);

  const summary = lines.join('\n') || raw.replace(/\s+/g, ' ');
  return summary.length > 180 ? `${summary.slice(0, 180)}...` : summary;
}

function sanitizeEnglishKeyword(value) {
  const text = String(value || '').trim();
  if (!text || /[^\x00-\x7F]/.test(text)) return '';
  return text.replace(/[^A-Za-z0-9_.:\-\s]/g, '').trim();
}

function sanitizeEnglishKeywordList(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,；，]/);
  return [...new Set(list.map(sanitizeEnglishKeyword).filter(Boolean))];
}

function makeAiKey(value) {
  return btoa(unescape(encodeURIComponent(value || 'unknown'))).replace(/=+$/g, '');
}

function scrollAiThinkingToBottom() {
  const container = $('.ai-thinking-container');
  const bottomBtn = $('#btnAiScrollBottom');
  if (!container || !state.aiFollowBottom) {
    if (bottomBtn) bottomBtn.style.display = 'block';
    return;
  }

  container.scrollTop = container.scrollHeight;
  if (bottomBtn) bottomBtn.style.display = 'none';
}

function renderTraditionalResults(results, scanLog) {
  $('#panel-result').style.display = 'block';

  // 统计卡片
  $('#statTotal').textContent = scanLog.total_indicators;
  $('#statSuccess').textContent = scanLog.success_count;
  $('#statFail').textContent = scanLog.fail_count;
  $('#statTime').textContent = scanLog.duration + 's';

  // 按指标分组
  const groupedResults = [];
  let currentIndicator = null;
  let currentGroup = null;

  for (const r of results) {
    if (r.indicator !== currentIndicator) {
      if (currentGroup) groupedResults.push(currentGroup);
      currentIndicator = r.indicator;
      currentGroup = { indicator: r.indicator, rows: [r] };
    } else {
      currentGroup.rows.push(r);
    }
  }
  if (currentGroup) groupedResults.push(currentGroup);

  // 结果表格
  const tbody = $('#resultTable tbody');
  let rowNumber = 1;
  tbody.innerHTML = groupedResults.map(group => {
    return group.rows.map((r, idx) => {
      const keywordMeaning = r.keywordMeaning || r.keyword_meaning || '';
      
      // 匹配类型标签
      const matchTypeBadge = r.matchType === 'partial' 
        ? '<span class="match-type-badge partial">部分匹配</span>'
        : r.matchType === 'exact'
        ? '<span class="match-type-badge exact">精确匹配</span>'
        : '';

      // 匹配关键字列：显示关键字 + 匹配类型（部分匹配显示匹配的单词）
      let keywordDisplay = '<span class="text-muted">-</span>';
      if (r.matchedKeyword) {
        let keywordHtml = `<code>${escapeHtml(r.matchedKeyword)}</code>`;
        // 部分匹配时显示匹配的单词
        if (r.matchType === 'partial' && r.matchedWord && r.matchedWord !== r.matchedKeyword) {
          keywordHtml += `<div class="matched-word-arrow">→</div><code class="matched-word">${escapeHtml(r.matchedWord)}</code>`;
        }
        keywordDisplay = `<div class="keyword-cell">${keywordHtml}${matchTypeBadge}</div>`;
      }

      // 匹配行内容：显示行号 + 完整行内容（高亮实际匹配的单词）
      let matchLineDisplay = '<span class="text-muted">-</span>';
      if (r.match_line) {
        let highlightedLine = escapeHtml(r.match_line);
        // 高亮实际匹配的单词（部分匹配用 matchedWord，精确匹配用 matchedKeyword）
        const highlightWord = (r.matchType === 'partial' && r.matchedWord) ? r.matchedWord : r.matchedKeyword;
        if (highlightWord) {
          const escapedWord = highlightWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const highlightRegex = new RegExp(`(${escapedWord})`, 'gi');
          highlightedLine = highlightedLine.replace(highlightRegex, '<span class="keyword-highlight">$1</span>');
        }
        matchLineDisplay = `<div class="match-line-content"><span class="line-number">第 ${r.line_number} 行:</span> ${highlightedLine}</div>`;
      }

      // 指标列：只有第一行显示，后续行留空
      const indicatorCell = idx === 0 
        ? `<td rowspan="${group.rows.length}" class="indicator-cell"><strong>${escapeHtml(r.indicator || '')}</strong></td>`
        : '';

      // 序号列：只有第一行显示
      const numberCell = idx === 0 ? `<td rowspan="${group.rows.length}">${rowNumber}</td>` : '';
      if (idx === 0) rowNumber++;

      return `
        <tr>
          ${numberCell}
          ${indicatorCell}
          <td class="file-path-full" title="${escapeHtml(r.file_path || '')}">${escapeHtml(r.file_path || '-')}</td>
          <td class="keyword-cell">${keywordDisplay}</td>
          <td class="keyword-meaning-cell">${keywordMeaning ? escapeHtml(keywordMeaning) : '<span class="text-muted">-</span>'}</td>
          <td class="match-line-cell">${matchLineDisplay}</td>
        </tr>
      `;
    }).join('');
  }).join('');

  // 滚动到结果区域
  $('#panel-result').scrollIntoView({ behavior: 'smooth' });
}

// ============ 辅助函数 ============
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

  if (!state.templateRules || state.templateRules.length === 0) {
    showToast('没有可保存的采集规则', 'error');
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
        rules: state.templateRules.map(r => ({
          indicator: r.indicator,
          filePattern: r.file_pattern || r.filePattern || '',
          keyword: r.keyword,
          synonyms: Array.isArray(r.synonyms) ? r.synonyms.join(';') : (r.synonyms || ''),
          keywordMeaning: r.keywordMeaning || r.keyword_meaning || '',
          actualPath: r.actualPath || '',
          confidence: r.confidence || 0
        })),
        successRate: Math.round((state.templateRules.filter(r => (r.confidence || 0) >= 80).length / Math.max(state.templateRules.length, 1)) * 100)
      })
    });
    const data = await res.json();

    if (data.success) {
      showToast('经验已保存到经验库', 'success');
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

async function legacyImportSelectedRawExperience() {
  if (!state.rawExperienceImportFile) {
    chooseRawExperienceFile();
    return;
  }

  const vendor = $('#rawExpVendor')?.value.trim() || '';
  const deviceType = $('#rawExpDeviceType')?.value.trim() || '';
  const model = $('#rawExpModel')?.value.trim() || '';
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

    const form = new FormData();
    form.append('file', state.rawExperienceImportFile);
    form.append('vendor', vendor);
    form.append('deviceType', deviceType);
    form.append('model', model);
    form.append('generateCandidates', 'true');
    const aiOptions = getAgentAIOptions();
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

    let message = `已导入 ${data.count || 0} 条旧表记录`;
    if (shouldGenerate && data.count > 0) {
      const generated = await generateKnowledgeCandidatesFromImport({
        vendor,
        deviceType,
        model,
        limit: data.count
      });
      if (generated.success) {
        message += `，生成候选规则 ${generated.count || 0} 条`;
        if (generated.failCount) message += `，失败 ${generated.failCount} 条`;
      } else {
        message += '，候选规则生成失败';
        showToast('旧表已导入，但候选规则生成失败: ' + (generated.error || ''), 'warning');
      }
    }

    showToast(message, 'success');
    closeImportRawExperienceModal();
    loadExperienceRecords();
  } catch (error) {
    showToast('导入失败: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '选择并导入';
    }
  }
}

async function importSelectedRawExperience() {
  if (!state.rawExperienceImportFile) {
    chooseRawExperienceFile();
    return;
  }

  const vendor = $('#rawExpVendor')?.value.trim() || '';
  const deviceType = $('#rawExpDeviceType')?.value.trim() || '';
  const model = $('#rawExpModel')?.value.trim() || '';

  if (!vendor || !deviceType) {
    showToast('请填写厂商和设备类型', 'warning');
    return;
  }

  const btn = $('#btnConfirmImportRawExperience');
  const oldText = btn?.textContent || '';
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = '导入并生成知识规则...';
    }

    const aiOptions = getAgentAIOptions();
    const form = new FormData();
    form.append('file', state.rawExperienceImportFile);
    form.append('vendor', vendor);
    form.append('deviceType', deviceType);
    form.append('model', model);
    form.append('generateCandidates', 'true');
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

    showKnowledgeGenerationToast({
      action: '导入',
      savedCount: data.count || 0,
      generatedCount: data.generatedCount || 0,
      failCount: data.generateFailCount || 0,
      failureSummary: data.failureSummary || data.failures || []
    });
    closeImportRawExperienceModal();
    loadExperienceRecords();
  } catch (error) {
    showToast('导入失败: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = oldText || '选择并导入';
    }
  }
}

async function generateKnowledgeCandidatesFromImport({ vendor, deviceType, model, limit }) {
  const aiOptions = getAgentAIOptions();
  if (aiOptions.provider !== 'ollama' && !aiOptions.apiKey) {
    return { success: false, error: '未输入 API Key' };
  }

  try {
    const res = await fetch('/api/v1/knowledge-candidates/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        deviceType,
        model,
        limit: Math.min(Math.max(Number(limit) || 10, 1), 200),
        provider: aiOptions.provider,
        backend: aiOptions.backend,
        baseUrl: aiOptions.baseUrl,
        apiKey: aiOptions.apiKey,
        aiModel: aiOptions.model
      })
    });
    return await res.json();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function showKnowledgeGenerationToast({ action, savedCount, generatedCount, failCount, failureSummary }) {
  const summary = formatKnowledgeFailureSummary(failureSummary);
  let message = `旧表已${action} ${savedCount || 0} 条。`;
  message += `知识规则自动提炼成功 ${generatedCount || 0} 条`;
  if (failCount) {
    message += `，失败 ${failCount} 条`;
    if (summary) message += `。主要原因：${summary}`;
  }
  showToast(message, failCount ? 'warning' : 'success');
}

function formatKnowledgeFailureSummary(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length === 0) return '';

  const normalized = list.map(item => {
    if (typeof item === 'string') return { reason: item, count: 1 };
    return {
      reason: item.reason || item.error || '未知错误',
      count: Number(item.count || 1)
    };
  });

  const grouped = new Map();
  for (const item of normalized) {
    const reason = normalizeKnowledgeFailureReason(item.reason);
    grouped.set(reason, (grouped.get(reason) || 0) + item.count);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([reason, count]) => `${reason} ${count} 条`)
    .join('；');
}

function normalizeKnowledgeFailureReason(reason) {
  const text = String(reason || '').trim();
  if (!text) return '未知错误';
  if (/api key|unauthorized|401|403|未输入|未提供/i.test(text)) return 'API Key 未配置或无效';
  if (/not found|model.*not|模型.*不存在|未安装模型|404/i.test(text)) return '模型名称不正确或本地模型未安装';
  if (/timeout|timed out|超时/i.test(text)) return '模型响应超时';
  if (/json|有效 JSON|格式/i.test(text)) return '模型没有按 JSON 格式返回';
  if (/fetch|connect|ECONNREFUSED|ENOTFOUND|network|连接/i.test(text)) return '模型服务连接失败';
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

async function generateKnowledgeCandidatesForRawIds(rawExperienceIds = []) {
  const ids = rawExperienceIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return { success: true, count: 0, failCount: 0 };

  const aiOptions = getAgentAIOptions();
  try {
    const res = await fetch('/api/v1/knowledge-candidates/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawExperienceIds: ids,
        limit: Math.min(ids.length, 200),
        provider: aiOptions.provider,
        backend: aiOptions.backend,
        baseUrl: aiOptions.baseUrl,
        apiKey: aiOptions.apiKey,
        aiModel: aiOptions.model
      })
    });
    return await res.json();
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============ 经验库面板 ============
async function toggleExperiencePanel() {
  const panel = $('#experiencePanel');
  if (!panel) return;
  
  // 滚动到经验库面板
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // 刷新经验库列表
  await loadExperienceList();
}

async function loadExperienceList() {
  try {
    const res = await fetch('/api/v1/experience/list');
    const data = await res.json();

    if (!data.success) return;

    renderExperienceList(data.records);
  } catch (e) {
    console.error('加载经验列表失败:', e);
  }
}

// ============ AI 智能补全 ============
async function aiAutoFill() {
  if (state.aiLoading) return;  // 防止重复点击
  
  // 检查是否在编辑经验库模式
  if (state.editingExperienceId) {
    showToast('编辑经验库时不能使用AI补全', 'warning');
    return;
  }
  
  if (!state.templateRules.length) {
    showToast('请先上传模板', 'error');
    return;
  }

  const vendor = $('#vendorInput').value;
  const deviceType = $('#deviceTypeInput').value;

  if (!vendor || !deviceType) {
    showToast('请先选择厂商和设备类型', 'error');
    return;
  }

  // 设置加载状态
  state.aiLoading = true;
  state.aiAbortController = new AbortController();
  const btn = $('#btnAiFill');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'AI 补全中...';
  }
  const btnStop = $('#btnStopAiFill');
  if (btnStop) btnStop.style.display = 'inline-flex';
  
  // 锁定表格和上传区域
  const templatePreview = $('#templatePreview');
  if (templatePreview) templatePreview.style.pointerEvents = 'none';
  const uploadZone = $('#uploadZone');
  if (uploadZone) uploadZone.style.pointerEvents = 'none';
  const btnAddRule = $('#btnAddRule');
  if (btnAddRule) btnAddRule.disabled = true;
  
  // 禁用开始采集按钮
  const btnStartCollect = $('#btnStartCollect');
  if (btnStartCollect) btnStartCollect.disabled = true;

  // 显示 AI 思考过程面板
  const aiThinkingPanel = $('#panel-ai-thinking');
  if (aiThinkingPanel) {
    aiThinkingPanel.style.display = 'block';
    $('#aiThinkingList').innerHTML = '';
    $('#aiThinkingStatus').textContent = '连接中...';
    state.aiFollowBottom = true;
    const bottomBtn = $('#btnAiScrollBottom');
    if (bottomBtn) bottomBtn.style.display = 'none';
  }

  // 连接 AI 思考过程 SSE
  let aiThinkingEventSource = null;

  try {
    // 等待 SSE 连接建立
    aiThinkingEventSource = new EventSource('/api/v1/ai-thinking-stream');
    
    await new Promise((resolve, reject) => {
      aiThinkingEventSource.onopen = () => {
        console.log('[AI SSE] 连接已建立');
        $('#aiThinkingStatus').textContent = '已连接';
        resolve();
      };
      
      aiThinkingEventSource.onerror = (err) => {
        console.error('[AI SSE] 连接错误:', err);
        $('#aiThinkingStatus').textContent = '连接失败';
        reject(new Error('AI SSE 连接失败'));
      };
      
      setTimeout(() => {
        reject(new Error('AI SSE 连接超时'));
      }, 5000);
    });

    aiThinkingEventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'start') {
        $('#aiThinkingStatus').textContent = '思考中...';
        addAiThinkingEntry('🤖', `开始分析 ${data.message}`, 'info');
      } else if (data.type === 'analyzing') {
        $('#aiThinkingStatus').textContent = `正在补全 ${data.progress}：${data.indicator}`;
        updateAiIndicatorCard(data.indicator, 'running', { subtitle: `第 ${data.progress} 个指标` });
      } else if (data.type === 'thinking') {
        updateAiIndicatorCard(data.indicator, 'running', { message: data.message });
      } else if (data.type === 'delta') {
        appendAiThinkingDelta(data.indicator, data.content);
      } else if (data.type === 'success') {
        updateAiIndicatorCard(data.indicator, 'success', {
          subtitle: '补全完成',
          keyword: data.keyword,
          synonyms: data.synonyms || [],
          filePattern: data.filePattern,
          keywordMeaning: data.keywordMeaning || '',
          summary: data.summary
        });
      } else if (data.type === 'warning') {
        updateAiIndicatorCard(data.indicator, 'warning', { subtitle: '需要检查', message: data.message, summary: data.summary });
      } else if (data.type === 'error') {
        updateAiIndicatorCard(data.indicator, 'error', { subtitle: '补全失败', message: data.message, summary: data.summary });
      } else if (data.type === 'complete') {
        $('#aiThinkingStatus').textContent = '已完成';
        addAiThinkingEntry('🎉', data.message, data.failCount > 0 ? 'info' : 'success');
      }
    };

    // 先尝试从经验库匹配
    const expRes = await fetch(`/api/v1/experience/match?vendor=${encodeURIComponent(vendor)}&deviceType=${encodeURIComponent(deviceType)}`, {
      signal: state.aiAbortController.signal
    });
    const expData = await expRes.json();

    if (expData.success && expData.records && expData.records.length > 0) {
      // 有经验记录，使用历史记录补全（只填充空白字段，原有值优先）
      const matchedRules = expData.records[0].rules;
      const filledRules = state.templateRules.map(rule => {
        const matched = matchedRules.find(r => r.indicator === rule.indicator);
        if (matched) {
          return {
              ...rule,
              filePattern: rule.filePattern || matched.filePattern || '',
              keyword: rule.keyword || sanitizeEnglishKeyword(matched.keyword) || '',
              synonyms: (rule.synonyms && rule.synonyms.length > 0) ? sanitizeEnglishKeywordList(rule.synonyms) : sanitizeEnglishKeywordList(matched.synonyms || []),
              keywordMeaning: rule.keywordMeaning || matched.keywordMeaning || matched.keyword_meaning || ''
            };
        }
        return rule;
      });

      state.templateRules = filledRules;
      renderTemplatePreview();
      showToast(`已从经验库补全 ${filledRules.filter(r => r.keyword).length} 条规则`, 'success');
    } else {
      // 无经验记录，使用 AI 生成
      const agentOptions = getAgentAIOptions();
      const selectedModel = agentOptions.provider === 'ollama'
        ? ($('#aiModelSelect')?.value || agentOptions.model || '')
        : (agentOptions.model || $('#aiModelSelect')?.value || '');
      const selectedBackend = document.querySelector('input[name="aiEngine"]:checked')?.value || 'ollama';
      const res = await fetch('/api/v1/ai/autofill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: state.aiAbortController.signal,
        body: JSON.stringify({
          indicators: state.templateRules.map(r => r.indicator),
          vendor,
          deviceType,
          model: selectedModel,
          backend: agentOptions.backend || selectedBackend,
          provider: agentOptions.provider || selectedBackend,
          baseUrl: agentOptions.baseUrl || '',
          apiKey: agentOptions.apiKey || ''
        })
      });
      const data = await res.json();

      if (data.success) {
        // 只填充空白字段，不覆盖原有数据（原有值优先）
        state.templateRules = state.templateRules.map((rule, i) => {
          const aiRule = data.rules[i];
          if (aiRule) {
            return {
              ...rule,
              filePattern: rule.filePattern || aiRule.filePattern || aiRule.file_pattern || '',
              keyword: rule.keyword || sanitizeEnglishKeyword(aiRule.keyword) || '',
              synonyms: (rule.synonyms && rule.synonyms.length > 0) ? sanitizeEnglishKeywordList(rule.synonyms) : sanitizeEnglishKeywordList(aiRule.synonyms || []),
              keywordMeaning: rule.keywordMeaning || aiRule.keywordMeaning || aiRule.keyword_meaning || ''
            };
          }
          return rule;
        });
        renderTemplatePreview();
        const failCount = data.failures?.length || 0;
        showToast(`AI 已补全 ${data.rules.filter(r => r.keyword || r.filePattern).length} 条规则，失败 ${failCount} 条`, failCount ? 'warning' : 'success');
      } else {
        showToast('AI 补全失败: ' + data.error, 'error');
      }
    }
  } catch (e) {
    const aborted = e.name === 'AbortError';
    $('#aiThinkingStatus').textContent = aborted ? '已停止' : '失败';
    showToast(aborted ? 'AI 补全已停止' : 'AI 补全失败: ' + e.message, aborted ? 'info' : 'error');
  } finally {
    // 关闭 AI SSE 连接
    if (aiThinkingEventSource) {
      aiThinkingEventSource.close();
    }

    state.aiLoading = false;
    state.aiAbortController = null;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'AI 智能补全';
    }
    if (btnStop) btnStop.style.display = 'none';
    // 解锁表格和上传区域
    const templatePreview = $('#templatePreview');
    if (templatePreview) templatePreview.style.pointerEvents = '';
    const uploadZone = $('#uploadZone');
    if (uploadZone) uploadZone.style.pointerEvents = '';
    const btnAddRule = $('#btnAddRule');
    if (btnAddRule) btnAddRule.disabled = false;
    
    // 恢复开始采集按钮
    const btnStartCollect = $('#btnStartCollect');
    if (btnStartCollect) {
      btnStartCollect.disabled = !canStartAgentCollect();
    }
  }
}

// ============ 事件绑定 ============
function bindEvents() {
  // 刷新磁盘
  $('#btnRefreshDisks').addEventListener('click', loadDisks);

  // 构建索引
  $('#btnBuildIndex').addEventListener('click', buildIndex);

  // 下载模板示例
  $('#btnDownloadExample').addEventListener('click', () => {
    window.open('/api/v1/template/example', '_blank');
  });

  // 添加规则行
  $('#btnAddRule').addEventListener('click', addRuleRow);

  // AI智能补全
  const btnAiFill = $('#btnAiFill');
  if (btnAiFill) {
    btnAiFill.addEventListener('click', aiAutoFill);
  }

  const btnStopAiFill = $('#btnStopAiFill');
  if (btnStopAiFill) {
    btnStopAiFill.addEventListener('click', stopAiAutoFill);
  }

  const aiThinkingContainer = $('.ai-thinking-container');
  if (aiThinkingContainer) {
    aiThinkingContainer.addEventListener('scroll', () => {
      const distanceToBottom = aiThinkingContainer.scrollHeight - aiThinkingContainer.scrollTop - aiThinkingContainer.clientHeight;
      state.aiFollowBottom = distanceToBottom < 80;
      const bottomBtn = $('#btnAiScrollBottom');
      if (bottomBtn) bottomBtn.style.display = state.aiFollowBottom ? 'none' : 'block';
    });
  }

  const btnAiScrollBottom = $('#btnAiScrollBottom');
  if (btnAiScrollBottom) {
    btnAiScrollBottom.addEventListener('click', () => {
      state.aiFollowBottom = true;
      scrollAiThinkingToBottom();
    });
  }

  const scanFileList = $('#scanFileList');
  if (scanFileList) {
    scanFileList.addEventListener('scroll', () => {
      const distanceToBottom = scanFileList.scrollHeight - scanFileList.scrollTop - scanFileList.clientHeight;
      state.scanFollowBottom = distanceToBottom < 80;
      const bottomBtn = $('#btnScanScrollBottom');
      if (bottomBtn) bottomBtn.style.display = state.scanFollowBottom ? 'none' : 'block';
    });
  }

  const btnScanScrollBottom = $('#btnScanScrollBottom');
  if (btnScanScrollBottom) {
    btnScanScrollBottom.addEventListener('click', () => {
      state.scanFollowBottom = true;
      scrollScanProgressToBottom();
    });
  }

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

  // 设备型号选择（如果存在）
  const deviceSelect = $('#deviceSelect');
  if (deviceSelect) {
    deviceSelect.addEventListener('change', (e) => {
      const deviceId = e.target.value;
      if (deviceId) {
        loadDeviceTemplate(deviceId);
      }
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

  // AI 引擎切换
  document.querySelectorAll('input[name="aiEngine"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const provider = $('#agentProvider');
      if (provider) {
        provider.value = e.target.value === 'ollama' ? 'ollama' : 'deepseek';
        applyAgentProviderDefaults(provider.value);
      }
      const modelSelect = $('#aiModelSelect');
      if (e.target.value === 'deepseek') {
        if (modelSelect) {
          modelSelect.innerHTML = '<option value="deepseek-chat">deepseek-chat</option>';
          modelSelect.disabled = true;
        }
      } else {
        if (modelSelect) {
          modelSelect.disabled = false;
          modelSelect.innerHTML = '<option value="">加载中...</option>';
        }
      }
      checkAiStatus();
    });
  });

  // 初始化 AI 状态
  bindAgentApiConfig();
  checkAiStatus();

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

function stopAiAutoFill() {
  if (!state.aiLoading || !state.aiAbortController) return;
  state.aiAbortController.abort();
  $('#aiThinkingStatus').textContent = '正在停止...';
}

function stopCollection() {
  if (!state.collectAbortController) return;
  state.collectAbortController.abort();
  addAgentMessage('muted', '正在停止当前 Agent 采集...');
}

// ==================== AI 功能 ====================

function bindAgentApiConfig() {
  const providerSelect = $('#agentProvider');
  const baseUrlInput = $('#agentBaseUrl');
  const modelInput = $('#agentModelName');
  const apiKeyInput = $('#agentApiKey');
  const outputModeSelect = $('#agentOutputMode');
  const btnTest = $('#btnAgentTest');

  if (!providerSelect || !baseUrlInput || !modelInput || !apiKeyInput) return;

  providerSelect.addEventListener('change', () => {
    applyAgentProviderDefaults(providerSelect.value);
    syncAiEngineFromAgentProvider();
  });

  [baseUrlInput, modelInput, apiKeyInput, outputModeSelect].filter(Boolean).forEach(input => {
    input.addEventListener('input', () => {
      state.agentConfig = readAgentConfigForm();
    });
  });

  if (btnTest) btnTest.addEventListener('click', testAgentConnection);
  loadAgentConfig();
}

async function loadAgentConfig() {
  try {
    const res = await fetch('/api/v1/agent/config');
    const data = await res.json();
    if (data.success && data.config) {
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
  const baseUrl = $('#agentBaseUrl');
  const model = $('#agentModelName');
  const outputMode = $('#agentOutputMode');
  const providerValue = config.provider || provider?.value || 'ollama';
  if (provider && config.provider) provider.value = config.provider;
  if (baseUrl) baseUrl.value = config.baseUrl || defaultAgentBaseUrl(providerValue);
  if (model) {
    const modelValue = providerValue === 'ollama' && isCloudDefaultModel(config.model) ? '' : (config.model || defaultAgentModel(providerValue));
    model.value = modelValue;
  }
  if (outputMode) outputMode.value = config.outputMode || 'auto';
  setAgentStatus(config.hasApiKey ? '已配置 Key' : '未配置 Key', config.hasApiKey ? 'success' : 'info');
}

function readAgentConfigForm() {
  const provider = $('#agentProvider')?.value || 'ollama';
  return {
    provider,
    backend: provider,
    baseUrl: $('#agentBaseUrl')?.value.trim() || defaultAgentBaseUrl(provider),
    model: $('#agentModelName')?.value.trim() || defaultAgentModel(provider),
    apiKey: $('#agentApiKey')?.value.trim() || '',
    outputMode: $('#agentOutputMode')?.value || 'auto'
  };
}

function applyAgentProviderDefaults(provider) {
  const baseUrl = $('#agentBaseUrl');
  const model = $('#agentModelName');
  if (baseUrl) baseUrl.value = defaultAgentBaseUrl(provider);
  if (model) model.value = defaultAgentModel(provider);
  state.agentConfig = readAgentConfigForm();
  setAgentStatus('未测试', 'info');
}

function syncAiEngineFromAgentProvider() {
  const provider = $('#agentProvider')?.value || 'ollama';
  const engine = provider === 'ollama' ? 'ollama' : 'deepseek';
  const radio = document.querySelector(`input[name="aiEngine"][value="${engine}"]`);
  if (radio) radio.checked = true;
}

function getAgentAIOptions() {
  state.agentConfig = readAgentConfigForm();
  return state.agentConfig;
}

async function testAgentConnection() {
  const btn = $('#btnAgentTest');
  const config = readAgentConfigForm();
  state.agentConfig = config;

  if (config.provider !== 'ollama' && !config.apiKey) {
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
      setAgentStatus(`连接成功：${data.model || config.model || config.provider}`, 'success');
      showToast('API 模型连接成功', 'success');
      checkAiStatus();
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
  const map = {
    ollama: 'http://localhost:11434',
    custom: 'https://api.deepseek.com'
  };
  return map[provider] || '';
}

function defaultAgentModel(provider) {
  const map = {
    custom: 'deepseek-chat'
  };
  return map[provider] || '';
}

function isCloudDefaultModel(model) {
  return ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'gpt-4o'].includes(String(model || '').trim());
}

async function checkAiStatus() {
  const dot = $('#aiStatusDot');
  const text = $('#aiStatusText');
  let selectedBackend = document.querySelector('input[name="aiEngine"]:checked')?.value || 'ollama';

  try {
    const res = await fetch('/api/v1/ai/status');
    const data = await res.json();
    if (data.agentConfig) {
      renderAgentConfig(data.agentConfig);
      syncAiEngineFromAgentProvider();
      selectedBackend = document.querySelector('input[name="aiEngine"]:checked')?.value || selectedBackend;
    }

    if (selectedBackend === 'ollama') {
      await loadOllamaModels();
    } else {
      const select = $('#aiModelSelect');
      if (select) {
        select.innerHTML = '<option value="deepseek-chat">deepseek-chat</option>';
        select.disabled = true;
      }
    }

    if (dot && text) {
      if (selectedBackend === 'ollama' && data.ollama && data.ollama.available) {
        dot.className = 'status-dot connected';
        text.textContent = 'Ollama 已连接';
      } else if (selectedBackend !== 'ollama' && data.agentConfig && data.agentConfig.hasApiKey) {
        dot.className = 'status-dot connected';
        text.textContent = `${data.agentConfig.provider || 'API'} 已配置`;
      } else if (selectedBackend === 'deepseek' && data.deepseek && data.deepseek.available) {
        dot.className = 'status-dot connected';
        text.textContent = 'DeepSeek 已连接';
      } else {
        dot.className = 'status-dot error';
        text.textContent = selectedBackend === 'ollama' ? 'Ollama 不可用' : 'DeepSeek 未配置';
      }
    }
  } catch {
    const select = $('#aiModelSelect');
    if (select) {
      select.innerHTML = '<option value="">无法获取模型状态</option>';
    }
    if (dot && text) {
      dot.className = 'status-dot error';
      text.textContent = '无法连接 AI 服务';
    }
  }
}

async function loadOllamaModels() {
  const select = $('#aiModelSelect');
  if (!select) return;

  try {
    const res = await fetch('/api/v1/ai/models');
    const data = await res.json();

    if (data.success && data.models.length > 0) {
      // 清空现有选项
      select.innerHTML = '';
      // 添加本地模型
      data.models.forEach((model, index) => {
        const option = document.createElement('option');
        option.value = model.name;
        option.textContent = `${model.name} (${model.size})`;
        if (index === 0) option.selected = true;
        select.appendChild(option);
      });
    } else {
      // Ollama 无模型，显示提示
      select.innerHTML = '<option value="">Ollama 中暂无模型，请先安装</option>';
    }
  } catch {
    select.innerHTML = '<option value="">无法获取模型列表</option>';
  }
}

function getSelectedEngine() {
  return document.querySelector('input[name="aiEngine"]:checked').value;
}

function getSelectedModel() {
  return $('#aiModelSelect').value;
}

function showAiInput(title, contentHtml) {
  $('#aiInputTitle').textContent = title;
  $('#aiInputContent').innerHTML = contentHtml;
  $('#aiInputArea').style.display = 'block';
  $('#aiOutput').innerHTML = '';
}

function closeAiInput() {
  $('#aiInputArea').style.display = 'none';
}

function showAiLoading(message) {
  $('#aiOutput').innerHTML = `
    <div class="ai-loading">
      <div class="spinner"></div>
      <span>${message}</span>
    </div>
  `;
}

function showAiError(title, message) {
  $('#aiOutput').innerHTML = `
    <div class="ai-error">
      <div class="ai-error-title">❌ ${title}</div>
      <p>${message}</p>
    </div>
  `;
}

// AI 参数匹配
async function handleAiMatch() {
  const selectedDisks = getSelectedDisks();
  if (selectedDisks.length === 0) {
    showToast('请先选择磁盘', 'error');
    return;
  }

  showAiInput('AI 参数匹配', `
    <p style="color:#64748b;font-size:13px;margin:0 0 12px 0;">
      输入未匹配到的指标名称和关键词，AI 将分析日志内容尝试匹配
    </p>
    <input type="text" class="ai-textarea" id="aiMatchIndicator" placeholder="指标名称，如：磁体压力" style="margin-bottom:8px;">
    <input type="text" class="ai-textarea" id="aiMatchKeyword" placeholder="模板关键词，如：Magnet Pressure" style="margin-bottom:8px;">
    <div class="ai-submit-row">
      <button class="btn-ai-submit" id="btnAiMatchSubmit" onclick="submitAiMatch()">开始分析</button>
    </div>
  `);
}

async function submitAiMatch() {
  const indicator = $('#aiMatchIndicator').value.trim();
  const keyword = $('#aiMatchKeyword').value.trim();

  if (!indicator || !keyword) {
    showToast('请填写指标名称和关键词', 'error');
    return;
  }

  $('#btnAiMatchSubmit').disabled = true;
  showAiLoading('AI 正在分析日志内容...');

  try {
    const res = await fetch('/api/v1/ai/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        indicator,
        keyword,
        diskRoot: selectedDisks[0],
        engine: getSelectedEngine(),
        model: getSelectedModel()
      })
    });

    const data = await res.json();

    if (data.success && data.result) {
      const r = data.result;
      const confClass = r.confidence >= 80 ? 'high' : r.confidence >= 60 ? 'medium' : 'low';
      $('#aiOutput').innerHTML = `
        <div class="ai-result-card">
          <h4>🎯 匹配结果：${r.indicator}</h4>
          <div class="ai-result-row">
            <span class="ai-result-label">匹配状态</span>
            <span class="ai-result-value">${r.matched ? '✅ 已匹配' : '❌ 未找到'}</span>
          </div>
          <div class="ai-result-row">
            <span class="ai-result-label">实际字段</span>
            <span class="ai-result-value">${r.actualField || '-'}</span>
          </div>
          <div class="ai-result-row">
            <span class="ai-result-label">提取数值</span>
            <span class="ai-result-value">${r.value || '-'}</span>
          </div>
          <div class="ai-result-row">
            <span class="ai-result-label">可信度</span>
            <span class="ai-result-value"><span class="ai-confidence ${confClass}">${r.confidence}%</span></span>
          </div>
          <div class="ai-result-row">
            <span class="ai-result-label">分析依据</span>
            <span class="ai-result-value">${r.reasoning || '-'}</span>
          </div>
        </div>
      `;
    } else {
      showAiError('分析失败', data.error || 'AI 未能返回有效结果');
    }
  } catch (err) {
    showAiError('请求失败', err.message);
  } finally {
    $('#btnAiMatchSubmit').disabled = false;
  }
}

// AI 未知参数发现
async function handleAiDiscover() {
  const selectedDisks = getSelectedDisks();
  if (selectedDisks.length === 0) {
    showToast('请先选择磁盘', 'error');
    return;
  }

  showAiLoading('AI 正在扫描日志并发现未知参数...');

  try {
    const res = await fetch('/api/v1/ai/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diskRoot: selectedDisks[0],
        engine: getSelectedEngine(),
        model: getSelectedModel()
      })
    });

    const data = await res.json();

    if (data.success) {
      if (data.suggestions && data.suggestions.length > 0) {
        let html = '<div class="ai-result-card"><h4>🔬 发现 ' + data.suggestions.length + ' 个潜在参数</h4><ul class="ai-suggestion-list">';
        for (const s of data.suggestions) {
          html += `
            <li class="ai-suggestion-item">
              <span class="ai-suggestion-icon">💡</span>
              <div class="ai-suggestion-content">
                <strong>${s.indicator}</strong>
                <p>关键词：${s.keyword} | 来源：${s.file || '未知'}</p>
                <p>${s.reason || ''}</p>
              </div>
            </li>
          `;
        }
        html += '</ul></div>';
        $('#aiOutput').innerHTML = html;
      } else {
        $('#aiOutput').innerHTML = `
          <div class="ai-result-card">
            <h4> 扫描完成</h4>
            <p style="color:#64748b;font-size:14px;">${data.message || '未发现新的潜在参数'}</p>
          </div>
        `;
      }
    } else {
      showAiError('发现失败', data.error || 'AI 未能返回有效结果');
    }
  } catch (err) {
    showAiError('请求失败', err.message);
  }
}

// AI 智能生成模板
async function handleAiTemplate() {
  showAiInput('智能生成模板', `
    <p style="color:#64748b;font-size:13px;margin:0 0 12px 0;">
      用自然语言描述你想采集的数据，AI 将自动分析日志并生成采集模板
    </p>
    <textarea class="ai-textarea" id="aiTemplateRequest" placeholder="例如：我要采集液氦相关数据，包括液位、压力、温度等" rows="3"></textarea>
    <div class="ai-submit-row">
      <button class="btn-ai-submit" id="btnAiTemplateSubmit" onclick="submitAiTemplate()">生成模板</button>
    </div>
  `);
}

async function submitAiTemplate() {
  const request = $('#aiTemplateRequest').value.trim();

  if (!request) {
    showToast('请描述你的采集需求', 'error');
    return;
  }

  $('#btnAiTemplateSubmit').disabled = true;
  showAiLoading('AI 正在分析需求并生成模板...');

  try {
    const res = await fetch('/api/v1/ai/generate-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userRequest: request,
        diskRoot: getSelectedDisks()[0] || '',
        engine: getSelectedEngine(),
        model: getSelectedModel()
      })
    });

    const data = await res.json();

    if (data.success && data.template) {
      let html = '<div class="ai-result-card"><h4> 生成模板：' + (data.templateName || 'AI 生成模板') + '</h4>';
      html += '<p style="color:#64748b;font-size:13px;margin:8px 0;">共 ' + data.template.length + ' 条采集规则</p>';
      html += '<table class="ai-template-table"><thead><tr><th>指标</th><th>关键词</th><th>参考文件</th><th>类型</th><th>单位</th></tr></thead><tbody>';
      for (const rule of data.template) {
        html += `<tr><td>${rule.indicator}</td><td>${rule.keyword}</td><td>${rule.file_pattern || '-'}</td><td>${rule.dataType || '文本'}</td><td>${rule.unit || '-'}</td></tr>`;
      }
      html += '</tbody></table>';
      if (data.templatePath) {
        html += '<p style="margin-top:12px;font-size:12px;color:#10b981;">✅ 模板已保存：' + data.templatePath + '</p>';
      }
      html += '</div>';
      $('#aiOutput').innerHTML = html;
    } else {
      showAiError('生成失败', data.error || 'AI 未能生成有效模板');
    }
  } catch (err) {
    showAiError('请求失败', err.message);
  } finally {
    $('#btnAiTemplateSubmit').disabled = false;
  }
}

// ==================== 采集经验库 ====================
async function loadExperienceRecords() {
  try {
    const [savedRes, rawRes] = await Promise.all([
      fetch('/api/v1/experience/list'),
      fetch('/api/v1/raw-experience/list?limit=5000')
    ]);
    const savedData = await savedRes.json();
    const rawData = await rawRes.json();
    renderExperienceList(
      savedData.success ? savedData.records : [],
      rawData.success ? rawData.records : []
    );
  } catch (err) {
    console.error('加载经验库失败:', err);
  }
}

function renderExperienceList(records, rawRecords = []) {
  const container = $('#expList');
  if (!container) return;

  const rawGroups = groupRawExperienceRecords(rawRecords);
  if ((!records || records.length === 0) && rawGroups.length === 0) {
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
            ${rec.indicatorCount || 0} 条规则，成功率 ${rec.successRate || 0}%
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

  const rows = (group.records || []).map((record, index) => `
    <tr data-id="${escapeAttr(record.id)}">
      <td>${index + 1}</td>
      <td><input class="raw-exp-input" data-field="indicatorName" value="${escapeAttr(record.indicatorName || '')}"></td>
      <td><input class="raw-exp-input" data-field="indicatorCode" value="${escapeAttr(record.indicatorCode || '')}"></td>
      <td><input class="raw-exp-input" data-field="filePathRaw" value="${escapeAttr(record.filePathRaw || '')}"></td>
      <td><textarea class="raw-exp-input" data-field="keywordMeaningRaw" rows="2">${escapeHtml(record.keywordMeaningRaw || '')}</textarea></td>
    </tr>
  `).join('');

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
        <div class="table-wrapper raw-exp-edit-wrapper">
          <table class="data-table raw-exp-edit-table">
            <thead>
              <tr>
                <th>#</th>
                <th>指标</th>
                <th>指标标识</th>
                <th>文件路径</th>
                <th>关键字及含义</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="closeRawExperienceEditModal()">取消</button>
        <button class="btn btn-primary" onclick="saveRawExperienceGroup('${escapeAttr(groupKey)}')">保存并重新生成规则</button>
      </div>
    </div>
  `;
  modal.style.display = 'flex';
}

function closeRawExperienceEditModal() {
  const modal = $('#rawExperienceEditModal');
  if (modal) modal.style.display = 'none';
}

async function saveRawExperienceGroup(groupKey) {
  const group = window._rawExperienceGroups?.[groupKey];
  const modal = $('#rawExperienceEditModal');
  if (!group || !modal) return;

  const rows = Array.from(modal.querySelectorAll('tbody tr'));
  const updates = rows.map(row => {
    const payload = {};
    row.querySelectorAll('.raw-exp-input').forEach(input => {
      payload[input.dataset.field] = input.value.trim();
    });
    return { id: row.dataset.id, payload };
  }).filter(item => item.id);

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

    const generated = await generateKnowledgeCandidatesForRawIds(updates.map(item => item.id));
    showKnowledgeGenerationToast({
      action: '保存',
      savedCount: updates.length,
      generatedCount: generated.success ? (generated.count || 0) : 0,
      failCount: generated.success ? (generated.failCount || 0) : updates.length,
      failureSummary: generated.success ? (generated.failureSummary || generated.failures || []) : [{ reason: generated.error || '未知错误', count: updates.length }]
    });
    closeRawExperienceEditModal();
    loadExperienceRecords();
  } catch (error) {
    showToast('保存失败: ' + error.message, 'error');
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

async function generateKnowledgeForRawGroup(groupKey) {
  const group = window._rawExperienceGroups?.[groupKey];
  if (!group) {
    showToast('未找到旧表分组', 'error');
    return;
  }
  showToast('正在生成候选规则...', 'info');
  const result = await generateKnowledgeCandidatesFromImport({
    vendor: group.vendor,
    deviceType: group.deviceType,
    model: group.model,
    limit: group.count
  });
  if (result.success) {
    showToast(`候选规则生成完成：${result.count || 0} 条，失败 ${result.failCount || 0} 条`, result.failCount ? 'warning' : 'success');
  } else {
    showToast('候选规则生成失败: ' + (result.error || ''), 'error');
  }
}

async function loadExperience(id) {
  if (state.aiLoading) {
    showToast('AI补全中，请等待完成', 'warning');
    return;
  }
  try {
    const res = await fetch(`/api/v1/experience/${id}`);
    const data = await res.json();
    if (data.success && data.record) {
      const rec = data.record;
      // 填充厂商和设备类型
      if ($('#vendorInput')) $('#vendorInput').value = rec.vendor || '';
      if ($('#deviceTypeInput')) $('#deviceTypeInput').value = rec.deviceType || '';
      // 填充模板规则
      if (rec.rules && rec.rules.length > 0) {
        state.templateRules = rec.rules.map(r => ({
          indicator: r.indicator,
          filePattern: r.filePattern || r.file_pattern || '',
          keyword: r.keyword,
          // 兼容数组和字符串两种格式
          synonyms: Array.isArray(r.synonyms) ? r.synonyms : (typeof r.synonyms === 'string' ? r.synonyms.split(';').map(s => s.trim()).filter(Boolean) : []),
          keywordMeaning: r.keywordMeaning || r.keyword_meaning || ''
        }));
        renderTemplatePreview();
        updateStep(2);
        showToast('已加载采集经验：' + rec.vendor + ' ' + rec.deviceType, 'success');
      }
    }
  } catch (err) {
    showToast('加载失败：' + err.message, 'error');
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
  if (state.aiLoading) {
    showToast('AI补全中，请等待完成', 'warning');
    return;
  }
  try {
    const res = await fetch(`/api/v1/experience/${id}`);
    const data = await res.json();
    if (data.success && data.record) {
      const rec = data.record;
      // 加载到可编辑表格
      state.templateRules = rec.rules || [];
      renderTemplatePreview();
      // 设置厂商和设备类型
      const vendorInput = $('#vendorInput');
      const deviceTypeInput = $('#deviceTypeInput');
      if (vendorInput && rec.vendor) {
        vendorInput.value = rec.vendor;
      }
      if (deviceTypeInput && rec.deviceType) {
        deviceTypeInput.value = rec.deviceType;
      }
      // 记录当前编辑的经验ID
      state.editingExperienceId = id;
      // 显示保存修改按钮
      showSaveEditButton(id, rec);
      showToast('已加载到表格，可直接编辑后保存', 'info');
      // 滚动到模板预览区域
      $('#templatePreview').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    showToast('加载失败：' + err.message, 'error');
  }
}

function showSaveEditButton(id, rec) {
  // 在模板预览区域显示保存修改按钮
  const preview = $('#templatePreview');
  let btnContainer = $('#saveEditBtnContainer');
  if (!btnContainer) {
    btnContainer = document.createElement('div');
    btnContainer.id = 'saveEditBtnContainer';
    btnContainer.style.cssText = 'margin-top: 12px;';
    preview.parentNode.insertBefore(btnContainer, preview.nextSibling);
  }
  // 显示当前编辑的记录信息
  const infoText = `正在编辑: ${rec.vendor || ''} ${rec.deviceType || ''} ${rec.model || ''}`.trim();
  btnContainer.innerHTML = `
    <div style="margin-bottom: 8px; color: #666; font-size: 13px;">${infoText}</div>
    <div style="display: flex; gap: 10px;">
      <button class="btn btn-primary" onclick="saveEditedExperience(${id})">💾 保存修改到经验库</button>
      <button class="btn btn-secondary" onclick="cancelEditExperience()">取消</button>
    </div>
  `;
  btnContainer.style.display = 'block';
}

async function saveEditedExperience(id) {
  try {
    const vendor = $('#vendorInput')?.value || '';
    const deviceType = $('#deviceTypeInput')?.value || '';
    // 从表格收集规则
    const rules = state.templateRules.map(r => ({
      indicator: r.indicator,
      filePattern: r.filePattern,
      keyword: r.keyword,
      synonyms: r.synonyms || '',
      keywordMeaning: r.keywordMeaning || r.keyword_meaning || ''
    }));
    const updateRes = await fetch(`/api/v1/experience/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        deviceType,
        rules,
        indicatorCount: rules.length
      })
    });
    const updateData = await updateRes.json();
    if (updateData.success) {
      showToast('更新成功', 'success');
      $('#saveEditBtnContainer').style.display = 'none';
      state.editingExperienceId = null;
      loadExperienceRecords();
    }
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  }
}

function cancelEditExperience() {
  $('#saveEditBtnContainer').style.display = 'none';
  state.editingExperienceId = null;
  state.templateRules = [];
  renderTemplatePreview();
}

async function saveCurrentAsExperience() {
  const vendor = $('#vendorInput') ? $('#vendorInput').value : '';
  const deviceType = $('#deviceTypeInput') ? $('#deviceTypeInput').value : '';

  if (!vendor || !deviceType) {
    showToast('请先选择厂商和设备类型', 'error');
    return;
  }

  if (!state.templateRules || state.templateRules.length === 0) {
    showToast('没有可保存的采集规则', 'error');
    return;
  }

  const model = prompt('请输入设备型号（可选）：', '');

  try {
    const res = await fetch('/api/v1/experience/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        deviceType,
        model: model || '通用',
        rules: state.templateRules.map(r => ({
          indicator: r.indicator,
          filePattern: r.file_pattern || r.filePattern || '',
          keyword: r.keyword,
          synonyms: r.synonyms || [],
          keywordMeaning: r.keywordMeaning || r.keyword_meaning || '',
          actualPath: r.actualPath || '',
          confidence: r.confidence || 0
        })),
        successRate: Math.round((state.templateRules.filter(r => r.confidence >= 80).length / state.templateRules.length) * 100)
      })
    });

    const data = await res.json();
    if (data.success) {
      showToast('采集经验已保存！', 'success');
      loadExperienceRecords();
    } else {
      showToast('保存失败：' + (data.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('保存失败：' + err.message, 'error');
  }
}

async function autoFillFromExperience() {
  const vendor = $('#vendorInput') ? $('#vendorInput').value : '';
  const deviceType = $('#deviceTypeInput') ? $('#deviceTypeInput').value : '';

  if (!vendor || !deviceType) {
    showToast('请先选择厂商和设备类型', 'error');
    return;
  }

  if (!state.templateRules || state.templateRules.length === 0) {
    showToast('请先上传模板', 'error');
    return;
  }

  try {
    const res = await fetch('/api/v1/experience/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vendor,
        deviceType,
        indicators: state.templateRules.map(r => r.indicator)
      })
    });

    const data = await res.json();
    if (data.success && data.matches && data.matches.length > 0) {
      let filledCount = 0;
      for (const match of data.matches) {
        const rule = state.templateRules.find(r => r.indicator === match.indicator);
        if (rule) {
          if (!rule.filePattern && !rule.file_pattern && match.filePattern) {
            rule.filePattern = match.filePattern;
            filledCount++;
          }
          if (!rule.keyword && match.keyword) {
            rule.keyword = match.keyword;
            filledCount++;
          }
          if ((!rule.synonyms || rule.synonyms.length === 0) && match.synonyms) {
            rule.synonyms = match.synonyms;
            filledCount++;
          }
          if (!rule.keywordMeaning && (match.keywordMeaning || match.keyword_meaning)) {
            rule.keywordMeaning = match.keywordMeaning || match.keyword_meaning;
            filledCount++;
          }
        }
      }
      renderTemplatePreview();
      showToast(`从经验库自动填充了 ${filledCount} 个字段`, 'success');
    } else {
      showToast('经验库中没有匹配的记录，将使用 AI 生成', 'info');
    }
  } catch (err) {
    showToast('查询经验库失败：' + err.message, 'error');
  }
}
