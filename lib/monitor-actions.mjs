import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  resolveConfiguredAgents,
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

function sanitizePresetInput(preset = {}, fallbackId = '') {
  const name = requireString(preset.name, 'name');
  return {
    id: String(preset.id ?? fallbackId ?? '').trim() || `preset-${randomUUID()}`,
    name,
    apiKey: String(preset.apiKey ?? '').trim(),
    baseUrl: String(preset.baseUrl ?? '').trim(),
    api: String(preset.api ?? '').trim(),
    modelId: String(preset.modelId ?? '').trim(),
    providerId: String(preset.providerId ?? '').trim(),
    note: String(preset.note ?? '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

async function patchAgentProvider(agentId, providerId, patch) {
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
}

export async function updateAgentProvider(agentId, providerId, patch) {
  await patchAgentProvider(agentId, providerId, patch);
  return { ok: true };
}

export async function upsertProviderPreset(payload) {
  const state = await loadMonitorState();
  const nextPreset = sanitizePresetInput(payload, payload?.id);
  const presets = [...state.providerPresets];
  const index = presets.findIndex((preset) => preset.id === nextPreset.id);

  if (index === -1) presets.unshift(nextPreset);
  else presets[index] = nextPreset;

  state.providerPresets = presets.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
  await saveMonitorState(state);
  return { ok: true, preset: nextPreset };
}

export async function deleteProviderPreset(presetId) {
  const state = await loadMonitorState();
  const next = state.providerPresets.filter((preset) => preset.id !== presetId);
  if (next.length === state.providerPresets.length) {
    throw new Error(`Preset not found: ${presetId}`);
  }
  state.providerPresets = next;
  await saveMonitorState(state);
  return { ok: true };
}

export async function applyProviderPreset(presetId, payload = {}) {
  const state = await loadMonitorState();
  const preset = state.providerPresets.find((entry) => entry.id === presetId);
  if (!preset) throw new Error(`Preset not found: ${presetId}`);

  const config = await loadConfig();
  const configuredAgents = resolveConfiguredAgents(config);
  const requestedProviderId = String(payload.providerId ?? preset.providerId ?? '').trim();
  if (!requestedProviderId) throw new Error('providerId is required.');

  const targetAgents =
    payload.scope === 'all'
      ? configuredAgents
      : configuredAgents.filter((agent) => agent.id === String(payload.agentId ?? '').trim());

  if (targetAgents.length === 0) {
    throw new Error('No target agents matched the apply request.');
  }

  const patch = {};
  if (preset.apiKey) patch.apiKey = preset.apiKey;
  if (preset.baseUrl) patch.baseUrl = preset.baseUrl;
  if (preset.api) patch.api = preset.api;
  if (preset.modelId) patch.modelId = preset.modelId;
  if (Object.keys(patch).length === 0) {
    throw new Error('Preset does not contain any fields to apply.');
  }

  const applied = [];
  const skipped = [];

  for (const agent of targetAgents) {
    try {
      await patchAgentProvider(agent.id, requestedProviderId, patch);
      applied.push({ agentId: agent.id, providerId: requestedProviderId });
    } catch (error) {
      skipped.push({
        agentId: agent.id,
        providerId: requestedProviderId,
        reason: String(error?.message ?? error),
      });
    }
  }

  return {
    ok: true,
    applied,
    skipped,
  };
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

export async function deleteCronJob(jobId) {
  const jobsFile = await readJson(CRON_JOBS_PATH, { version: 1, jobs: [] });
  const jobs = Array.isArray(jobsFile?.jobs) ? [...jobsFile.jobs] : [];
  const nextJobs = jobs.filter((job) => String(job?.id ?? '') !== jobId);
  if (nextJobs.length === jobs.length) {
    throw new Error(`Cron job not found: ${jobId}`);
  }
  jobsFile.jobs = nextJobs;
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
