import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CRON_JOBS_PATH,
  CRON_RUNS_DIR,
  GLOBAL_SKILLS_DIR,
  GATEWAY_LOG_PATH,
  LAUNCH_AGENTS_DIR,
  OPENCLAW_CONFIG_PATH,
  extractTextFromContent,
  execFileText,
  findAgentDefinition,
  inferRequestKind,
  listMarkdownFiles,
  loadMonitorState,
  maskApiKey,
  normalizeInboundUserText,
  parseLaunchAgentPlist,
  pushRolling,
  readJson,
  resolveConfiguredAgents,
  startOfTodayMs,
  toMs,
  truncate,
  exists,
} from './monitor-common.mjs';

const sessionFileCache = new Map();
const WINDOW_SPECS = [
  ['last1h', 1 * 60 * 60 * 1000],
  ['last3h', 3 * 60 * 60 * 1000],
  ['last6h', 6 * 60 * 60 * 1000],
  ['last24h', 24 * 60 * 60 * 1000],
  ['last7d', 7 * 24 * 60 * 60 * 1000],
];

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function addUsage(target, source = {}) {
  target.input += Number(source.input ?? 0) || 0;
  target.output += Number(source.output ?? 0) || 0;
  target.cacheRead += Number(source.cacheRead ?? 0) || 0;
  target.cacheWrite += Number(source.cacheWrite ?? 0) || 0;
  target.total += Number(source.total ?? 0) || 0;
  target.cost += Number(source.cost ?? 0) || 0;
  return target;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return emptyUsage();

  const input = Number(usage.input ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.output ?? usage.output_tokens ?? 0) || 0;
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read_tokens ?? 0) || 0;
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + output + cacheRead + cacheWrite) || 0;
  const cost = Number(usage?.cost?.total ?? usage.total_cost_usd ?? 0) || 0;
  return { input, output, cacheRead, cacheWrite, total, cost };
}

function sumUsage(events, sinceMs = 0) {
  return events.reduce((accumulator, event) => {
    if ((event.ts ?? 0) < sinceMs) return accumulator;
    return addUsage(accumulator, event);
  }, emptyUsage());
}

function buildUsageWindows(events, nowMs, todayStartMs) {
  const usage = {
    total: sumUsage(events, 0),
    today: sumUsage(events, todayStartMs),
  };

  for (const [key, durationMs] of WINDOW_SPECS) {
    usage[key] = sumUsage(events, nowMs - durationMs);
  }

  return usage;
}

function formatHourLabel(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:00`;
}

function formatDayLabel(ts) {
  const date = new Date(ts);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function buildUsageTrend(events, options) {
  const { nowMs, bucketMs, points, labelFormat } = options;
  const startMs = nowMs - bucketMs * (points - 1);
  const buckets = Array.from({ length: points }, (_, index) => {
    const bucketStart = startMs + index * bucketMs;
    return {
      ts: bucketStart,
      label: labelFormat(bucketStart),
      usage: emptyUsage(),
    };
  });

  for (const event of events) {
    const ts = Number(event.ts ?? 0) || 0;
    if (!ts || ts < startMs) continue;
    const index = Math.min(points - 1, Math.max(0, Math.floor((ts - startMs) / bucketMs)));
    addUsage(buckets[index].usage, event);
  }

  return buckets.map((bucket) => ({
    ts: bucket.ts,
    label: bucket.label,
    input: bucket.usage.input,
    output: bucket.usage.output,
    cacheRead: bucket.usage.cacheRead,
    cacheWrite: bucket.usage.cacheWrite,
    total: bucket.usage.total,
    cost: bucket.usage.cost,
  }));
}

function categorizeSkill(filePath, workspacePath) {
  const normalized = String(filePath ?? '');
  if (!normalized) return 'unknown';
  if (workspacePath && normalized.startsWith(path.join(workspacePath, 'skills'))) return 'private';
  if (normalized.startsWith(GLOBAL_SKILLS_DIR)) return 'shared-managed';
  if (normalized.includes('/node_modules/openclaw/')) return 'bundled';
  return 'shared-external';
}

function readHeartbeatPrompt() {
  return 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';
}

function hasExplicitHeartbeatAgents(config) {
  return (config?.agents?.list ?? []).some((entry) => Boolean(entry?.heartbeat));
}

function parseDurationMs(raw) {
  if (!raw) return 0;
  const value = String(raw).trim().toLowerCase();
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'm';
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return Number.isFinite(amount) ? amount * multiplier : 0;
}

function resolveHeartbeatForAgent(config, agentId) {
  const defaults = config?.agents?.defaults?.heartbeat ?? {};
  const agentEntry = findAgentDefinition(config, agentId)?.raw ?? {};
  const selected = hasExplicitHeartbeatAgents(config) ? Boolean(agentEntry.heartbeat) : agentId === 'main';
  const merged = selected ? { ...defaults, ...(agentEntry.heartbeat ?? {}) } : { ...defaults };
  const every = String(merged?.every ?? defaults?.every ?? '30m').trim() || '30m';
  const everyMs = parseDurationMs(every);
  return {
    selected,
    enabled: selected && everyMs > 0,
    every,
    everyMs: everyMs > 0 ? everyMs : 0,
    target: merged?.target ?? defaults?.target ?? 'last',
    model: merged?.model ?? defaults?.model ?? null,
    to: merged?.to ?? null,
    prompt: merged?.prompt ?? defaults?.prompt ?? readHeartbeatPrompt(),
  };
}

async function summarizeSessionFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return null;

  const cached = sessionFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.summary;

  const raw = await fs.readFile(filePath, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  const summary = {
    filePath,
    sessionId: path.basename(filePath, '.jsonl'),
    startTs: 0,
    endTs: 0,
    usageEvents: [],
    requestHistory: [],
    lastUserMessage: null,
    lastHeartbeatAt: 0,
    lastModel: null,
  };

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const entryTs = toMs(entry?.timestamp) ?? toMs(entry?.message?.timestamp) ?? 0;
    if (!summary.startTs || (entryTs && entryTs < summary.startTs)) summary.startTs = entryTs;
    if (entryTs && entryTs > summary.endTs) summary.endTs = entryTs;

    if (entry?.type === 'model_change') {
      summary.lastModel = {
        provider: String(entry.provider ?? '').trim(),
        model: String(entry.modelId ?? '').trim(),
      };
      continue;
    }

    if (entry?.type !== 'message' || !entry.message) continue;

    const role = entry.message.role;
    if (role === 'user') {
      const rawText = extractTextFromContent(entry.message.content);
      if (!rawText) continue;
      const text = normalizeInboundUserText(rawText);
      const kind = inferRequestKind(rawText);
      const item = {
        ts: entryTs,
        kind,
        text: truncate(text, 1000),
      };
      if (kind === 'heartbeat' && entryTs > summary.lastHeartbeatAt) summary.lastHeartbeatAt = entryTs;
      summary.lastUserMessage = item;
      pushRolling(summary.requestHistory, item, 60);
      continue;
    }

    if (role === 'assistant') {
      const usage = normalizeUsage(entry.message.usage);
      if (usage.total > 0 || usage.input > 0 || usage.output > 0) {
        summary.usageEvents.push({ ts: entryTs, ...usage });
      }
      if (entry.message.provider || entry.message.model) {
        summary.lastModel = {
          provider: String(entry.message.provider ?? summary.lastModel?.provider ?? '').trim(),
          model: String(entry.message.model ?? summary.lastModel?.model ?? '').trim(),
        };
      }
    }
  }

  sessionFileCache.set(filePath, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

async function loadGatewayLogHeartbeat() {
  if (!(await exists(GATEWAY_LOG_PATH))) return { lastHeartbeatStartAt: 0 };
  const raw = await fs.readFile(GATEWAY_LOG_PATH, 'utf8').catch(() => '');
  const matches = Array.from(raw.matchAll(/^([^\n]+?)\s+\[heartbeat\] started$/gm));
  const last = matches.at(-1)?.[1] ?? null;
  return {
    lastHeartbeatStartAt: toMs(last) ?? 0,
  };
}

async function loadLaunchdServices() {
  const entries = await fs.readdir(LAUNCH_AGENTS_DIR, { withFileTypes: true }).catch(() => []);
  const plistFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('ai.openclaw') && entry.name.endsWith('.plist'))
    .map((entry) => path.join(LAUNCH_AGENTS_DIR, entry.name))
    .sort();

  const launchctl = await execFileText('launchctl', ['list']);
  const statuses = new Map();
  if (launchctl.ok) {
    for (const line of launchctl.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const label = parts.at(-1);
      if (!label?.startsWith('ai.openclaw')) continue;
      statuses.set(label, {
        pid: parts[0] === '-' ? null : Number(parts[0]),
        exitStatus: parts[1] === '-' ? null : Number(parts[1]),
      });
    }
  }

  const services = [];
  for (const plistPath of plistFiles) {
    const raw = await fs.readFile(plistPath, 'utf8').catch(() => '');
    const parsed = parseLaunchAgentPlist(raw);
    const status = statuses.get(parsed.label) ?? { pid: null, exitStatus: null };
    services.push({
      label: parsed.label || path.basename(plistPath, '.plist'),
      plistPath,
      program: parsed.program,
      programArguments: parsed.programArguments,
      startInterval: parsed.startInterval,
      loaded: statuses.has(parsed.label),
      pid: status.pid,
      exitStatus: status.exitStatus,
    });
  }

  return services;
}

async function loadCronJobs() {
  const jobsFile = await readJson(CRON_JOBS_PATH, { version: 1, jobs: [] });
  const jobs = Array.isArray(jobsFile?.jobs) ? jobsFile.jobs : [];
  const enriched = [];

  for (const job of jobs) {
    const runsPath = path.join(CRON_RUNS_DIR, `${job.id}.jsonl`);
    const raw = await fs.readFile(runsPath, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter(Boolean).slice(-10);
    const recentRuns = lines
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return {
            ts: parsed.ts ?? 0,
            status: parsed.status ?? 'unknown',
            summary: truncate(parsed.summary ?? parsed.error ?? '', 320),
            delivered: parsed.delivered ?? null,
            deliveryStatus: parsed.deliveryStatus ?? null,
            usage: normalizeUsage(parsed.usage),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    enriched.push({
      ...job,
      ownerAgentId: String(job.agentId ?? 'main'),
      recentRuns,
    });
  }

  return enriched.sort((left, right) => String(left.name ?? left.id ?? '').localeCompare(String(right.name ?? right.id ?? '')));
}

async function loadSharedSkills() {
  const managed = await fs.readdir(GLOBAL_SKILLS_DIR, { withFileTypes: true }).catch(() => []);
  return managed
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(GLOBAL_SKILLS_DIR, entry.name),
      category: 'shared-managed',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function createAlert({ id, scope, severity, agentId = null, title, detail }) {
  return { id, scope, severity, agentId, title, detail };
}

function sortAlerts(alerts) {
  const weight = { critical: 0, warn: 1, info: 2 };
  return alerts.sort((left, right) => {
    const severityDiff = (weight[left.severity] ?? 99) - (weight[right.severity] ?? 99);
    if (severityDiff !== 0) return severityDiff;
    return String(left.title ?? '').localeCompare(String(right.title ?? ''));
  });
}

function summarizeCronForAgent(agentId, cronJobs) {
  const scoped = cronJobs.filter((job) => String(job.ownerAgentId ?? 'main') === agentId);
  const lastRunAt = Math.max(0, ...scoped.flatMap((job) => job.recentRuns?.map((run) => Number(run.ts ?? 0) || 0) ?? [0]));
  const failing = scoped.filter((job) => {
    const lastRun = job.recentRuns?.[0] ?? null;
    const hasRunFailure = ['error', 'failed'].includes(String(lastRun?.status ?? '').toLowerCase());
    return Boolean(String(job.state?.lastError ?? '').trim()) || hasRunFailure;
  });
  return {
    total: scoped.length,
    enabled: scoped.filter((job) => Boolean(job.enabled)).length,
    failing: failing.length,
    lastRunAt,
    jobs: scoped,
  };
}

function buildAgentAlerts(agent, cronSummary, globalContext) {
  const alerts = [];
  const missingKeyProviders = agent.providers.filter((provider) => !String(provider.apiKey ?? '').trim());
  if (missingKeyProviders.length) {
    alerts.push(
      createAlert({
        id: `${agent.id}-missing-key`,
        scope: 'agent',
        severity: 'critical',
        agentId: agent.id,
        title: '存在空 API Key',
        detail: `通道 ${missingKeyProviders.map((provider) => provider.id).join('、')} 还没有配置密钥。`,
      }),
    );
  }

  if (!agent.lastRequest?.ts) {
    alerts.push(
      createAlert({
        id: `${agent.id}-no-traffic`,
        scope: 'agent',
        severity: 'info',
        agentId: agent.id,
        title: '暂无请求记录',
        detail: '还没有发现可展示的用户请求历史。',
      }),
    );
  } else if (globalContext.nowMs - agent.lastRequest.ts > 12 * 60 * 60 * 1000) {
    alerts.push(
      createAlert({
        id: `${agent.id}-quiet`,
        scope: 'agent',
        severity: 'info',
        agentId: agent.id,
        title: '请求较久未更新',
        detail: `最后一次请求距离现在已经超过 12 小时。`,
      }),
    );
  }

  if (agent.heartbeat.enabled) {
    if (!agent.lastHeartbeatAt) {
      alerts.push(
        createAlert({
          id: `${agent.id}-heartbeat-missing`,
          scope: 'agent',
          severity: 'warn',
          agentId: agent.id,
          title: '心跳已配置但暂无执行记录',
          detail: `当前间隔为 ${agent.heartbeat.every}，还没有读到心跳执行痕迹。`,
        }),
      );
    } else if (agent.heartbeat.everyMs && globalContext.nowMs - agent.lastHeartbeatAt > agent.heartbeat.everyMs * 2.2) {
      alerts.push(
        createAlert({
          id: `${agent.id}-heartbeat-stale`,
          scope: 'agent',
          severity: 'critical',
          agentId: agent.id,
          title: '心跳超时',
          detail: `最近一次心跳已超过配置间隔的 2.2 倍。`,
        }),
      );
    }
  }

  if (cronSummary.failing > 0) {
    alerts.push(
      createAlert({
        id: `${agent.id}-cron-failing`,
        scope: 'agent',
        severity: 'warn',
        agentId: agent.id,
        title: '存在异常定时任务',
        detail: `${cronSummary.failing} 个 Cron 最近执行失败或带有 lastError。`,
      }),
    );
  }

  return sortAlerts(alerts);
}

async function buildAgentSnapshot(config, agent, globalContext) {
  const sessionsIndex = await readJson(path.join(agent.sessionDir, 'sessions.json'), {});
  const sessionFiles = await fs.readdir(agent.sessionDir).catch(() => []);
  const jsonlFiles = sessionFiles.filter((fileName) => fileName.endsWith('.jsonl')).map((fileName) => path.join(agent.sessionDir, fileName));
  const summaries = (await Promise.all(jsonlFiles.map((filePath) => summarizeSessionFile(filePath)))).filter(Boolean);
  const usageEvents = summaries.flatMap((summary) => summary.usageEvents);
  const requestHistory = summaries
    .flatMap((summary) => summary.requestHistory.map((request) => ({ ...request, sessionId: summary.sessionId })))
    .sort((left, right) => right.ts - left.ts)
    .slice(0, 24);
  const lastRequest = requestHistory[0] ?? null;
  const lastHeartbeatAt = Math.max(0, ...summaries.map((summary) => summary.lastHeartbeatAt ?? 0));
  const latestSummary = summaries.slice().sort((left, right) => right.endTs - left.endTs)[0] ?? null;
  const currentSession =
    sessionsIndex?.[`agent:${agent.id}:main`] ??
    Object.values(sessionsIndex ?? {}).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0] ??
    null;
  const currentModel = {
    provider: String(currentSession?.modelProvider ?? latestSummary?.lastModel?.provider ?? '').trim(),
    model: String(currentSession?.model ?? latestSummary?.lastModel?.model ?? '').trim(),
  };
  const heartbeat = resolveHeartbeatForAgent(config, agent.id);
  const markdownFiles = await listMarkdownFiles(agent.workspace);
  const modelsConfig = await readJson(agent.modelsPath, { providers: {} });
  const providers = Object.entries(modelsConfig?.providers ?? {}).map(([providerId, provider]) => ({
    id: providerId,
    api: provider?.api ?? '',
    baseUrl: provider?.baseUrl ?? '',
    apiKey: provider?.apiKey ?? '',
    apiKeyMasked: maskApiKey(provider?.apiKey ?? ''),
    modelIds: Array.isArray(provider?.models) ? provider.models.map((model) => model?.id).filter(Boolean) : [],
  }));
  const skillSnapshot = currentSession?.skillsSnapshot?.resolvedSkills ?? [];
  const skills = skillSnapshot.map((skill) => ({
    name: skill.name,
    filePath: skill.filePath,
    source: skill.source,
    category: categorizeSkill(skill.filePath, agent.workspace),
  }));
  const privateSkills = skills.filter((skill) => skill.category === 'private');
  const requestUpdatedAt = Number(currentSession?.updatedAt ?? 0) || latestSummary?.endTs || 0;
  const lastActivityAt = Math.max(requestUpdatedAt, lastHeartbeatAt);
  const now = globalContext.nowMs;
  let status = 'idle';
  if (!globalContext.gatewayOnline) status = 'offline';
  else if (lastActivityAt && now - lastActivityAt < 15 * 60 * 1000) status = 'active';
  else if (heartbeat.enabled && heartbeat.everyMs && lastHeartbeatAt && now - lastHeartbeatAt > heartbeat.everyMs * 2.2) status = 'stale';

  return {
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    agentDir: agent.agentDir,
    status,
    currentModel,
    lastActivityAt,
    lastRequest,
    requestHistory,
    lastHeartbeatAt,
    heartbeat,
    usageEventsCount: usageEvents.length,
    tokens: buildUsageWindows(usageEvents, globalContext.nowMs, globalContext.startOfTodayMs),
    tokenTrend24h: buildUsageTrend(usageEvents, {
      nowMs: globalContext.nowMs,
      bucketMs: 60 * 60 * 1000,
      points: 24,
      labelFormat: formatHourLabel,
    }),
    tokenTrend7d: buildUsageTrend(usageEvents, {
      nowMs: globalContext.nowMs,
      bucketMs: 24 * 60 * 60 * 1000,
      points: 7,
      labelFormat: formatDayLabel,
    }),
    sessions: Object.entries(sessionsIndex ?? {}).map(([key, value]) => ({
      key,
      updatedAt: value?.updatedAt ?? 0,
      sessionId: value?.sessionId ?? '',
      modelProvider: value?.modelProvider ?? '',
      model: value?.model ?? '',
    })),
    providers,
    markdownFiles,
    skills: {
      effective: skills,
      private: privateSkills,
    },
  };
}

function buildGlobalUsage(agentSnapshots) {
  const result = {
    total: emptyUsage(),
    today: emptyUsage(),
    last1h: emptyUsage(),
    last3h: emptyUsage(),
    last6h: emptyUsage(),
    last24h: emptyUsage(),
    last7d: emptyUsage(),
  };

  for (const agent of agentSnapshots) {
    for (const key of Object.keys(result)) {
      addUsage(result[key], agent.tokens[key]);
    }
  }

  return result;
}

function buildSummary(agentSnapshots, globalAlerts, providerPresets) {
  const lastRequestAt = Math.max(0, ...agentSnapshots.map((agent) => Number(agent.lastRequest?.ts ?? 0) || 0));
  return {
    agentCount: agentSnapshots.length,
    activeCount: agentSnapshots.filter((agent) => agent.status === 'active').length,
    idleCount: agentSnapshots.filter((agent) => agent.status === 'idle').length,
    staleCount: agentSnapshots.filter((agent) => agent.status === 'stale').length,
    offlineCount: agentSnapshots.filter((agent) => agent.status === 'offline').length,
    lastRequestAt,
    alerts: {
      total: globalAlerts.length,
      critical: globalAlerts.filter((alert) => alert.severity === 'critical').length,
      warn: globalAlerts.filter((alert) => alert.severity === 'warn').length,
      info: globalAlerts.filter((alert) => alert.severity === 'info').length,
    },
    providerPresetCount: providerPresets.length,
  };
}

function buildGlobalAlerts(gateway, services, agentSnapshots, cronJobs) {
  const alerts = [];
  if (!gateway.online) {
    alerts.push(
      createAlert({
        id: 'gateway-offline',
        scope: 'global',
        severity: 'critical',
        title: 'OpenClaw 网关离线',
        detail: 'ai.openclaw.gateway 当前没有加载，所有请求都可能无法送达。',
      }),
    );
  }

  const stoppedServices = services.filter((service) => !service.loaded);
  if (stoppedServices.length) {
    alerts.push(
      createAlert({
        id: 'services-stopped',
        scope: 'global',
        severity: 'info',
        title: '存在未加载常驻服务',
        detail: `当前有 ${stoppedServices.length} 个 ai.openclaw.* 服务未加载。`,
      }),
    );
  }

  const failingCronCount = cronJobs.filter((job) => {
    const lastRun = job.recentRuns?.[0] ?? null;
    return Boolean(String(job.state?.lastError ?? '').trim()) || ['error', 'failed'].includes(String(lastRun?.status ?? '').toLowerCase());
  }).length;
  if (failingCronCount > 0) {
    alerts.push(
      createAlert({
        id: 'cron-failing',
        scope: 'global',
        severity: 'warn',
        title: '存在异常 Cron',
        detail: `总共有 ${failingCronCount} 个 Cron 最近失败或仍带 lastError。`,
      }),
    );
  }

  const staleAgents = agentSnapshots.filter((agent) => agent.status === 'stale');
  if (staleAgents.length > 0) {
    alerts.push(
      createAlert({
        id: 'agents-stale',
        scope: 'global',
        severity: 'warn',
        title: '部分小龙虾掉队',
        detail: `${staleAgents.map((agent) => agent.name).join('、')} 当前处于异常状态。`,
      }),
    );
  }

  return sortAlerts(alerts);
}

export async function buildOverview() {
  const [config, services, gatewayLog, cronJobs, sharedSkills, monitorState] = await Promise.all([
    readJson(OPENCLAW_CONFIG_PATH, {}),
    loadLaunchdServices(),
    loadGatewayLogHeartbeat(),
    loadCronJobs(),
    loadSharedSkills(),
    loadMonitorState(),
  ]);

  const agents = resolveConfiguredAgents(config);
  const gatewayService = services.find((service) => service.label === 'ai.openclaw.gateway') ?? null;
  const now = Date.now();
  const globalContext = {
    nowMs: now,
    startOfTodayMs: startOfTodayMs(),
    gatewayOnline: Boolean(gatewayService?.loaded),
  };

  const baseSnapshots = await Promise.all(agents.map((agent) => buildAgentSnapshot(config, agent, globalContext)));
  const agentSnapshots = baseSnapshots.map((agent) => {
    const cronSummary = summarizeCronForAgent(agent.id, cronJobs);
    const alerts = buildAgentAlerts(agent, cronSummary, globalContext);
    return {
      ...agent,
      cronSummary: {
        total: cronSummary.total,
        enabled: cronSummary.enabled,
        failing: cronSummary.failing,
        lastRunAt: cronSummary.lastRunAt,
      },
      alerts,
    };
  });

  const globalAlerts = buildGlobalAlerts(
    {
      online: Boolean(gatewayService?.loaded),
      service: gatewayService,
      lastHeartbeatRunnerAt: gatewayLog.lastHeartbeatStartAt,
    },
    services,
    agentSnapshots,
    cronJobs,
  );

  return {
    generatedAt: now,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    summary: {
      ...buildSummary(agentSnapshots, globalAlerts, monitorState.providerPresets),
      usage: buildGlobalUsage(agentSnapshots),
    },
    gateway: {
      online: Boolean(gatewayService?.loaded),
      service: gatewayService,
      lastHeartbeatRunnerAt: gatewayLog.lastHeartbeatStartAt,
    },
    services,
    sharedSkills,
    providerPresets: monitorState.providerPresets,
    alerts: globalAlerts,
    cronJobs,
    agents: agentSnapshots,
  };
}
