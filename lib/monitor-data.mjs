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

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  }

  const input = Number(usage.input ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.output ?? usage.output_tokens ?? 0) || 0;
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read_tokens ?? 0) || 0;
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0) || 0;
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + output + cacheRead + cacheWrite) || 0;
  const cost = Number(usage?.cost?.total ?? usage.total_cost_usd ?? 0) || 0;
  return { input, output, cacheRead, cacheWrite, total, cost };
}

function sumUsage(events, sinceMs = 0) {
  return events.reduce(
    (accumulator, event) => {
      if ((event.ts ?? 0) < sinceMs) return accumulator;
      accumulator.input += event.input;
      accumulator.output += event.output;
      accumulator.cacheRead += event.cacheRead;
      accumulator.cacheWrite += event.cacheWrite;
      accumulator.total += event.total;
      accumulator.cost += event.cost;
      return accumulator;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
  );
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

function resolveHeartbeatForAgent(config, agentId) {
  const defaults = config?.agents?.defaults?.heartbeat ?? {};
  const agentEntry = findAgentDefinition(config, agentId)?.raw ?? {};
  const selected = hasExplicitHeartbeatAgents(config)
    ? Boolean(agentEntry.heartbeat)
    : agentId === 'main';
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

async function summarizeSessionFile(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  const cached = sessionFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.summary;
  }

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

    if (entry?.type !== 'message' || !entry.message) {
      continue;
    }

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
      if (kind === 'heartbeat' && entryTs > summary.lastHeartbeatAt) {
        summary.lastHeartbeatAt = entryTs;
      }
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

  return enriched.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
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

async function buildAgentSnapshot(config, agent, globalContext) {
  const sessionsIndex = await readJson(path.join(agent.sessionDir, 'sessions.json'), {});
  const sessionFiles = await fs.readdir(agent.sessionDir).catch(() => []);
  const jsonlFiles = sessionFiles
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .map((fileName) => path.join(agent.sessionDir, fileName));
  const summaries = (await Promise.all(jsonlFiles.map((filePath) => summarizeSessionFile(filePath)))).filter(Boolean);
  const usageEvents = summaries.flatMap((summary) => summary.usageEvents);
  const requestHistory = summaries
    .flatMap((summary) => summary.requestHistory.map((request) => ({ ...request, sessionId: summary.sessionId })))
    .sort((left, right) => right.ts - left.ts)
    .slice(0, 16);
  const lastRequest = requestHistory[0] ?? null;
  const lastHeartbeatAt = Math.max(0, ...summaries.map((summary) => summary.lastHeartbeatAt ?? 0));
  const latestSummary = summaries.slice().sort((left, right) => right.endTs - left.endTs)[0] ?? null;
  const currentSession = sessionsIndex?.[`agent:${agent.id}:main`] ?? Object.values(sessionsIndex ?? {}).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0] ?? null;
  const currentModel = {
    provider: String(currentSession?.modelProvider ?? latestSummary?.lastModel?.provider ?? '').trim(),
    model: String(currentSession?.model ?? latestSummary?.lastModel?.model ?? '').trim(),
  };
  const todayUsage = sumUsage(usageEvents, globalContext.startOfTodayMs);
  const recentUsage = sumUsage(usageEvents, globalContext.recentWindowStartMs);
  const totalUsage = sumUsage(usageEvents, 0);
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
  if (!globalContext.gatewayOnline) {
    status = 'offline';
  } else if (lastActivityAt && now - lastActivityAt < 15 * 60 * 1000) {
    status = 'active';
  } else if (heartbeat.enabled && heartbeat.everyMs && lastHeartbeatAt && now - lastHeartbeatAt > heartbeat.everyMs * 2.2) {
    status = 'stale';
  }

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
    tokens: {
      total: totalUsage,
      today: todayUsage,
      last6h: recentUsage,
    },
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

export async function buildOverview() {
  const config = await readJson(OPENCLAW_CONFIG_PATH, {});
  const agents = resolveConfiguredAgents(config);
  const services = await loadLaunchdServices();
  const gatewayService = services.find((service) => service.label === 'ai.openclaw.gateway') ?? null;
  const gatewayLog = await loadGatewayLogHeartbeat();
  const cronJobs = await loadCronJobs();
  const sharedSkills = await loadSharedSkills();
  const now = Date.now();
  const globalContext = {
    nowMs: now,
    startOfTodayMs: startOfTodayMs(),
    recentWindowStartMs: now - 6 * 60 * 60 * 1000,
    gatewayOnline: Boolean(gatewayService?.loaded),
  };
  const agentSnapshots = await Promise.all(agents.map((agent) => buildAgentSnapshot(config, agent, globalContext)));

  return {
    generatedAt: now,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gateway: {
      online: Boolean(gatewayService?.loaded),
      service: gatewayService,
      lastHeartbeatRunnerAt: gatewayLog.lastHeartbeatStartAt,
    },
    services,
    sharedSkills,
    cronJobs,
    agents: agentSnapshots,
  };
}
