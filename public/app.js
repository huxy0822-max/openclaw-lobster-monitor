const blankPresetForm = () => ({
  id: '',
  name: '',
  apiKey: '',
  baseUrl: '',
  api: '',
  modelId: '',
  providerId: '',
  note: '',
});

const state = {
  overview: null,
  selectedAgentId: 'main',
  selectedCronId: '',
  selectedFilePath: '',
  fileContent: '',
  fileDirty: false,
  cronDraft: '',
  cronDirty: false,
  searchNeedle: '',
  replaceNeedle: '',
  notice: null,
  selectedPresetId: '',
  presetForm: blankPresetForm(),
  presetDirty: false,
  providerPresetChoice: {},
  revealedSecrets: {},
};

const root = document.querySelector('#app');

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text || '响应内容解析失败' };
  }
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN', {
    notation: Math.abs(Number(value || 0)) > 9999 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function formatMoney(value) {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return '无';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function relativeTime(value) {
  if (!value) return '无';
  const delta = Date.now() - Number(value);
  const minutes = Math.round(delta / 60000);
  if (Math.abs(minutes) < 1) return '刚刚';
  if (Math.abs(minutes) < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

function statusClass(status) {
  return status === 'active' ? 'ok' : status === 'stale' ? 'warn' : status === 'offline' ? 'offline' : 'idle';
}

function statusLabel(status) {
  return status === 'active' ? '活跃' : status === 'stale' ? '异常' : status === 'offline' ? '离线' : '空闲';
}

function alertClass(severity) {
  return severity === 'critical' ? 'critical' : severity === 'warn' ? 'warn' : 'info';
}

function alertLabel(severity) {
  return severity === 'critical' ? '严重' : severity === 'warn' ? '提醒' : '信息';
}

function requestKindLabel(kind) {
  return kind === 'heartbeat' ? '心跳' : kind === 'cron' ? '定时' : '对话';
}

function scheduleKindLabel(kind) {
  return kind === 'every' ? '循环' : kind === 'at' ? '单次' : kind === 'cron' ? 'Cron' : '未知';
}

function getAgent() {
  return state.overview?.agents?.find((agent) => agent.id === state.selectedAgentId) ?? null;
}

function getCronJobs(agentId) {
  return (state.overview?.cronJobs ?? []).filter((job) => String(job.ownerAgentId ?? 'main') === agentId);
}

function getSelectedCron(agentId) {
  const jobs = getCronJobs(agentId);
  if (!jobs.length) return null;
  const current = jobs.find((job) => job.id === state.selectedCronId);
  if (current) return current;
  state.selectedCronId = jobs[0].id;
  state.cronDraft = JSON.stringify(jobs[0], null, 2);
  state.cronDirty = false;
  return jobs[0];
}

function getPresets() {
  return state.overview?.providerPresets ?? [];
}

function getSelectedPreset() {
  return getPresets().find((preset) => preset.id === state.selectedPresetId) ?? null;
}

function presetChoiceKey(agentId, providerId) {
  return `${agentId}:${providerId}`;
}

function getChosenPresetId(agentId, providerId) {
  return state.providerPresetChoice[presetChoiceKey(agentId, providerId)] || state.selectedPresetId || getPresets()[0]?.id || '';
}

function setChosenPresetId(agentId, providerId, presetId) {
  state.providerPresetChoice[presetChoiceKey(agentId, providerId)] = presetId;
}

function isSecretVisible(secretId) {
  return Boolean(state.revealedSecrets[secretId]);
}

function loadPresetIntoForm(preset) {
  state.selectedPresetId = preset?.id ?? '';
  state.presetForm = preset
    ? {
        id: preset.id ?? '',
        name: preset.name ?? '',
        apiKey: preset.apiKey ?? '',
        baseUrl: preset.baseUrl ?? '',
        api: preset.api ?? '',
        modelId: preset.modelId ?? '',
        providerId: preset.providerId ?? '',
        note: preset.note ?? '',
      }
    : blankPresetForm();
  state.presetDirty = false;
}

async function loadFile(agentId, relativePath, shouldRender = true) {
  const data = await api(`/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(relativePath)}`);
  state.selectedFilePath = relativePath;
  state.fileContent = data.content;
  state.fileDirty = false;
  if (shouldRender) render();
}

async function refreshOverview() {
  const overview = await api('/api/overview');
  state.overview = overview;

  if (!getAgent()) {
    state.selectedAgentId = overview.agents?.[0]?.id || '';
  }

  const presets = getPresets();
  if (state.selectedPresetId && !presets.some((preset) => preset.id === state.selectedPresetId)) {
    state.selectedPresetId = '';
  }
  if (!state.selectedPresetId && presets.length && !state.presetDirty) {
    loadPresetIntoForm(presets[0]);
  }

  const agent = getAgent();
  if (!agent) {
    render();
    return;
  }

  if (!state.selectedFilePath || !agent.markdownFiles.some((file) => file.relativePath === state.selectedFilePath)) {
    if (agent.markdownFiles?.[0]) {
      await loadFile(agent.id, agent.markdownFiles[0].relativePath, false);
    } else {
      state.selectedFilePath = '';
      state.fileContent = '';
      state.fileDirty = false;
    }
  }

  if (!state.selectedCronId || !getCronJobs(agent.id).some((job) => job.id === state.selectedCronId)) {
    state.selectedCronId = '';
  }
  const selectedCron = getSelectedCron(agent.id);
  if (selectedCron && !state.cronDirty) {
    state.cronDraft = JSON.stringify(selectedCron, null, 2);
  }

  render();
}

function setNotice(kind, text) {
  state.notice = { kind, text };
  render();
  window.clearTimeout(setNotice._timer);
  setNotice._timer = window.setTimeout(() => {
    state.notice = null;
    render();
  }, 3200);
}

function renderUsageCard(title, usage, emphasis = '') {
  return `
    <article class="metric-card ${emphasis}">
      <span>${escapeHtml(title)}</span>
      <strong>${formatNumber(usage?.total)}</strong>
      <small>输入 ${formatNumber(usage?.input)} · 输出 ${formatNumber(usage?.output)}</small>
      <small>成本 ${formatMoney(usage?.cost)}</small>
    </article>
  `;
}

function renderTrendChart(title, points) {
  const max = Math.max(1, ...points.map((item) => Number(item.total || 0)));
  return `
    <div class="trend-card">
      <div class="panel-subhead">
        <strong>${escapeHtml(title)}</strong>
        <span class="muted">峰值 ${formatNumber(max)}</span>
      </div>
      <div class="trend-bars">
        ${points
          .map((point, index) => {
            const height = Math.max(8, Math.round((Number(point.total || 0) / max) * 100));
            const showLabel = index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0;
            const titleText = `${point.label} · ${formatNumber(point.total)} token · ${formatMoney(point.cost)}`;
            return `
              <div class="trend-slot" title="${escapeHtml(titleText)}">
                <div class="trend-column"><span class="trend-bar" style="height:${height}%"></span></div>
                <span class="trend-label">${showLabel ? escapeHtml(point.label) : ''}</span>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderNotice() {
  if (!state.notice) return '';
  return `<div class="notice ${state.notice.kind === 'ok' ? 'ok' : 'error'}">${escapeHtml(state.notice.text)}</div>`;
}

function renderRail() {
  const summary = state.overview?.summary;
  return `
    <aside class="monitor-rail">
      <div class="rail-brand">
        <p class="eyebrow">OpenClaw</p>
        <h1>小龙虾总控台</h1>
        <p class="brand-sub">切 Key、看任务、查状态、改 Markdown，都在一个本地面板里完成。</p>
        <div class="rail-actions">
          <a class="ghost-button" href="/">项目页</a>
          <button class="ghost-button" type="button" data-action="refresh">刷新总览</button>
        </div>
      </div>
      <section class="rail-summary">
        <div class="mini-stat"><span>活跃</span><strong>${formatNumber(summary?.activeCount)}</strong></div>
        <div class="mini-stat"><span>提醒</span><strong>${formatNumber(summary?.alerts?.critical + summary?.alerts?.warn)}</strong></div>
        <div class="mini-stat"><span>今日 Token</span><strong>${formatNumber(summary?.usage?.today?.total)}</strong></div>
        <div class="mini-stat"><span>预设池</span><strong>${formatNumber(summary?.providerPresetCount)}</strong></div>
      </section>
      <section class="rail-section">
        <div class="panel-subhead">
          <strong>小龙虾列表</strong>
          <span class="muted">${formatNumber(summary?.agentCount)} 只</span>
        </div>
        <div class="rail-list">
          ${(state.overview?.agents ?? [])
            .map(
              (agent) => `
                <button class="agent-card ${agent.id === state.selectedAgentId ? 'active' : ''}" type="button" data-action="select-agent" data-agent-id="${escapeHtml(agent.id)}">
                  <div class="agent-card-head">
                    <strong>${escapeHtml(agent.name)}</strong>
                    <span class="status-chip ${statusClass(agent.status)}">${statusLabel(agent.status)}</span>
                  </div>
                  <p>今日 ${formatNumber(agent.tokens.today.total)} token</p>
                  <p class="muted">最近活动 ${relativeTime(agent.lastActivityAt)}</p>
                </button>
              `,
            )
            .join('')}
        </div>
      </section>
      <section class="rail-section compact">
        <div class="panel-subhead">
          <strong>全局告警</strong>
          <span class="muted">${formatNumber(state.overview?.alerts?.length)}</span>
        </div>
        <div class="alert-list compact">
          ${
            state.overview?.alerts?.length
              ? state.overview.alerts
                  .slice(0, 4)
                  .map(
                    (alert) => `
                      <article class="alert-item ${alertClass(alert.severity)}">
                        <strong>${escapeHtml(alert.title)}</strong>
                        <p>${escapeHtml(alert.detail)}</p>
                      </article>
                    `,
                  )
                  .join('')
              : '<p class="empty-state">目前没有全局告警。</p>'
          }
        </div>
      </section>
    </aside>
  `;
}

function renderFleetPanel() {
  const summary = state.overview?.summary ?? {};
  const usage = summary.usage ?? {};
  return `
    <section class="panel hero-panel">
      <div class="hero-layout fleet">
        <div class="hero-copy">
          <p class="eyebrow">舰队总览</p>
          <h2 class="hero-title">这一页就是 OpenClaw 的本地总控台</h2>
          <p class="hero-note">所有查询、替换和改写都直接走本地文件与本地服务，不额外调用 AI。</p>
          <div class="hero-tags">
            <span class="pill">最后刷新 ${formatDateTime(state.overview?.generatedAt)}</span>
            <span class="pill">${escapeHtml(state.overview?.timezone || '')}</span>
            <a class="pill link-pill" href="https://github.com/huxy0822-max/openclaw-lobster-monitor" target="_blank" rel="noreferrer">GitHub 仓库</a>
          </div>
        </div>
        <div class="hero-highlight">
          <div class="hero-highlight-card">
            <span>在线态势</span>
            <strong>${formatNumber(summary.activeCount)} / ${formatNumber(summary.agentCount)}</strong>
            <small>活跃小龙虾 / 总数</small>
          </div>
          <div class="hero-highlight-card">
            <span>待处理提醒</span>
            <strong>${formatNumber(summary.alerts?.critical + summary.alerts?.warn)}</strong>
            <small>严重 ${formatNumber(summary.alerts?.critical)} · 提醒 ${formatNumber(summary.alerts?.warn)}</small>
          </div>
        </div>
      </div>
      <div class="metric-grid fleet-grid">
        ${renderUsageCard('全量累计', usage.total, 'accent')}
        ${renderUsageCard('今天', usage.today)}
        ${renderUsageCard('最近 1 小时', usage.last1h)}
        ${renderUsageCard('最近 24 小时', usage.last24h)}
      </div>
    </section>
  `;
}

function renderAlertPanel(agent) {
  const alerts = [...(state.overview?.alerts ?? []), ...(agent?.alerts ?? [])];
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">告警中心</p>
          <h2>全局和当前小龙虾的异常都放在这里</h2>
        </div>
        <span class="muted">${formatNumber(alerts.length)} 条</span>
      </div>
      <div class="alert-list">
        ${
          alerts.length
            ? alerts
                .map(
                  (alert) => `
                    <article class="alert-item ${alertClass(alert.severity)}">
                      <div class="panel-subhead">
                        <strong>${escapeHtml(alert.title)}</strong>
                        <span class="status-chip ${alertClass(alert.severity)}">${alertLabel(alert.severity)}</span>
                      </div>
                      <p>${escapeHtml(alert.detail)}</p>
                      <small>${alert.scope === 'agent' ? `来自 ${escapeHtml(alert.agentId)}` : '全局告警'}</small>
                    </article>
                  `,
                )
                .join('')
            : '<p class="empty-state">当前没有需要处理的告警。</p>'
        }
      </div>
    </section>
  `;
}

function renderPresetPanel() {
  const presets = getPresets();
  const selectedPreset = getSelectedPreset();
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Key 预设池</p>
          <h2>先维护预设，再一键套给指定小龙虾</h2>
        </div>
        <button class="ghost-button" type="button" data-action="new-preset">新建空预设</button>
      </div>
      <div class="preset-layout">
        <div class="preset-list">
          ${
            presets.length
              ? presets
                  .map(
                    (preset) => `
                      <button class="preset-item ${preset.id === state.selectedPresetId ? 'active' : ''}" type="button" data-action="select-preset" data-preset-id="${escapeHtml(preset.id)}">
                        <strong>${escapeHtml(preset.name)}</strong>
                        <p>${escapeHtml(preset.providerId || '未指定默认通道')}</p>
                        <small>${escapeHtml(preset.baseUrl || '保留原地址')} · ${escapeHtml(preset.modelId || '保留原模型')}</small>
                      </button>
                    `,
                  )
                  .join('')
              : '<p class="empty-state">还没有预设。先从某个当前通道抓一份，或者手动新建。</p>'
          }
        </div>
        <form class="preset-editor" id="preset-form">
          <div class="panel-subhead">
            <strong>${escapeHtml(selectedPreset?.name || '正在编辑新预设')}</strong>
            <span class="muted">${state.presetDirty ? '有未保存修改' : '已同步'}</span>
          </div>
          <div class="compact-grid">
            <label>预设名称
              <input name="name" value="${escapeHtml(state.presetForm.name)}" autocomplete="off" />
            </label>
            <label>默认通道 ID
              <input name="providerId" value="${escapeHtml(state.presetForm.providerId)}" autocomplete="off" />
            </label>
            <label>协议
              <input name="api" value="${escapeHtml(state.presetForm.api)}" autocomplete="off" />
            </label>
            <label>模型 ID
              <input name="modelId" value="${escapeHtml(state.presetForm.modelId)}" autocomplete="off" />
            </label>
          </div>
          <label>中转地址
            <input name="baseUrl" value="${escapeHtml(state.presetForm.baseUrl)}" autocomplete="off" spellcheck="false" />
          </label>
          <label>API Key
            <div class="input-row">
              <input type="${isSecretVisible('preset') ? 'text' : 'password'}" name="apiKey" value="${escapeHtml(state.presetForm.apiKey)}" autocomplete="off" spellcheck="false" />
              <button class="ghost-button" type="button" data-action="toggle-secret" data-secret-id="preset">${isSecretVisible('preset') ? '隐藏' : '显示'}</button>
            </div>
          </label>
          <label>备注
            <textarea name="note">${escapeHtml(state.presetForm.note)}</textarea>
          </label>
          <div class="row-actions">
            <span class="muted">留空的字段在套用时会保留原值，不会强制覆盖。</span>
            <div class="button-row">
              ${
                state.presetForm.id
                  ? '<button class="ghost-button" type="button" data-action="delete-preset">删除预设</button>'
                  : ''
              }
              <button type="submit">保存预设</button>
            </div>
          </div>
        </form>
      </div>
    </section>
  `;
}

function renderAgentCommandPanel(agent) {
  const selectedPreset = getSelectedPreset();
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">当前小龙虾</p>
          <h2>${escapeHtml(agent.name)} 的模型通道与快速切换</h2>
        </div>
        <div class="inline-meta">
          <span class="status-chip ${statusClass(agent.status)}">${statusLabel(agent.status)}</span>
          <span class="muted">最后活动 ${relativeTime(agent.lastActivityAt)}</span>
        </div>
      </div>
      <div class="agent-header-grid">
        <div class="agent-summary-card">
          <span>当前模型</span>
          <strong>${escapeHtml(agent.currentModel.provider || '未知')}</strong>
          <small>${escapeHtml(agent.currentModel.model || '未知')}</small>
        </div>
        <div class="agent-summary-card">
          <span>心跳</span>
          <strong>${agent.heartbeat.enabled ? '开启' : '关闭'}</strong>
          <small>${escapeHtml(agent.heartbeat.every || '未设置')}</small>
        </div>
        <div class="agent-summary-card">
          <span>Cron</span>
          <strong>${formatNumber(agent.cronSummary?.enabled)}</strong>
          <small>异常 ${formatNumber(agent.cronSummary?.failing)}</small>
        </div>
        <div class="agent-summary-card">
          <span>当前预设</span>
          <strong>${escapeHtml(selectedPreset?.name || '未选择')}</strong>
          <small>${escapeHtml(selectedPreset?.providerId || '请先在左侧选择预设')}</small>
        </div>
      </div>
      <div class="provider-grid">
        ${(agent.providers ?? [])
          .map((provider) => {
            const chosenPresetId = getChosenPresetId(agent.id, provider.id);
            return `
              <form class="provider-card" data-provider-form="${escapeHtml(provider.id)}">
                <div class="provider-top">
                  <div>
                    <strong>${escapeHtml(provider.id)}</strong>
                    <p class="muted">${escapeHtml(provider.modelIds.join('、') || '无模型')}</p>
                  </div>
                  <span class="pill">${escapeHtml(provider.api || '未知协议')}</span>
                </div>
                <div class="soft-meta">
                  <span class="pill">当前密钥 ${escapeHtml(provider.apiKeyMasked || '空')}</span>
                  <span class="pill">预设 ${escapeHtml(getPresets().find((preset) => preset.id === chosenPresetId)?.name || '未选')}</span>
                </div>
                <label>API Key
                  <div class="input-row">
                    <input type="${isSecretVisible(presetChoiceKey(agent.id, provider.id)) ? 'text' : 'password'}" name="apiKey" value="${escapeHtml(provider.apiKey)}" autocomplete="off" spellcheck="false" />
                    <button class="ghost-button" type="button" data-action="toggle-secret" data-secret-id="${escapeHtml(presetChoiceKey(agent.id, provider.id))}">${isSecretVisible(presetChoiceKey(agent.id, provider.id)) ? '隐藏' : '显示'}</button>
                  </div>
                </label>
                <label>中转地址
                  <input name="baseUrl" value="${escapeHtml(provider.baseUrl)}" autocomplete="off" spellcheck="false" />
                </label>
                <label>切换用预设
                  <select data-provider-preset-select="${escapeHtml(provider.id)}">
                    <option value="">不选择</option>
                    ${getPresets()
                      .map(
                        (preset) => `
                          <option value="${escapeHtml(preset.id)}" ${preset.id === chosenPresetId ? 'selected' : ''}>${escapeHtml(preset.name)}</option>
                        `,
                      )
                      .join('')}
                  </select>
                </label>
                <div class="row-actions">
                  <button class="ghost-button" type="button" data-action="capture-provider" data-provider-id="${escapeHtml(provider.id)}">抓成预设</button>
                  <div class="button-row">
                    <button class="ghost-button" type="button" data-action="apply-preset-current" data-provider-id="${escapeHtml(provider.id)}">套给当前</button>
                    <button class="ghost-button" type="button" data-action="apply-preset-all" data-provider-id="${escapeHtml(provider.id)}">同名通道全量套用</button>
                    <button type="submit">保存当前通道</button>
                  </div>
                </div>
              </form>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

function renderTrafficPanel(agent) {
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">流量与消耗</p>
          <h2>每只小龙虾的多时间窗 Token 统计</h2>
        </div>
        <span class="muted">最后请求 ${relativeTime(agent.lastRequest?.ts)}</span>
      </div>
      <div class="metric-grid">
        ${renderUsageCard('累计', agent.tokens.total, 'accent')}
        ${renderUsageCard('今天', agent.tokens.today)}
        ${renderUsageCard('最近 1 小时', agent.tokens.last1h)}
        ${renderUsageCard('最近 3 小时', agent.tokens.last3h)}
        ${renderUsageCard('最近 6 小时', agent.tokens.last6h)}
        ${renderUsageCard('最近 24 小时', agent.tokens.last24h)}
        ${renderUsageCard('最近 7 天', agent.tokens.last7d)}
      </div>
      <div class="trend-grid">
        ${renderTrendChart('过去 24 小时', agent.tokenTrend24h ?? [])}
        ${renderTrendChart('过去 7 天', agent.tokenTrend7d ?? [])}
      </div>
    </section>
  `;
}

function renderHistoryPanel(agent) {
  const lastRequest = agent.lastRequest;
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">请求时间线</p>
          <h2>最后一次请求和最近消息</h2>
        </div>
        <span class="muted">${agent.requestHistory?.length || 0} 条最近记录</span>
      </div>
      <div class="request-highlight">
        <div class="panel-subhead">
          <strong>${lastRequest ? requestKindLabel(lastRequest.kind) : '暂无请求'}</strong>
          <span class="muted">${formatDateTime(lastRequest?.ts)} · ${relativeTime(lastRequest?.ts)}</span>
        </div>
        <p>${escapeHtml(lastRequest?.text || '最近没有可展示的请求内容。')}</p>
      </div>
      <div class="history-list">
        ${(agent.requestHistory ?? [])
          .map(
            (item) => `
              <article class="history-item">
                <div class="history-meta">
                  <span class="pill ${escapeHtml(item.kind)}">${requestKindLabel(item.kind)}</span>
                  <span class="muted">${formatDateTime(item.ts)} · ${relativeTime(item.ts)}</span>
                </div>
                <p>${escapeHtml(item.text)}</p>
                <small class="muted">会话 ${escapeHtml(item.sessionId || '未知')}</small>
              </article>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderTasksPanel(agent) {
  const selectedCron = getSelectedCron(agent.id);
  const cronJobs = getCronJobs(agent.id);
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">长期任务</p>
          <h2>心跳、Cron 和最近运行情况</h2>
        </div>
        <div class="inline-meta">
          <span class="pill">最近心跳 ${relativeTime(agent.lastHeartbeatAt)}</span>
          <span class="pill">Cron ${formatNumber(agent.cronSummary?.enabled)} 开启</span>
        </div>
      </div>
      <div class="task-overview">
        <div class="task-summary-card">
          <span>心跳目标</span>
          <strong>${escapeHtml(agent.heartbeat.target || 'last')}</strong>
          <small>${escapeHtml(agent.heartbeat.model || '沿用当前模型')}</small>
        </div>
        <div class="task-summary-card">
          <span>最近 Cron</span>
          <strong>${relativeTime(agent.cronSummary?.lastRunAt)}</strong>
          <small>异常 ${formatNumber(agent.cronSummary?.failing)}</small>
        </div>
      </div>
      <form id="heartbeat-form" class="heartbeat-card">
        <div class="heartbeat-top">
          <strong>心跳任务</strong>
          <button class="ghost-button" type="button" data-action="toggle-heartbeat" data-enabled="${agent.heartbeat.enabled ? 'false' : 'true'}">${agent.heartbeat.enabled ? '关闭' : '开启'}</button>
        </div>
        <div class="compact-grid">
          <label>间隔
            <input name="every" value="${escapeHtml(agent.heartbeat.every || '')}" />
          </label>
          <label>投递目标
            <input name="target" value="${escapeHtml(agent.heartbeat.target || '')}" />
          </label>
          <label>模型覆盖
            <input name="model" value="${escapeHtml(agent.heartbeat.model || '')}" />
          </label>
          <label>指定去向
            <input name="to" value="${escapeHtml(agent.heartbeat.to || '')}" />
          </label>
        </div>
        <label>心跳提示词
          <textarea name="prompt">${escapeHtml(agent.heartbeat.prompt || '')}</textarea>
        </label>
        <div class="row-actions">
          <span class="muted">${agent.heartbeat.enabled ? '当前为启用状态' : '当前为停用状态'}</span>
          <button type="submit">保存心跳</button>
        </div>
      </form>
      <div class="task-split">
        <div class="cron-list">
          <div class="panel-subhead">
            <strong>Cron 列表</strong>
            <span class="muted">${cronJobs.length} 个</span>
          </div>
          ${
            cronJobs.length
              ? cronJobs
                  .map((job) => {
                    const lastRun = job.recentRuns?.[0] ?? null;
                    return `
                      <article class="cron-item ${job.id === state.selectedCronId ? 'selected' : ''}">
                        <button class="cron-select" type="button" data-action="select-cron" data-cron-id="${escapeHtml(job.id)}">
                          <strong>${escapeHtml(job.name || job.id)}</strong>
                          <p class="muted">${scheduleKindLabel(job.schedule?.kind)} · ${job.enabled ? '启用' : '停用'}</p>
                          <p>${escapeHtml(job.state?.lastError || lastRun?.summary || job.payload?.message || job.payload?.systemEvent || '')}</p>
                        </button>
                        <button class="ghost-button" type="button" data-action="toggle-cron" data-cron-id="${escapeHtml(job.id)}" data-enabled="${job.enabled ? 'false' : 'true'}">${job.enabled ? '停用' : '启用'}</button>
                      </article>
                    `;
                  })
                  .join('')
              : '<p class="empty-state">这个小龙虾当前没有 Cron。</p>'
          }
        </div>
        <div class="cron-editor">
          <div class="panel-subhead">
            <strong>${selectedCron ? escapeHtml(selectedCron.name || selectedCron.id) : '无任务可编辑'}</strong>
            ${selectedCron ? '<span class="muted">直接改原始 JSON</span>' : ''}
          </div>
          ${
            selectedCron
              ? `
                <textarea id="cron-draft">${escapeHtml(state.cronDraft)}</textarea>
                <div class="row-actions">
                  <span class="muted">保存后直接写回 ~/.openclaw/cron/jobs.json</span>
                  <button id="save-cron" type="button" data-action="save-cron">保存任务</button>
                </div>
                <div class="run-list">
                  ${(selectedCron.recentRuns ?? [])
                    .map(
                      (run) => `
                        <article class="run-item ${escapeHtml(String(run.status || 'unknown'))}">
                          <div class="panel-subhead">
                            <strong>${escapeHtml(String(run.status || 'unknown'))}</strong>
                            <span class="muted">${formatDateTime(run.ts)} · ${relativeTime(run.ts)}</span>
                          </div>
                          <p>${escapeHtml(run.summary || '无摘要')}</p>
                          <small class="muted">Token ${formatNumber(run.usage?.total)} · 成本 ${formatMoney(run.usage?.cost)}</small>
                        </article>
                      `,
                    )
                    .join('')}
                </div>
              `
              : '<p class="empty-state">没有可编辑的 Cron。</p>'
          }
        </div>
      </div>
    </section>
  `;
}

function renderMarkdownPanel(agent) {
  const files = agent.markdownFiles ?? [];
  return `
    <section class="panel markdown-panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">档案</p>
          <h2>Markdown 记忆与设定</h2>
        </div>
        <span class="muted">${files.length} 个 .md 文件</span>
      </div>
      <div class="task-split">
        <div class="md-list">
          ${
            files.length
              ? files
                  .map(
                    (file) => `
                      <button class="file-link ${file.relativePath === state.selectedFilePath ? 'selected' : ''}" type="button" data-action="select-file" data-file-path="${escapeHtml(file.relativePath)}">
                        <strong>${escapeHtml(file.relativePath)}</strong>
                        <span class="muted">${formatDateTime(file.mtimeMs)} · ${formatNumber(file.size)} B</span>
                      </button>
                    `,
                  )
                  .join('')
              : '<p class="empty-state">当前 workspace 没有发现 Markdown。</p>'
          }
        </div>
        <div class="md-editor">
          ${
            state.selectedFilePath
              ? `
                <div class="panel-subhead">
                  <strong>${escapeHtml(state.selectedFilePath)}</strong>
                  <span class="muted">${state.fileDirty ? '有未保存修改' : '已同步'}</span>
                </div>
                <div class="replace-row">
                  <input id="search-needle" placeholder="查找文本" value="${escapeHtml(state.searchNeedle)}" />
                  <input id="replace-needle" placeholder="替换为" value="${escapeHtml(state.replaceNeedle)}" />
                  <button class="ghost-button" type="button" data-action="replace-all">全部替换</button>
                </div>
                <textarea id="markdown-content">${escapeHtml(state.fileContent)}</textarea>
                <div class="row-actions">
                  <span class="muted">查找和替换只在本地文本里完成，不会走模型。</span>
                  <button id="save-markdown" type="button" data-action="save-markdown">保存文件</button>
                </div>
              `
              : '<p class="empty-state">选择一个 Markdown 文件开始编辑。</p>'
          }
        </div>
      </div>
    </section>
  `;
}

function renderSkillsPanel(agent) {
  const sharedSkills = state.overview?.sharedSkills ?? [];
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">技能</p>
          <h2>共享技能、独享技能和当前生效技能</h2>
        </div>
        <span class="muted">共享 ${sharedSkills.length} · 独享 ${agent.skills.private.length}</span>
      </div>
      <div class="skills-grid">
        <div class="skill-column">
          <h3>全局共享</h3>
          ${sharedSkills.length ? sharedSkills.map((skill) => `<div class="skill-chip">${escapeHtml(skill.name)}</div>`).join('') : '<p class="empty-state">没有共享技能。</p>'}
        </div>
        <div class="skill-column">
          <h3>当前小龙虾独享</h3>
          ${
            agent.skills.private.length
              ? agent.skills.private.map((skill) => `<div class="skill-chip private">${escapeHtml(skill.name)}</div>`).join('')
              : '<p class="empty-state">没有私有技能。</p>'
          }
        </div>
        <div class="skill-column">
          <h3>当前生效</h3>
          ${
            agent.skills.effective.length
              ? agent.skills.effective
                  .map((skill) => {
                    const label =
                      skill.category === 'private'
                        ? '独享'
                        : skill.category === 'shared-managed'
                          ? '共享'
                          : skill.category === 'bundled'
                            ? '内置'
                            : '外部';
                    return `
                      <div class="skill-row">
                        <strong>${escapeHtml(skill.name)}</strong>
                        <span class="pill">${label}</span>
                      </div>
                    `;
                  })
                  .join('')
              : '<p class="empty-state">暂无技能快照。</p>'
          }
        </div>
      </div>
    </section>
  `;
}

function renderServicesPanel() {
  const gateway = state.overview?.gateway;
  const services = state.overview?.services ?? [];
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">系统</p>
          <h2>网关与常驻服务</h2>
        </div>
        <div class="inline-meta">
          <span class="status-chip ${gateway?.online ? 'ok' : 'offline'}">${gateway?.online ? '网关在线' : '网关离线'}</span>
          <span class="muted">心跳调度器 ${relativeTime(gateway?.lastHeartbeatRunnerAt)}</span>
        </div>
      </div>
      <div class="service-grid">
        ${services
          .map(
            (service) => `
              <article class="service-card">
                <div>
                  <strong>${escapeHtml(service.label)}</strong>
                  <p class="muted">${escapeHtml(service.programArguments?.join(' ') || service.program || '无命令信息')}</p>
                </div>
                <div class="service-meta">
                  <span class="status-chip ${service.loaded ? 'ok' : 'idle'}">${service.loaded ? '已加载' : '未加载'}</span>
                  <span class="muted">${service.pid ? `PID ${service.pid}` : '无活动 PID'}</span>
                  <button class="ghost-button" type="button" data-action="toggle-service" data-service-label="${escapeHtml(service.label)}" data-enabled="${service.loaded ? 'false' : 'true'}">${service.loaded ? '停用' : '拉起'}</button>
                </div>
              </article>
            `,
          )
          .join('')}
      </div>
    </section>
  `;
}

function render() {
  const agent = getAgent();
  if (!state.overview || !agent) {
    root.innerHTML = '<div class="loading-shell"><p class="loading">正在加载本地 OpenClaw 数据…</p></div>';
    return;
  }

  root.innerHTML = `
    <div class="monitor-shell">
      ${renderRail()}
      <main class="monitor-main">
        ${renderNotice()}
        ${renderFleetPanel()}
        <div class="main-grid two-up">
          ${renderAlertPanel(agent)}
          ${renderPresetPanel()}
        </div>
        ${renderAgentCommandPanel(agent)}
        <div class="main-grid two-up">
          ${renderTrafficPanel(agent)}
          ${renderHistoryPanel(agent)}
        </div>
        ${renderTasksPanel(agent)}
        <div class="main-grid markdown-skills">
          ${renderMarkdownPanel(agent)}
          ${renderSkillsPanel(agent)}
        </div>
        ${renderServicesPanel()}
      </main>
    </div>
  `;
}

async function handleAction(action, element) {
  const agent = getAgent();
  if (!agent && action !== 'refresh') return;

  try {
    if (action === 'refresh') {
      await refreshOverview();
      return;
    }

    if (action === 'select-agent') {
      state.selectedAgentId = element.dataset.agentId;
      state.selectedCronId = '';
      state.selectedFilePath = '';
      state.fileContent = '';
      state.fileDirty = false;
      await refreshOverview();
      return;
    }

    if (action === 'select-preset') {
      const preset = getPresets().find((item) => item.id === element.dataset.presetId);
      loadPresetIntoForm(preset);
      render();
      return;
    }

    if (action === 'new-preset') {
      loadPresetIntoForm(null);
      render();
      return;
    }

    if (action === 'delete-preset') {
      if (!state.presetForm.id) return;
      if (!window.confirm(`确认删除预设 ${state.presetForm.name || state.presetForm.id}？`)) return;
      await api(`/api/presets/${encodeURIComponent(state.presetForm.id)}`, { method: 'DELETE' });
      loadPresetIntoForm(null);
      setNotice('ok', '预设已删除');
      await refreshOverview();
      return;
    }

    if (action === 'toggle-secret') {
      const secretId = element.dataset.secretId;
      state.revealedSecrets = {
        ...state.revealedSecrets,
        [secretId]: !isSecretVisible(secretId),
      };
      render();
      return;
    }

    if (action === 'capture-provider') {
      const provider = agent.providers.find((item) => item.id === element.dataset.providerId);
      if (!provider) return;
      state.presetForm = {
        id: state.selectedPresetId || '',
        name: state.presetForm.name || `${agent.name}-${provider.id}`,
        apiKey: provider.apiKey || '',
        baseUrl: provider.baseUrl || '',
        api: provider.api || '',
        modelId: provider.modelIds?.[0] || '',
        providerId: provider.id,
        note: state.presetForm.note || `从 ${agent.name}/${provider.id} 抓取`,
      };
      state.presetDirty = true;
      render();
      return;
    }

    if (action === 'apply-preset-current' || action === 'apply-preset-all') {
      const providerId = element.dataset.providerId;
      const presetId = getChosenPresetId(agent.id, providerId);
      if (!presetId) throw new Error('先给这个通道选择一个预设。');
      const result = await api(`/api/presets/${encodeURIComponent(presetId)}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          providerId,
          agentId: agent.id,
          scope: action === 'apply-preset-all' ? 'all' : 'current',
        }),
      });
      const skipped = result.skipped?.length ? `，跳过 ${result.skipped.length} 个` : '';
      setNotice('ok', `预设已套用到 ${result.applied?.length || 0} 个通道${skipped}`);
      await refreshOverview();
      return;
    }

    if (action === 'toggle-heartbeat') {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/heartbeat`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: element.dataset.enabled === 'true' }),
      });
      setNotice('ok', `${agent.id} 的心跳开关已切换`);
      await refreshOverview();
      return;
    }

    if (action === 'select-cron') {
      state.selectedCronId = element.dataset.cronId;
      const cron = getSelectedCron(agent.id);
      if (cron) {
        state.cronDraft = JSON.stringify(cron, null, 2);
        state.cronDirty = false;
      }
      render();
      return;
    }

    if (action === 'toggle-cron') {
      await api(`/api/cron/${encodeURIComponent(element.dataset.cronId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: element.dataset.enabled === 'true' }),
      });
      setNotice('ok', 'Cron 开关已切换');
      await refreshOverview();
      return;
    }

    if (action === 'save-cron') {
      const parsed = JSON.parse(state.cronDraft);
      await api(`/api/cron/${encodeURIComponent(parsed.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ job: parsed }),
      });
      state.cronDirty = false;
      setNotice('ok', 'Cron 已保存');
      await refreshOverview();
      return;
    }

    if (action === 'select-file') {
      await loadFile(agent.id, element.dataset.filePath);
      return;
    }

    if (action === 'replace-all') {
      const needle = state.searchNeedle;
      if (!needle) throw new Error('先输入要查找的文本。');
      state.fileContent = state.fileContent.split(needle).join(state.replaceNeedle);
      state.fileDirty = true;
      render();
      return;
    }

    if (action === 'save-markdown') {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: state.selectedFilePath, content: state.fileContent }),
      });
      state.fileDirty = false;
      setNotice('ok', `${state.selectedFilePath} 已保存`);
      await refreshOverview();
      return;
    }

    if (action === 'toggle-service') {
      await api(`/api/services/${encodeURIComponent(element.dataset.serviceLabel)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: element.dataset.enabled === 'true' }),
      });
      setNotice('ok', `${element.dataset.serviceLabel} 已切换`);
      await refreshOverview();
    }
  } catch (error) {
    setNotice('error', error.message);
  }
}

async function handleSubmit(form) {
  const agent = getAgent();
  try {
    if (form.matches('[data-provider-form]')) {
      const providerId = form.dataset.providerForm;
      const formData = new FormData(form);
      await api(`/api/agents/${encodeURIComponent(agent.id)}/providers/${encodeURIComponent(providerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          apiKey: formData.get('apiKey'),
          baseUrl: formData.get('baseUrl'),
        }),
      });
      setNotice('ok', `${agent.id}/${providerId} 已保存`);
      await refreshOverview();
      return;
    }

    if (form.id === 'heartbeat-form') {
      const formData = new FormData(form);
      await api(`/api/agents/${encodeURIComponent(agent.id)}/heartbeat`, {
        method: 'PATCH',
        body: JSON.stringify({
          every: formData.get('every'),
          target: formData.get('target'),
          model: formData.get('model'),
          to: formData.get('to'),
          prompt: formData.get('prompt'),
        }),
      });
      setNotice('ok', `${agent.id} 的心跳配置已更新`);
      await refreshOverview();
      return;
    }

    if (form.id === 'preset-form') {
      const payload = {
        ...state.presetForm,
      };
      const result = await api('/api/presets', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      loadPresetIntoForm(result.preset);
      setNotice('ok', `预设 ${result.preset.name} 已保存`);
      await refreshOverview();
    }
  } catch (error) {
    setNotice('error', error.message);
  }
}

function handleInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  if (target.id === 'cron-draft') {
    state.cronDraft = target.value;
    state.cronDirty = true;
    return;
  }

  if (target.id === 'markdown-content') {
    state.fileContent = target.value;
    state.fileDirty = true;
    return;
  }

  if (target.id === 'search-needle') {
    state.searchNeedle = target.value;
    return;
  }

  if (target.id === 'replace-needle') {
    state.replaceNeedle = target.value;
    return;
  }

  const presetForm = target.closest('#preset-form');
  if (presetForm && target.getAttribute('name')) {
    state.presetForm = {
      ...state.presetForm,
      [target.getAttribute('name')]: target.value,
    };
    state.presetDirty = true;
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.matches('[data-provider-preset-select]')) {
    const agent = getAgent();
    setChosenPresetId(agent.id, target.dataset.providerPresetSelect, target.value);
  }
}

function setupEventDelegation() {
  root.addEventListener('click', async (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      await handleAction(actionEl.dataset.action, actionEl);
    }
  });

  root.addEventListener('submit', async (event) => {
    const form = event.target.closest('form');
    if (!form) return;
    event.preventDefault();
    await handleSubmit(form);
  });

  root.addEventListener('input', handleInput);
  root.addEventListener('change', handleChange);
}

setupEventDelegation();
refreshOverview().catch((error) => {
  root.innerHTML = `<div class="loading-shell"><p class="loading">加载失败：${escapeHtml(error.message)}</p></div>`;
});
