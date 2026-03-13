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
  return new Intl.NumberFormat('zh-CN', { notation: Number(value || 0) > 9999 ? 'compact' : 'standard' }).format(Number(value || 0));
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
  const delta = Date.now() - value;
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
  const jobs = state.overview?.cronJobs ?? [];
  return jobs.filter((job) => String(job.ownerAgentId || 'main') === agentId);
}

function getSelectedCron(agentId) {
  const jobs = getCronJobs(agentId);
  if (jobs.length === 0) return null;
  const current = jobs.find((job) => job.id === state.selectedCronId);
  if (current) return current;
  state.selectedCronId = jobs[0].id;
  state.cronDraft = JSON.stringify(jobs[0], null, 2);
  state.cronDirty = false;
  return jobs[0];
}

async function loadFile(agentId, relativePath) {
  const data = await api(`/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(relativePath)}`);
  state.selectedFilePath = relativePath;
  state.fileContent = data.content;
  state.fileDirty = false;
  render();
}

async function refreshOverview() {
  const overview = await api('/api/overview');
  state.overview = overview;

  if (!getAgent()) {
    state.selectedAgentId = overview.agents?.[0]?.id || 'main';
  }

  const agent = getAgent();
  if (!agent) {
    render();
    return;
  }

  if (!state.selectedFilePath && agent.markdownFiles?.length) {
    await loadFile(agent.id, agent.markdownFiles[0].relativePath);
    return;
  }

  if (state.selectedFilePath && !agent.markdownFiles.some((file) => file.relativePath === state.selectedFilePath)) {
    state.selectedFilePath = '';
    state.fileContent = '';
    state.fileDirty = false;
  }

  if (!state.selectedCronId) {
    const cron = getSelectedCron(agent.id);
    if (cron) {
      state.cronDraft = JSON.stringify(cron, null, 2);
      state.cronDirty = false;
    }
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

function renderServices() {
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
          <span class="muted">心跳调度器：${relativeTime(gateway?.lastHeartbeatRunnerAt)}</span>
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
                  <button class="ghost-button" data-service-toggle="${escapeHtml(service.label)}" data-enabled="${service.loaded ? 'false' : 'true'}">${service.loaded ? '停用' : '拉起'}</button>
                </div>
              </article>`,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderAgentRail() {
  return `
    <aside class="agent-rail">
      <div class="rail-head">
        <p class="eyebrow">总控台</p>
        <h1>小龙虾总控台</h1>
        <p class="brand-sub">OpenClaw 本地监视器</p>
        <button class="ghost-button" id="refresh-button">刷新全部</button>
      </div>
      <div class="rail-list">
        ${(state.overview?.agents ?? [])
          .map(
            (agent) => `
              <button class="agent-card ${agent.id === state.selectedAgentId ? 'active' : ''}" data-agent-select="${escapeHtml(agent.id)}">
                <div class="agent-card-head">
                  <strong>${escapeHtml(agent.name)}</strong>
                  <span class="status-chip ${statusClass(agent.status)}">${statusLabel(agent.status)}</span>
                </div>
                <p>今日 ${formatNumber(agent.tokens.today.total)} token</p>
                <p class="muted">最近活动 ${relativeTime(agent.lastActivityAt)}</p>
              </button>`,
          )
          .join('')}
      </div>
    </aside>
  `;
}

function renderHeroPanel(agent) {
  const providers = agent.providers ?? [];
  return `
    <section class="panel hero-panel">
      <div class="hero-layout">
        <div class="hero-copy">
          <p class="eyebrow">当前小龙虾</p>
          <div class="hero-top">
            <h2 class="hero-title">${escapeHtml(agent.name)}</h2>
            <span class="status-chip ${statusClass(agent.status)}">${statusLabel(agent.status)}</span>
          </div>
          <p class="hero-note">当前模型：${escapeHtml(agent.currentModel.provider || 'unknown')}/${escapeHtml(agent.currentModel.model || 'unknown')}</p>
          <div class="metric-grid">
            <div class="metric-card"><span>累计 Token</span><strong>${formatNumber(agent.tokens.total.total)}</strong></div>
            <div class="metric-card"><span>今天</span><strong>${formatNumber(agent.tokens.today.total)}</strong></div>
            <div class="metric-card"><span>最近 6 小时</span><strong>${formatNumber(agent.tokens.last6h.total)}</strong></div>
            <div class="metric-card"><span>心跳状态</span><strong>${agent.heartbeat.enabled ? '开启' : '关闭'}</strong></div>
          </div>
        </div>
        <div class="hero-aside">
          <div class="meta-band">
            <span class="pill">Provider ${providers.length}</span>
            <span class="pill">Markdown ${agent.markdownFiles.length}</span>
            <span class="pill">技能 ${agent.skills.effective.length}</span>
          </div>
          <div class="request-highlight">
            <strong>${agent.lastRequest ? requestKindLabel(agent.lastRequest.kind) : '暂无请求'}</strong>
            <p>${escapeHtml(agent.lastRequest?.text || '最近没有可展示的请求内容。')}</p>
          </div>
        </div>
      </div>
      <div class="provider-headline">
        <div>
          <p class="eyebrow">模型提供方</p>
          <h3>每只小龙虾的 Key 都在这里单独改</h3>
        </div>
      </div>
      <div class="provider-grid">
        ${providers
          .map(
            (provider) => `
              <form class="provider-card" data-provider-form="${escapeHtml(provider.id)}">
                <div class="provider-top">
                  <div>
                    <strong>${escapeHtml(provider.id)}</strong>
                    <p class="muted">${escapeHtml(provider.modelIds.join(', ') || '无模型')}</p>
                  </div>
                  <span class="pill">${escapeHtml(provider.api || 'api?')}</span>
                </div>
                <label>API Key
                  <input name="apiKey" value="${escapeHtml(provider.apiKey)}" autocomplete="off" spellcheck="false" />
                </label>
                <label>中转地址
                  <input name="baseUrl" value="${escapeHtml(provider.baseUrl)}" autocomplete="off" spellcheck="false" />
                </label>
                <div class="row-actions">
                  <span class="muted">当前片段 ${escapeHtml(provider.apiKeyMasked || '空')}</span>
                  <button type="submit">保存这个 Key</button>
                </div>
              </form>`,
          )
          .join('')}
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
          <h2>最近消息与请求历史</h2>
        </div>
        <div class="inline-meta">
          <span class="muted">最后一次请求：${relativeTime(lastRequest?.ts)}</span>
        </div>
      </div>
      <div class="request-highlight">
        <strong>${lastRequest ? requestKindLabel(lastRequest.kind) : '暂无请求'}</strong>
        <p>${escapeHtml(lastRequest?.text || '还没有可展示的请求内容。')}</p>
      </div>
      <div class="history-list">
        ${(agent.requestHistory ?? [])
          .map(
            (item) => `
              <article class="history-item">
                <div class="history-meta">
                  <span class="pill ${item.kind}">${requestKindLabel(item.kind)}</span>
                  <span class="muted">${formatDateTime(item.ts)} · ${relativeTime(item.ts)}</span>
                </div>
                <p>${escapeHtml(item.text)}</p>
              </article>`,
          )
          .join('')}
      </div>
    </section>
  `;
}

function renderTasksPanel(agent) {
  const selectedCron = getSelectedCron(agent.id);
  const cronJobs = getCronJobs(agent.id);
  if (selectedCron && !state.cronDirty) {
    state.cronDraft = JSON.stringify(selectedCron, null, 2);
  }

  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">长期任务</p>
          <h2>心跳与定时任务</h2>
        </div>
        <div class="inline-meta">
          <span class="muted">最近心跳：${relativeTime(agent.lastHeartbeatAt)}</span>
        </div>
      </div>
      <form id="heartbeat-form" class="heartbeat-card">
        <div class="heartbeat-top">
          <strong>心跳任务</strong>
          <button type="button" class="ghost-button" id="heartbeat-toggle" data-enabled="${agent.heartbeat.enabled ? 'false' : 'true'}">${agent.heartbeat.enabled ? '关闭' : '开启'}</button>
        </div>
        <div class="compact-grid">
          <label>间隔<input name="every" value="${escapeHtml(agent.heartbeat.every || '')}" /></label>
          <label>投递目标<input name="target" value="${escapeHtml(agent.heartbeat.target || '')}" /></label>
          <label>模型覆盖<input name="model" value="${escapeHtml(agent.heartbeat.model || '')}" /></label>
          <label>指定去向<input name="to" value="${escapeHtml(agent.heartbeat.to || '')}" /></label>
        </div>
        <label>心跳提示词<textarea name="prompt">${escapeHtml(agent.heartbeat.prompt || '')}</textarea></label>
        <div class="row-actions">
          <span class="muted">${agent.heartbeat.enabled ? '心跳运行中' : '当前关闭'}</span>
          <button type="submit">保存心跳</button>
        </div>
      </form>
      <div class="task-split">
        <div class="cron-list">
          <div class="subhead">
            <strong>Cron 任务</strong>
            <span class="muted">${cronJobs.length} 个</span>
          </div>
          ${
            cronJobs.length
              ? cronJobs
                  .map(
                    (job) => `
                      <article class="cron-item ${job.id === state.selectedCronId ? 'selected' : ''}">
                        <button class="cron-select" data-cron-select="${escapeHtml(job.id)}">
                          <strong>${escapeHtml(job.name || job.id)}</strong>
                          <p class="muted">${scheduleKindLabel(job.schedule?.kind)} · ${job.enabled ? '启用' : '停用'}</p>
                          <p>${escapeHtml(job.state?.lastError || job.payload?.message || job.payload?.systemEvent || '')}</p>
                        </button>
                        <button class="ghost-button" data-cron-toggle="${escapeHtml(job.id)}" data-enabled="${job.enabled ? 'false' : 'true'}">${job.enabled ? '停用' : '启用'}</button>
                      </article>`,
                  )
                  .join('')
              : '<p class="empty-state">这个小龙虾还没有 Cron 任务。</p>'
          }
        </div>
        <div class="cron-editor">
          <div class="subhead">
            <strong>${selectedCron ? escapeHtml(selectedCron.name || selectedCron.id) : '无任务可编辑'}</strong>
            ${selectedCron ? '<span class="muted">直接改原始 JSON</span>' : ''}
          </div>
          ${
            selectedCron
              ? `
                <textarea id="cron-draft">${escapeHtml(state.cronDraft)}</textarea>
                <div class="row-actions">
                  <span class="muted">修改后会直接写回 ~/.openclaw/cron/jobs.json</span>
                  <button id="save-cron" type="button">保存任务</button>
                </div>`
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
    <section class="panel">
      <div class="panel-head">
        <div>
          <p class="eyebrow">档案</p>
          <h2>Markdown 记忆与设定</h2>
        </div>
        <div class="inline-meta">
          <span class="muted">${files.length} 个 .md 文件</span>
        </div>
      </div>
      <div class="task-split">
        <div class="md-list">
          ${files
            .map(
              (file) => `
                <button class="file-link ${file.relativePath === state.selectedFilePath ? 'selected' : ''}" data-file-select="${escapeHtml(file.relativePath)}">
                  <strong>${escapeHtml(file.relativePath)}</strong>
                  <span class="muted">${formatDateTime(file.mtimeMs)} · ${formatNumber(file.size)} B</span>
                </button>`,
            )
            .join('')}
        </div>
        <div class="md-editor">
          ${
            state.selectedFilePath
              ? `
                <div class="subhead">
                  <strong>${escapeHtml(state.selectedFilePath)}</strong>
                  <span class="muted">${state.fileDirty ? '未保存修改' : '已同步'}</span>
                </div>
                <div class="replace-row">
                  <input id="search-needle" placeholder="查找文本" value="${escapeHtml(state.searchNeedle)}" />
                  <input id="replace-needle" placeholder="替换为" value="${escapeHtml(state.replaceNeedle)}" />
                  <button id="replace-all" type="button" class="ghost-button">全部替换</button>
                </div>
                <textarea id="markdown-content">${escapeHtml(state.fileContent)}</textarea>
                <div class="row-actions">
                  <span class="muted">查询和替换只在本地文本上运行，不调用模型。</span>
                  <button id="save-markdown" type="button">保存文件</button>
                </div>`
              : '<p class="empty-state">选择一个 .md 文件开始编辑。</p>'
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
          <h2>共享技能与独占技能</h2>
        </div>
        <div class="inline-meta">
          <span class="muted">独享 ${agent.skills.private.length} · 生效 ${agent.skills.effective.length}</span>
        </div>
      </div>
      <div class="skills-grid">
        <div class="skill-column">
          <h3>全局共享</h3>
          ${sharedSkills.map((skill) => `<div class="skill-chip">${escapeHtml(skill.name)}</div>`).join('')}
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
          ${agent.skills.effective
            .map((skill) => {
              const label = skill.category === 'private' ? '独享' : skill.category === 'shared-managed' ? '共享' : skill.category === 'bundled' ? '内置' : '外部';
              return `
                <div class="skill-row">
                  <strong>${escapeHtml(skill.name)}</strong>
                  <span class="pill">${label}</span>
                </div>`;
            })
            .join('')}
        </div>
      </div>
    </section>
  `;
}

function bindEvents(agent) {
  document.querySelector('#refresh-button')?.addEventListener('click', async () => {
    await refreshOverview();
  });

  document.querySelectorAll('[data-agent-select]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.selectedAgentId = button.dataset.agentSelect;
      state.selectedCronId = '';
      const nextAgent = getAgent();
      if (nextAgent?.markdownFiles?.length) {
        await loadFile(nextAgent.id, nextAgent.markdownFiles[0].relativePath);
      } else {
        state.selectedFilePath = '';
        state.fileContent = '';
        state.fileDirty = false;
        render();
      }
    });
  });

  document.querySelectorAll('[data-provider-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const providerId = form.dataset.providerForm;
      const formData = new FormData(form);
      try {
        await api(`/api/agents/${encodeURIComponent(agent.id)}/providers/${encodeURIComponent(providerId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            apiKey: formData.get('apiKey'),
            baseUrl: formData.get('baseUrl'),
          }),
        });
        setNotice('ok', `${agent.id}/${providerId} 已保存`);
        await refreshOverview();
      } catch (error) {
        setNotice('error', error.message);
      }
    });
  });

  document.querySelector('#heartbeat-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
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
    } catch (error) {
      setNotice('error', error.message);
    }
  });

  document.querySelector('#heartbeat-toggle')?.addEventListener('click', async (event) => {
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/heartbeat`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: event.currentTarget.dataset.enabled === 'true' }),
      });
      setNotice('ok', `${agent.id} 的心跳开关已切换`);
      await refreshOverview();
    } catch (error) {
      setNotice('error', error.message);
    }
  });

  document.querySelectorAll('[data-cron-select]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCronId = button.dataset.cronSelect;
      const cron = getSelectedCron(agent.id);
      if (cron) {
        state.cronDraft = JSON.stringify(cron, null, 2);
        state.cronDirty = false;
      }
      render();
    });
  });

  document.querySelectorAll('[data-cron-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/cron/${encodeURIComponent(button.dataset.cronToggle)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }),
        });
        setNotice('ok', 'Cron 开关已切换');
        await refreshOverview();
      } catch (error) {
        setNotice('error', error.message);
      }
    });
  });

  document.querySelector('#cron-draft')?.addEventListener('input', (event) => {
    state.cronDraft = event.currentTarget.value;
    state.cronDirty = true;
  });

  document.querySelector('#save-cron')?.addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(state.cronDraft);
      await api(`/api/cron/${encodeURIComponent(parsed.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ job: parsed }),
      });
      state.cronDirty = false;
      setNotice('ok', 'Cron JSON 已保存');
      await refreshOverview();
    } catch (error) {
      setNotice('error', error.message);
    }
  });

  document.querySelectorAll('[data-file-select]').forEach((button) => {
    button.addEventListener('click', async () => {
      await loadFile(agent.id, button.dataset.fileSelect);
    });
  });

  document.querySelector('#markdown-content')?.addEventListener('input', (event) => {
    state.fileContent = event.currentTarget.value;
    state.fileDirty = true;
  });

  document.querySelector('#search-needle')?.addEventListener('input', (event) => {
    state.searchNeedle = event.currentTarget.value;
  });

  document.querySelector('#replace-needle')?.addEventListener('input', (event) => {
    state.replaceNeedle = event.currentTarget.value;
  });

  document.querySelector('#replace-all')?.addEventListener('click', () => {
    if (!state.searchNeedle) return;
    state.fileContent = state.fileContent.split(state.searchNeedle).join(state.replaceNeedle);
    state.fileDirty = true;
    render();
  });

  document.querySelector('#save-markdown')?.addEventListener('click', async () => {
    try {
      await api(`/api/agents/${encodeURIComponent(agent.id)}/file`, {
        method: 'PUT',
        body: JSON.stringify({
          path: state.selectedFilePath,
          content: state.fileContent,
        }),
      });
      state.fileDirty = false;
      setNotice('ok', `${state.selectedFilePath} 已保存`);
      await refreshOverview();
      await loadFile(agent.id, state.selectedFilePath);
    } catch (error) {
      setNotice('error', error.message);
    }
  });

  document.querySelectorAll('[data-service-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/services/${encodeURIComponent(button.dataset.serviceToggle)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: button.dataset.enabled === 'true' }),
        });
        setNotice('ok', `${button.dataset.serviceToggle} 已切换`);
        await refreshOverview();
      } catch (error) {
        setNotice('error', error.message);
      }
    });
  });
}

function render() {
  if (!state.overview) {
    root.innerHTML = '<main class="loading">正在载入小龙虾总控台…</main>';
    return;
  }

  const agent = getAgent();
  if (!agent) {
    root.innerHTML = '<main class="loading">没有找到可用的小龙虾。</main>';
    return;
  }

  root.innerHTML = `
    <div class="app-shell">
      ${renderAgentRail()}
      <main class="main-area">
        ${state.notice ? `<div class="notice ${escapeHtml(state.notice.kind)}">${escapeHtml(state.notice.text)}</div>` : ''}
        ${renderServices()}
        ${renderHeroPanel(agent)}
        ${renderHistoryPanel(agent)}
        ${renderTasksPanel(agent)}
        ${renderMarkdownPanel(agent)}
        ${renderSkillsPanel(agent)}
      </main>
    </div>
  `;

  bindEvents(agent);
}

refreshOverview().catch((error) => {
  root.innerHTML = `<main class="loading">加载失败：${escapeHtml(error.message)}</main>`;
});

window.setInterval(() => {
  refreshOverview().catch(() => {});
}, 30000);
