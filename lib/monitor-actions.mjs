import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CRON_JOBS_PATH,
  LAUNCH_AGENTS_DIR,
  OPENCLAW_CONFIG_PATH,
  ensurePathInside,
  execFileText,
  findAgentDefinition,
  loadMonitorState,
  readJson,
  saveMonitorState,
  writeJsonAtomic,
  writeTextAtomic,
} from './monitor-common.mjs';

function requireString(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

async function loadConfig() {
  return readJson(OPENCLAW_CONFIG_PATH, {});
}

async function loadAgentContext(agentId) {
  const config = await loadConfig();
  const agent = findAgentDefinition(config, agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return { config, agent };
}

export async function updateAgentProvider(agentId, providerId, patch) {
  const { agent } = await loadAgentContext(agentId);
  const modelsPath = agent.modelsPath;
  if (!modelsPath) throw new Error(`Agent ${agentId} has no models.json path.`);
  const modelsConfig = await readJson(modelsPath, { providers: {} });
  if (!modelsConfig?.providers?.[providerId]) {
    throw new Error(`Provider ${providerId} does not exist for ${agentId}.`);
  }

  const provider = {
    ...modelsConfig.providers[providerId],
  };

  if ('apiKey' in patch) provider.apiKey = requireString(patch.apiKey, 'apiKey');
  if ('baseUrl' in patch) provider.baseUrl = requireString(patch.baseUrl, 'baseUrl');
  if ('api' in patch && String(patch.api ?? '').trim()) provider.api = String(patch.api).trim();
  if ('modelId' in patch && String(patch.modelId ?? '').trim()) {
    const modelId = String(patch.modelId).trim();
    const firstModel = provider.models?.[0] ?? { id: modelId, name: modelId };
    provider.models = [{ ...firstModel, id: modelId, name: modelId }];
  }

  modelsConfig.providers[providerId] = provider;
  await writeJsonAtomic(modelsPath, modelsConfig);
  return { ok: true };
}

export async function updateAgentHeartbeat(agentId, patch) {
  const config = await loadConfig();
  const list = Array.isArray(config?.agents?.list) ? [...config.agents.list] : [];
  let index = list.findIndex((entry) => String(entry?.id ?? '').trim() === agentId);
  if (index === -1) {
    list.push({ id: agentId });
    index = list.length - 1;
  }

  const state = await loadMonitorState();
  const entry = { ...list[index] };
  const heartbeat = { ...(entry.heartbeat ?? {}) };
  const defaults = config?.agents?.defaults?.heartbeat ?? {};
  const storedEvery = state.heartbeats?.[agentId]?.lastEnabledEvery;
  const previousEvery = String(heartbeat.every ?? defaults.every ?? '30m').trim() || '30m';

  if (patch.enabled === false) {
    state.heartbeats[agentId] = { lastEnabledEvery: previousEvery === '0m' ? storedEvery ?? '30m' : previousEvery };
    heartbeat.every = '0m';
  } else if (patch.enabled === true) {
    heartbeat.every = String(patch.every ?? (previousEvery !== '0m' ? previousEvery : storedEvery ?? defaults.every ?? '30m')).trim();
    state.heartbeats[agentId] = { lastEnabledEvery: heartbeat.every };
  }

  if ('every' in patch && patch.every != null) {
    const value = String(patch.every).trim();
    if (value) heartbeat.every = value;
  }

  for (const field of ['target', 'model', 'prompt', 'to']) {
    if (!(field in patch) || patch[field] == null) continue;
    const value = String(patch[field]).trim();
    if (value) heartbeat[field] = value;
    else delete heartbeat[field];
  }

  entry.heartbeat = heartbeat;
  list[index] = entry;
  config.agents = { ...(config.agents ?? {}), list };
  await writeJsonAtomic(OPENCLAW_CONFIG_PATH, config);
  await saveMonitorState(state);
  return { ok: true };
}

export async function updateCronJob(jobId, payload) {
  const jobsFile = await readJson(CRON_JOBS_PATH, { version: 1, jobs: [] });
  const jobs = Array.isArray(jobsFile?.jobs) ? [...jobsFile.jobs] : [];
  const index = jobs.findIndex((job) => String(job?.id ?? '') === jobId);
  if (index === -1) throw new Error(`Cron job not found: ${jobId}`);

  if (payload?.job && typeof payload.job === 'object') {
    if (String(payload.job.id ?? '') !== jobId) throw new Error('Cron job id mismatch.');
    jobs[index] = payload.job;
  } else {
    jobs[index] = {
      ...jobs[index],
      ...payload,
    };
  }

  jobsFile.jobs = jobs;
  await writeJsonAtomic(CRON_JOBS_PATH, jobsFile);
  return { ok: true };
}

export async function readMarkdownFile(agentId, relativePath) {
  const { agent } = await loadAgentContext(agentId);
  const absolutePath = ensurePathInside(agent.workspace, requireString(relativePath, 'path'));
  if (!absolutePath.toLowerCase().endsWith('.md')) throw new Error('Only .md files are allowed.');
  const content = await fs.readFile(absolutePath, 'utf8');
  return { path: absolutePath, content };
}

export async function writeMarkdownFile(agentId, relativePath, content) {
  const { agent } = await loadAgentContext(agentId);
  const absolutePath = ensurePathInside(agent.workspace, requireString(relativePath, 'path'));
  if (!absolutePath.toLowerCase().endsWith('.md')) throw new Error('Only .md files are allowed.');
  await writeTextAtomic(absolutePath, String(content ?? ''));
  return { ok: true };
}

export async function toggleLaunchdService(label, enabled) {
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  await fs.access(plistPath);
  const uid = String(process.getuid?.() ?? os.userInfo().uid);
  if (enabled) {
    const bootstrap = await execFileText('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    if (!bootstrap.ok) throw new Error(bootstrap.stderr || 'launchctl bootstrap failed');
    return { ok: true };
  }

  const bootout = await execFileText('launchctl', ['bootout', `gui/${uid}`, plistPath]);
  if (!bootout.ok) throw new Error(bootout.stderr || 'launchctl bootout failed');
  return { ok: true };
}
