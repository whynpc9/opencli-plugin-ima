import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STATE_VERSION = 1;

export function getAskSessionStatePath() {
  return process.env.IMA_SESSION_STATE_FILE ||
    path.join(os.homedir(), '.opencli-ima', 'ask-sessions.json');
}

export function readAskSessionState() {
  const file = getAskSessionStatePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      byKnowledgeBaseId: parsed.byKnowledgeBaseId && typeof parsed.byKnowledgeBaseId === 'object'
        ? parsed.byKnowledgeBaseId
        : {},
      byKnowledgeBaseName: parsed.byKnowledgeBaseName && typeof parsed.byKnowledgeBaseName === 'object'
        ? parsed.byKnowledgeBaseName
        : {},
    };
  } catch {
    return emptyState();
  }
}

export function findCachedAskSession({ knowledgeBaseId = '', knowledgeBaseName = '' } = {}) {
  const state = readAskSessionState();
  const id = String(knowledgeBaseId || '').trim();
  const nameKey = normalizeKey(knowledgeBaseName);
  const candidates = [
    id ? state.byKnowledgeBaseId[id] : null,
    nameKey ? state.byKnowledgeBaseName[nameKey] : null,
    state.current,
  ].filter(Boolean);

  return candidates.find((item) => item && item.sessionId) || null;
}

export function saveAskSession({
  sessionId,
  knowledgeBaseId = '',
  knowledgeBaseName = '',
  transport = 'webcontents',
  sessionMode = 'new',
} = {}) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) return null;

  const now = new Date().toISOString();
  const entry = {
    sessionId: cleanSessionId,
    knowledgeBaseId: String(knowledgeBaseId || '').trim(),
    knowledgeBaseName: String(knowledgeBaseName || '').trim(),
    transport,
    sessionMode,
    updatedAt: now,
  };
  const state = readAskSessionState();
  const next = {
    ...state,
    version: STATE_VERSION,
    updatedAt: now,
    current: entry,
    byKnowledgeBaseId: { ...state.byKnowledgeBaseId },
    byKnowledgeBaseName: { ...state.byKnowledgeBaseName },
  };

  if (entry.knowledgeBaseId) next.byKnowledgeBaseId[entry.knowledgeBaseId] = entry;
  const nameKey = normalizeKey(entry.knowledgeBaseName);
  if (nameKey) next.byKnowledgeBaseName[nameKey] = entry;

  const file = getAskSessionStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return entry;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: '',
    current: null,
    byKnowledgeBaseId: {},
    byKnowledgeBaseName: {},
  };
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
