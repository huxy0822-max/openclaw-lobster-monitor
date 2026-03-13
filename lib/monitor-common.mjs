import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.resolve(__dirname, '..');
export const OPENCLAW_HOME = path.join(os.homedir(), '.openclaw');
export const OPENCLAW_CONFIG_PATH = path.join(OPENCLAW_HOME, 'openclaw.json');
export const OPENCLAW_AGENTS_HOME = path.join(OPENCLAW_HOME, 'agents');
export const MAIN_AGENT_DIR = path.join(OPENCLAW_AGENTS_HOME, 'main', 'agent');
export const MAIN_WORKSPACE = path.join(OPENCLAW_HOME, 'workspace');
export const CRON_JOBS_PATH = path.join(OPENCLAW_HOME, 'cron', 'jobs.json');
export const CRON_RUNS_DIR = path.join(OPENCLAW_HOME, 'cron', 'runs');
export const GATEWAY_LOG_PATH = path.join(OPENCLAW_HOME, 'logs', 'gateway.log');
export const GATEWAY_ERR_LOG_PATH = path.join(OPENCLAW_HOME, 'logs', 'gateway.err.log');
export const GLOBAL_SKILLS_DIR = path.join(OPENCLAW_HOME, 'skills');
export const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
export const MONITOR_STATE_PATH = path.join(APP_ROOT, 'data', 'monitor-state.json');

export async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function readJson(targetPath, fallback = null) {
  try {
    const raw = await fs.readFile(targetPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(targetPath, value) {
  await writeTextAtomic(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(targetPath, value) {
  const directory = path.dirname(targetPath);
  await ensureDir(directory);
  const tempPath = path.join(directory, `.${path.basename(targetPath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, targetPath);
}

export function resolveConfiguredAgents(config) {
  const list = config?.agents?.list ?? [];
  const agents = [];
  const seen = new Set();

  for (const entry of list) {
    const id = String(entry?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    agents.push({
      id,
      name: String(entry?.name ?? id),
      workspace: entry?.workspace ? path.resolve(entry.workspace) : id === 'main' ? MAIN_WORKSPACE : null,
      agentDir: entry?.agentDir ? path.resolve(entry.agentDir) : id === 'main' ? MAIN_AGENT_DIR : null,
      heartbeat: entry?.heartbeat ?? null,
      raw: entry,
    });
  }

  if (!seen.has('main')) {
    agents.unshift({
      id: 'main',
      name: 'main',
      workspace: MAIN_WORKSPACE,
      agentDir: MAIN_AGENT_DIR,
      heartbeat: null,
      raw: { id: 'main' },
    });
  }

  return agents.map((agent) => ({
    ...agent,
    sessionDir: path.join(OPENCLAW_AGENTS_HOME, agent.id, 'sessions'),
    modelsPath: agent.agentDir ? path.join(agent.agentDir, 'models.json') : null,
  }));
}

export function findAgentDefinition(config, agentId) {
  return resolveConfiguredAgents(config).find((agent) => agent.id === agentId) ?? null;
}

export async function listMarkdownFiles(rootDir) {
  if (!rootDir || !(await exists(rootDir))) return [];
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.git')) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      const stat = await fs.stat(absolutePath).catch(() => null);
      results.push({
        path: absolutePath,
        relativePath: path.relative(rootDir, absolutePath),
        name: entry.name,
        size: stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
      });
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function ensurePathInside(rootDir, requestedPath) {
  const resolvedRoot = path.resolve(rootDir);
  const candidate = path.resolve(resolvedRoot, requestedPath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`) && candidate !== resolvedRoot) {
    throw new Error('Path escapes workspace root.');
  }
  return candidate;
}

export function maskApiKey(apiKey) {
  const value = String(apiKey ?? '').trim();
  if (!value) return '';
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function truncate(text, limit = 240) {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

export function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function startOfTodayMs(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk;
      if (!chunk || typeof chunk !== 'object') return '';
      if (chunk.type === 'text') return String(chunk.text ?? '');
      if (chunk.type === 'toolCall') return `[tool:${chunk.name ?? 'unknown'}]`;
      if (chunk.type === 'toolResult') return `[tool-result:${chunk.toolName ?? 'unknown'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function normalizeInboundUserText(rawText) {
  const raw = String(rawText ?? '').trim();
  if (!raw) return '';
  const feishuMatch = raw.match(/\[message_id:[^\]]+\]\n[^:\n]+:\s*([\s\S]*)$/);
  if (feishuMatch?.[1]) return feishuMatch[1].trim();
  return raw;
}

export function inferRequestKind(text) {
  const value = String(text ?? '');
  if (!value) return 'chat';
  if (value.includes('Read HEARTBEAT.md if it exists')) return 'heartbeat';
  if (value.startsWith('[cron:')) return 'cron';
  return 'chat';
}

export function pushRolling(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
}

export async function execFileText(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    };
  }
}

export function parseLaunchAgentPlist(plistText) {
  const readString = (key) => {
    const pattern = new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`, 'i');
    return plistText.match(pattern)?.[1]?.trim() ?? '';
  };

  const label = readString('Label');
  const program = readString('Program');
  const startInterval = Number(plistText.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/i)?.[1] ?? 0) || null;
  const argumentsBlock = plistText.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i)?.[1] ?? '';
  const programArguments = Array.from(argumentsBlock.matchAll(/<string>([^<]*)<\/string>/gi)).map((match) => match[1]);

  return {
    label,
    program,
    programArguments,
    startInterval,
  };
}

export async function loadMonitorState() {
  const current = await readJson(MONITOR_STATE_PATH, {});
  return {
    heartbeats: current?.heartbeats ?? {},
    providerPresets: Array.isArray(current?.providerPresets) ? current.providerPresets : [],
  };
}

export async function saveMonitorState(state) {
  await writeJsonAtomic(MONITOR_STATE_PATH, state);
}
