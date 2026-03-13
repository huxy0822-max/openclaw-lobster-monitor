const summaryRoot = document.querySelector('#landing-summary');
const liveRoot = document.querySelector('#landing-live-grid');

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

async function loadLanding() {
  const response = await fetch('/api/overview');
  const overview = await response.json();
  const summary = overview.summary ?? {};
  const usage = summary.usage ?? {};

  summaryRoot.innerHTML = `
    <article class="landing-summary-card">
      <span>小龙虾总数</span>
      <strong>${formatNumber(summary.agentCount)}</strong>
      <small>活跃 ${formatNumber(summary.activeCount)} · 异常 ${formatNumber((summary.staleCount ?? 0) + (summary.offlineCount ?? 0))}</small>
    </article>
    <article class="landing-summary-card">
      <span>今天 Token</span>
      <strong>${formatNumber(usage.today?.total)}</strong>
      <small>最近 24 小时 ${formatNumber(usage.last24h?.total)}</small>
    </article>
    <article class="landing-summary-card">
      <span>当前提醒</span>
      <strong>${formatNumber((summary.alerts?.critical ?? 0) + (summary.alerts?.warn ?? 0))}</strong>
      <small>严重 ${formatNumber(summary.alerts?.critical)} · 提醒 ${formatNumber(summary.alerts?.warn)}</small>
    </article>
    <article class="landing-summary-card">
      <span>本地预设池</span>
      <strong>${formatNumber(summary.providerPresetCount)}</strong>
      <small>不进仓库，只保存在本机</small>
    </article>
  `;

  liveRoot.innerHTML = `
    <article class="landing-live-card emphasis">
      <strong>网关状态</strong>
      <p>${overview.gateway?.online ? 'ai.openclaw.gateway 已加载，监视器可以直接接住实时状态。' : 'ai.openclaw.gateway 当前离线，很多请求可能不会送达。'}</p>
      <small>心跳调度器 ${relativeTime(overview.gateway?.lastHeartbeatRunnerAt)}</small>
    </article>
    <article class="landing-live-card">
      <strong>全局提醒</strong>
      <p>${overview.alerts?.length ? escapeHtml(overview.alerts.slice(0, 2).map((alert) => alert.title).join('；')) : '当前没有全局提醒。'}</p>
      <small>${formatNumber(overview.alerts?.length)} 条</small>
    </article>
    <article class="landing-live-card">
      <strong>共享技能</strong>
      <p>当前读到 ${formatNumber(overview.sharedSkills?.length)} 个共享技能目录。</p>
      <small>和 agent 独享技能会在监视器里分开展示</small>
    </article>
    <article class="landing-live-card">
      <strong>本机服务</strong>
      <p>当前发现 ${formatNumber(overview.services?.length)} 个 ai.openclaw.* 常驻服务。</p>
      <small>支持直接在监视器内启停</small>
    </article>
    ${overview.agents
      .slice(0, 4)
      .map(
        (agent) => `
          <article class="landing-live-card">
            <strong>${escapeHtml(agent.name)}</strong>
            <p>${escapeHtml(agent.currentModel.provider || '未知')}/${escapeHtml(agent.currentModel.model || '未知')}</p>
            <small>今天 ${formatNumber(agent.tokens.today.total)} token · 最近活动 ${relativeTime(agent.lastActivityAt)}</small>
          </article>
        `,
      )
      .join('')}
  `;
}

loadLanding().catch((error) => {
  summaryRoot.innerHTML = `
    <article class="landing-summary-card">
      <span>加载失败</span>
      <strong>--</strong>
      <small>${escapeHtml(error.message)}</small>
    </article>
  `;
});
