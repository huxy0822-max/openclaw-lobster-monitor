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

async function loadLanding() {
  const response = await fetch('/api/overview');
  const overview = await response.json();
  const summary = overview.summary ?? {};
  const usage = summary.usage ?? {};

  summaryRoot.innerHTML = `
    <article class="hero-metric">
      <span>管理中的小龙虾</span>
      <strong>${formatNumber(summary.agentCount)}</strong>
      <small>活跃 ${formatNumber(summary.activeCount)} · 异常 ${formatNumber(summary.staleCount + summary.offlineCount)}</small>
    </article>
    <article class="hero-metric">
      <span>今天的 Token</span>
      <strong>${formatNumber(usage.today?.total)}</strong>
      <small>最近 24 小时 ${formatNumber(usage.last24h?.total)}</small>
    </article>
    <article class="hero-metric">
      <span>当前提醒</span>
      <strong>${formatNumber(summary.alerts?.critical + summary.alerts?.warn)}</strong>
      <small>严重 ${formatNumber(summary.alerts?.critical)} · 提醒 ${formatNumber(summary.alerts?.warn)}</small>
    </article>
    <article class="hero-metric">
      <span>Key 预设池</span>
      <strong>${formatNumber(summary.providerPresetCount)}</strong>
      <small>本地维护，直接套用</small>
    </article>
  `;

  liveRoot.innerHTML = `
    <article class="live-card">
      <strong>网关状态</strong>
      <p>${overview.gateway?.online ? 'ai.openclaw.gateway 已加载' : 'ai.openclaw.gateway 当前离线'}</p>
    </article>
    <article class="live-card">
      <strong>共享技能</strong>
      <p>当前读到 ${formatNumber(overview.sharedSkills?.length)} 个共享技能目录。</p>
    </article>
    <article class="live-card">
      <strong>全局告警</strong>
      <p>${
        overview.alerts?.length
          ? escapeHtml(overview.alerts.slice(0, 2).map((alert) => alert.title).join('；'))
          : '当前没有全局告警。'
      }</p>
    </article>
    ${overview.agents
      .slice(0, 4)
      .map(
        (agent) => `
          <article class="live-card">
            <strong>${escapeHtml(agent.name)}</strong>
            <p>${escapeHtml(agent.currentModel.provider || '未知')}/${escapeHtml(agent.currentModel.model || '未知')}</p>
            <small>今天 ${formatNumber(agent.tokens.today.total)} token · 最近活动 ${new Intl.DateTimeFormat('zh-CN', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            }).format(new Date(agent.lastActivityAt || Date.now()))}</small>
          </article>
        `,
      )
      .join('')}
  `;
}

loadLanding().catch((error) => {
  summaryRoot.innerHTML = `
    <article class="hero-metric">
      <span>加载失败</span>
      <strong>--</strong>
      <small>${escapeHtml(error.message)}</small>
    </article>
  `;
});
