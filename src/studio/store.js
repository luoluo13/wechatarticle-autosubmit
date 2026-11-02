import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dirs } from '../config.js';
import { DEFAULT_TEMPLATES } from './prompts.js';
import { normalizeConnection } from './providers.js';

/**
 * 创作间的本地存储：
 * data/studio/connections.json  连接（含 API Key，明文只落在本地，不进仓库）
 * data/studio/templates.json    自定义提示词模板
 * data/studio/sessions.json     会话索引
 * data/studio/sessions/<id>.json 会话正文
 */

const CONNECTIONS = path.join(dirs.studio, 'connections.json');
const TEMPLATES = path.join(dirs.studio, 'templates.json');
const SESSIONS_INDEX = path.join(dirs.studio, 'sessions.json');
const SESSION_DIR = path.join(dirs.studio, 'sessions');

async function ensureDirs() {
  await fs.mkdir(SESSION_DIR, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDirs();
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/* --------------------------------- 连接管理 -------------------------------- */

export async function listConnections() {
  const raw = await readJson(CONNECTIONS, []);
  return (Array.isArray(raw) ? raw : []).map((item) => normalizeConnection(item));
}

/** 返回给前端时一定去掉明文 Key，只留掩码 */
export function publicConnection(connection) {
  const { apiKey, ...rest } = connection;
  return { ...rest, apiKey: '', hasKey: Boolean(apiKey), keyHint: maskKey(apiKey) };
}

export async function saveConnection(input = {}) {
  const list = await listConnections();
  const target = normalizeConnection(input);
  const index = list.findIndex((item) => item.id === target.id);
  const previous = index >= 0 ? list[index] : null;

  // 前端不回传明文，空 apiKey 表示沿用旧值
  if (!target.apiKey && previous) target.apiKey = previous.apiKey;
  if (input.clearKey) target.apiKey = '';

  if (index >= 0) list[index] = target;
  else list.push(target);
  await writeJson(CONNECTIONS, list);
  return publicConnection(target);
}

export async function removeConnection(id) {
  const list = await listConnections();
  const next = list.filter((item) => item.id !== id);
  await writeJson(CONNECTIONS, next);
  return { id };
}

export async function getConnection(id) {
  const list = await listConnections();
  return list.find((item) => item.id === id) || null;
}

/* --------------------------------- 提示词模板 ------------------------------- */

export async function listTemplates() {
  const custom = await readJson(TEMPLATES, []);
  return [
    ...DEFAULT_TEMPLATES.map((item) => ({ ...item, builtin: true })),
    ...(Array.isArray(custom) ? custom : []).map((item) => ({ ...item, builtin: false })),
  ];
}

export async function saveTemplate(input = {}) {
  const custom = await readJson(TEMPLATES, []);
  const list = Array.isArray(custom) ? custom : [];
  const id = String(input.id || '').trim();
  const target = {
    id: id && !DEFAULT_TEMPLATES.some((item) => item.id === id) ? id : `custom-${randomUUID().slice(0, 8)}`,
    name: String(input.name || '').trim() || '未命名模板',
    desc: String(input.desc || '').trim(),
    system: String(input.system || ''),
    user: String(input.user || ''),
  };
  const index = list.findIndex((item) => item.id === target.id);
  if (index >= 0) list[index] = target;
  else list.push(target);
  await writeJson(TEMPLATES, list);
  return { ...target, builtin: false };
}

export async function removeTemplate(id) {
  if (DEFAULT_TEMPLATES.some((item) => item.id === id)) {
    throw new Error('内置模板不能删除，可以先复制一份再改');
  }
  const custom = await readJson(TEMPLATES, []);
  await writeJson(
    TEMPLATES,
    (Array.isArray(custom) ? custom : []).filter((item) => item.id !== id),
  );
  return { id };
}

/* ---------------------------------- 会话 ---------------------------------- */

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function sessionFile(id) {
  if (!SESSION_ID.test(String(id || ''))) throw new Error('会话 ID 不合法');
  return path.join(SESSION_DIR, `${id}.json`);
}

async function readIndex() {
  const raw = await readJson(SESSIONS_INDEX, []);
  return Array.isArray(raw) ? raw : [];
}

export async function listSessions() {
  const index = await readIndex();
  return index.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function readSession(id) {
  const session = await readJson(sessionFile(id), null);
  if (!session) throw new Error('会话不存在');
  return session;
}

export async function writeSession(session) {
  await writeJson(sessionFile(session.id), session);
  const index = await readIndex();
  const summary = {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    connectionId: session.connectionId || '',
    templateId: session.templateId || '',
    platform: session.platform || '',
    messages: session.messages?.length || 0,
    articleSlug: session.articleSlug || '',
  };
  const position = index.findIndex((item) => item.id === session.id);
  if (position >= 0) index[position] = summary;
  else index.push(summary);
  await writeJson(SESSIONS_INDEX, index);
  return session;
}

export async function createSession(input = {}) {
  const now = new Date().toISOString();
  const session = {
    id: `s-${randomUUID().slice(0, 8)}`,
    title: String(input.title || '未命名会话'),
    createdAt: now,
    updatedAt: now,
    connectionId: String(input.connectionId || ''),
    templateId: String(input.templateId || ''),
    platform: String(input.platform || ''),
    params: input.params || {},
    draft: '',
    messages: [],
    usage: { input: 0, output: 0 },
    articleSlug: '',
  };
  await writeSession(session);
  return session;
}

export async function removeSession(id) {
  await fs.rm(sessionFile(id), { force: true });
  const index = await readIndex();
  await writeJson(
    SESSIONS_INDEX,
    index.filter((item) => item.id !== id),
  );
  return { id };
}
