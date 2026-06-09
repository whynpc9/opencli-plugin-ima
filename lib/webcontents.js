import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  compact,
  extractKnowledgeBaseGroups,
  extractKnowledgeBaseItems,
  extractKnowledgeDocumentItems,
  findFirstHttpUrl,
  findFirstStringByKey,
  normalizeKnowledgeBase,
  normalizeKnowledgeDocument,
  normalizeName,
  parseMaybeJson,
  toSnakeCase,
  uniqueKnowledgeBases,
} from './api.js';

const BUNDLE_ID = 'com.tencent.imamac';
const APP_PATH = '/Applications/ima.copilot.app';
const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library/Application Support/com.tencent.imamac');
const PROFILE_DIR = path.join(APP_SUPPORT_DIR, 'Default');
const KNOWLEDGE_EXTENSION_ID = 'nkohmbngmopdajidckglcoehlaeepeoi';
const DEFAULT_API_BASE = 'https://ima.qq.com/cgi-bin';
const DEFAULT_CDP_PORT = 9227;
const DEFAULT_CDP_TIMEOUT_MS = 20000;
const DEFAULT_KB_LIST_LIMIT = 50;
const DEFAULT_DOC_LIST_LIMIT = 50;
const DEFAULT_DOC_LIST_SORT_TYPE = 9;
const DEFAULT_MODEL_TYPE = 0;
const DEFAULT_MODEL_ID = '';
const FRONTEND_QA_ROBOT_TYPE_KNOWLEDGE = 5;
const FRONTEND_QA_QUESTION_TYPE_INPUT = 2;
const FRONTEND_QA_COMMAND_KNOWLEDGE_QA = 14;
const FRONTEND_QA_INTERACT_TYPE_UNKNOWN = 0;
const FRONTEND_QA_SCENE_SHARE_KNOWLEDGE_BASE = 1;
const KB_TYPES = {
  Mine: 1001,
  Shared: 1002,
  SubscribedPublish: 1004,
  SubscribedJoin: 1005,
};
const DEFAULT_KB_SUPPORT_TYPES = [
  KB_TYPES.Mine,
  KB_TYPES.Shared,
  KB_TYPES.SubscribedPublish,
  KB_TYPES.SubscribedJoin,
];

export async function listKnowledgeBasesWebContents({ query = '', limit = DEFAULT_KB_LIST_LIMIT, maxPages = 3 } = {}) {
  const cleanQuery = String(query || '').trim();
  const endpointPath = cleanQuery
    ? 'knowledge_tab_reader/search_knowledge_base'
    : 'knowledge_tab_reader/get_knowledge_base_list';
  const knowledgeBases = [];
  let cursor = '';
  let listParams = DEFAULT_KB_SUPPORT_TYPES.map((type) => ({ type, cursor: '', limit }));
  let searchError = null;

  for (let page = 0; page < maxPages; page += 1) {
    const payload = cleanQuery
      ? { query: cleanQuery, cursor, limit, policy: 1, supportTypes: DEFAULT_KB_SUPPORT_TYPES }
      : { params: listParams };
    let data;
    try {
      data = cleanQuery
        ? await postImaJsonInWebContents(endpointPath, payload)
        : await postKnowledgeBaseListWebContents(payload);
    } catch (error) {
      if (!cleanQuery) throw error;
      searchError = error;
      break;
    }
    const items = extractKnowledgeBaseItems(data);
    knowledgeBases.push(...items.map(normalizeKnowledgeBase).filter((item) => item.id));

    if (cleanQuery) {
      const nextCursor = String(data.next_cursor ?? data.nextCursor ?? data.cursor ?? '');
      const isEnd = Boolean(data.is_end ?? data.isEnd ?? !nextCursor);
      if (isEnd || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    } else {
      listParams = extractKnowledgeBaseGroups(data)
        .filter((group) => !group.isEnd && group.nextCursor)
        .map((group) => ({ type: group.type, cursor: group.nextCursor, limit }));
      if (!listParams.length) break;
    }
  }

  if (cleanQuery && !knowledgeBases.length) {
    const fallback = await listKnowledgeBasesWebContents({ limit, maxPages });
    const normalizedQuery = normalizeName(cleanQuery);
    const matches = fallback.filter((item) => normalizeName(item.name).includes(normalizedQuery));
    if (matches.length || !searchError) return uniqueKnowledgeBases(matches);
    throw searchError;
  }

  return uniqueKnowledgeBases(knowledgeBases);
}

export async function askImaWebContents({
  question,
  kb = '',
  kbId = '',
  timeout = 120,
  modelType = DEFAULT_MODEL_TYPE,
  modelId = DEFAULT_MODEL_ID,
  channelId = '',
} = {}) {
  const knowledgeBase = await resolveKnowledgeBaseWebContents({ kb, kbId });
  const knowledgeBaseId = knowledgeBase.id;
  const session = await initKnowledgeQaSessionWebContents({ knowledgeBaseId });
  const endpoint = `${getApiBase()}/assistant/qa`;
  const resolvedModelId = process.env.IMA_MODEL_ID === ''
    ? ''
    : String(process.env.IMA_MODEL_ID || modelId || DEFAULT_MODEL_ID || '').trim();
  const body = toSnakeCase(buildFrontendQaPayload({
    sessionId: session.sessionId,
    question,
    modelType: Number(process.env.IMA_MODEL_TYPE || modelType || DEFAULT_MODEL_TYPE),
    modelId: resolvedModelId,
    channelId: process.env.IMA_CHANNEL_ID || channelId || '',
  }));

  const result = await evaluateImaWebContents(buildAskExpression({
    endpoint,
    payload: body,
    extensionVersion: getKnowledgeExtensionVersion(),
    timeoutMs: Math.max(1, Number(timeout || 120)) * 1000,
  }), { timeoutMs: Math.max(Number(timeout || 120) * 1000 + 5000, DEFAULT_CDP_TIMEOUT_MS) });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.answer) {
    throw new Error(`ima WebContents QA completed without MESSAGE text. Events: ${result?.eventNames || 'none'}`);
  }

  return {
    status: 'success',
    knowledgeBase: knowledgeBase.name || kb || knowledgeBaseId,
    knowledgeBaseId,
    sessionId: session.sessionId,
    question,
    answer: result.answer,
    referencesFound: result.referencesFound,
    eventCount: result.eventCount,
  };
}

async function initKnowledgeQaSessionWebContents({ knowledgeBaseId }) {
  const data = await postImaJsonInWebContents('session_logic/init_session', buildInitSessionPayload({ knowledgeBaseId }), { timeout: 20 });
  const sessionId = extractSessionId(data);
  if (!sessionId) {
    throw new Error('ima WebContents init_session did not return a session id.');
  }
  return { sessionId, raw: data };
}

function buildInitSessionPayload({ knowledgeBaseId }) {
  return {
    envInfo: {
      robotType: FRONTEND_QA_ROBOT_TYPE_KNOWLEDGE,
      interactType: FRONTEND_QA_INTERACT_TYPE_UNKNOWN,
    },
    relatedUrl: knowledgeBaseId,
    sceneType: FRONTEND_QA_SCENE_SHARE_KNOWLEDGE_BASE,
    msgsLimit: 10,
    forbidAutoAddToHistoryList: false,
    knowledgeBaseInfoWithFolder: {
      knowledgeBaseId,
      folderIds: [],
    },
  };
}

function buildFrontendQaPayload({ sessionId, question, modelType, modelId = '', channelId = '' }) {
  return {
    sessionId,
    robotType: FRONTEND_QA_ROBOT_TYPE_KNOWLEDGE,
    question,
    questionType: FRONTEND_QA_QUESTION_TYPE_INPUT,
    clientId: crypto.randomUUID(),
    commandInfo: {
      type: FRONTEND_QA_COMMAND_KNOWLEDGE_QA,
      knowledgeQaInfo: {
        tags: [],
        knowledgeIds: [],
        mediaIdInfos: [],
      },
    },
    modelInfo: {
      modelType,
      ...(modelId ? { modelId } : {}),
      enableEnhancement: false,
    },
    historyInfo: {},
    ...(channelId ? { channelId } : {}),
    clientTools: [],
  };
}

function extractSessionId(data) {
  return String(
    data?.session_id ??
    data?.sessionId ??
    data?.session_info?.id ??
    data?.sessionInfo?.id ??
    data?.session?.id ??
    '',
  ).trim();
}

export async function listKnowledgeDocumentsWebContents({
  kb = '',
  kbId = '',
  path: knowledgePath = '',
  limit = DEFAULT_DOC_LIST_LIMIT,
  maxPages = 3,
} = {}) {
  const knowledgeBase = await resolveKnowledgeBaseWebContents({ kb, kbId });
  const pathParts = parseKnowledgePath(knowledgePath);
  let folderId = knowledgeBase.id;

  for (const part of pathParts) {
    const page = await fetchKnowledgeDocumentsPageWebContents({
      knowledgeBaseId: knowledgeBase.id,
      folderId,
      cursor: '',
      limit: Math.max(limit, DEFAULT_DOC_LIST_LIMIT),
    });
    const folder = page.items.find((item) => normalizeName(item.name) === normalizeName(part));
    if (!folder) {
      throw new Error(`Knowledge path "${pathParts.join('/')}" was not found at "${part}".`);
    }
    folderId = folder.folderId || folder.mediaId || folder.id;
    if (!folderId) {
      throw new Error(`Knowledge path item "${part}" did not include a folder/media id.`);
    }
  }

  const items = [];
  let cursor = '';
  let isEnd = false;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await fetchKnowledgeDocumentsPageWebContents({
      knowledgeBaseId: knowledgeBase.id,
      folderId,
      cursor,
      limit,
    });
    items.push(...page.items);
    isEnd = page.isEnd;
    if (page.isEnd || !page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  return {
    knowledgeBase,
    knowledgeBaseId: knowledgeBase.id,
    folderId,
    path: pathParts.join('/'),
    items,
    isEnd,
    nextCursor: cursor,
  };
}

export async function getKnowledgeDocumentDownloadUrlWebContents({ mediaId, kbId = '' } = {}) {
  const cleanMediaId = String(mediaId || '').trim();
  if (!cleanMediaId) {
    throw new Error('mediaId is required to resolve a document download URL.');
  }

  const errors = [];
  const attempts = [
    {
      endpoint: 'file_manager/get_media',
      payload: {
        mediaId: cleanMediaId,
        sourceKnowledgeBaseId: kbId,
        knowledgeBaseId: kbId,
        shareId: '',
      },
    },
    {
      endpoint: 'knowledge_tab_reader/get_knowledge',
      payload: {
        mediaId: cleanMediaId,
        knowledgeBaseId: kbId,
      },
    },
    {
      endpoint: 'intelligent_assistant_http/get_medias_info',
      payload: {
        mediaIds: [cleanMediaId],
        sourceKnowledgeBaseId: kbId,
        knowledgeBaseId: kbId,
        shareId: '',
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const data = await postImaJsonInWebContents(attempt.endpoint, attempt.payload);
      const url = findFirstHttpUrl(data);
      if (url) {
        return {
          url,
          mediaId: cleanMediaId,
          title: findFirstStringByKey(data, /(?:title|name|media_title|mediaTitle)$/i),
          source: `webcontents:${attempt.endpoint}`,
          raw: data,
        };
      }
      errors.push(`${attempt.endpoint}: no http URL in response`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`Could not resolve download URL for mediaId "${cleanMediaId}". ${errors.join('; ')}`);
}

export async function postImaJsonInWebContents(endpointPath, payload, { timeout = 16 } = {}) {
  const endpoint = `${getApiBase()}/${String(endpointPath).replace(/^\/+/, '')}`;
  const timeoutMs = Math.max(Number(timeout) * 1000, DEFAULT_CDP_TIMEOUT_MS);
  const result = await evaluateImaWebContents(buildPostJsonExpression({
    endpoint,
    payload: toSnakeCase(payload || {}),
    extensionVersion: getKnowledgeExtensionVersion(),
    timeoutMs,
  }), { timeoutMs });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.httpOk) {
    throw new Error(`ima WebContents API returned HTTP ${result?.httpStatus || 'unknown'} for ${endpointPath}: ${compact(result?.bodyText || '')}`);
  }

  const data = result.bodyJson ?? parseMaybeJson(result.bodyText);
  const code = Number(data?.code ?? data?.Code ?? 0);
  if (code !== 0) {
    const msg = data?.msg || data?.Msg || `code=${code}`;
    throw new Error(`ima WebContents API ${endpointPath} failed: ${msg} (code=${code})`);
  }
  return data && typeof data === 'object' ? data : {};
}

async function postKnowledgeBaseListWebContents(payload) {
  try {
    return await postImaJsonInWebContents('knowledge_tab_reader/get_knowledge_base_list', payload);
  } catch (error) {
    const homePagePayload = {
      needFolderNumber: true,
      needFirstKnowledgeBase: false,
      knowledgeBaseListReq: payload,
    };
    try {
      return await postImaJsonInWebContents('knowledge_tab_reader/get_home_page_data', homePagePayload);
    } catch (fallbackError) {
      const primary = error instanceof Error ? error.message : String(error);
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primary}; fallback get_home_page_data failed: ${fallback}`);
    }
  }
}

async function fetchKnowledgeDocumentsPageWebContents({ knowledgeBaseId, folderId, cursor = '', limit = DEFAULT_DOC_LIST_LIMIT }) {
  const data = await postImaJsonInWebContents('knowledge_tab_reader/get_knowledge_list', {
    sortType: DEFAULT_DOC_LIST_SORT_TYPE,
    needDefaultCover: true,
    knowledgeBaseId,
    folderId: folderId || knowledgeBaseId,
    cursor,
    limit,
    version: '',
    filters: [
      {
        filterType: 1,
        mediaStateFilter: {
          mediaStates: [2],
        },
      },
    ],
  });

  const items = extractKnowledgeDocumentItems(data).map((item) => normalizeKnowledgeDocument(item, knowledgeBaseId));
  const nextCursor = String(
    data.next_cursor ??
    data.nextCursor ??
    data.cursor ??
    data.data?.next_cursor ??
    data.data?.nextCursor ??
    '',
  );
  const isEnd = Boolean(
    data.is_end ??
    data.isEnd ??
    data.data?.is_end ??
    data.data?.isEnd ??
    (!nextCursor || items.length < limit),
  );

  return { items, nextCursor, isEnd, raw: data };
}

async function resolveKnowledgeBaseWebContents({ kb, kbId }) {
  const explicit = String(kbId || process.env.IMA_KB_ID || '').trim();
  if (explicit) return { id: explicit, name: String(kb || '').trim() || explicit };

  const candidate = String(kb || '').trim();
  if (candidate && looksLikeKnowledgeBaseId(candidate)) return { id: candidate, name: candidate };

  if (candidate) {
    return findKnowledgeBaseByNameWebContents(candidate);
  }

  throw new Error('Knowledge base id is required. Use --kb <knowledgeBaseName>, --kb-id <knowledgeBaseId>, or set IMA_KB_ID.');
}

async function findKnowledgeBaseByNameWebContents(name) {
  const searched = await listKnowledgeBasesWebContents({ query: name, maxPages: 2 });
  const fallback = searched.length ? [] : await listKnowledgeBasesWebContents({ maxPages: 3 });
  const candidates = uniqueKnowledgeBases([...searched, ...fallback]);
  const normalizedName = normalizeName(name);

  const exactMatches = candidates.filter((item) => normalizeName(item.name) === normalizedName);
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) {
    throw new Error(`Knowledge base name "${name}" matched multiple ids: ${exactMatches.map(formatKnowledgeBaseLabel).join(', ')}. Use --kb-id.`);
  }

  const containsMatches = candidates.filter((item) => normalizeName(item.name).includes(normalizedName));
  if (containsMatches.length === 1) return containsMatches[0];
  if (containsMatches.length > 1) {
    throw new Error(`Knowledge base name "${name}" matched multiple knowledge bases: ${containsMatches.map(formatKnowledgeBaseLabel).join(', ')}. Use --kb-id.`);
  }

  const available = candidates.slice(0, 8).map(formatKnowledgeBaseLabel).join(', ');
  throw new Error(
    `Knowledge base "${name}" was not found from ima.copilot WebContents.${available ? ` Available candidates: ${available}.` : ''} Use --kb-id if you already know the id.`,
  );
}

function buildPostJsonExpression({ endpoint, payload, extensionVersion, timeoutMs = DEFAULT_CDP_TIMEOUT_MS }) {
  return `
(async () => {
  const endpoint = ${JSON.stringify(endpoint)};
  const payload = ${JSON.stringify(payload)};
  const extensionVersion = ${JSON.stringify(extensionVersion)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  ${BRIDGE_HELPERS}

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = await buildImaHeaders(extensionVersion);
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    clearTimeout(timer);
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch {}
    return JSON.stringify({
      httpOk: response.ok,
      httpStatus: response.status,
      bodyText,
      bodyJson,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error && error.name === 'AbortError') {
      return JSON.stringify({ error: 'ima WebContents API timed out after ' + Math.round(timeoutMs / 1000) + 's' });
    }
    return JSON.stringify({ error: String(error && error.message || error) });
  }
})()
`;
}

function buildAskExpression({ endpoint, payload, extensionVersion, timeoutMs }) {
  return `
(async () => {
  const endpoint = ${JSON.stringify(endpoint)};
  const payload = ${JSON.stringify(payload)};
  const extensionVersion = ${JSON.stringify(extensionVersion)};
  const timeoutMs = ${JSON.stringify(timeoutMs)};
  ${BRIDGE_HELPERS}
  ${SSE_HELPERS}

  try {
    const headers = await buildImaHeaders(extensionVersion);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      clearTimeout(timer);
      return JSON.stringify({ error: 'ima WebContents QA returned HTTP ' + response.status + ': ' + text.slice(0, 240) });
    }
    const parsed = await collectQaStream(response);
    clearTimeout(timer);
    return JSON.stringify(parsed);
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return JSON.stringify({ error: 'ima WebContents QA timed out after ' + Math.round(timeoutMs / 1000) + 's' });
    }
    return JSON.stringify({ error: String(error && error.message || error) });
  }
})()
`;
}

const BRIDGE_HELPERS = `
const hashBkn = (token) => {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash += (hash << 5) + token.charCodeAt(index);
  }
  return hash & 2147483647;
};
const invoke = (action, params = {}, timeout = 10000) => new Promise((resolve) => {
  const bridge = globalThis.chrome && globalThis.chrome.imaFrame;
  if (!bridge || !bridge.invokeWithCallback) {
    resolve({ code: -1, msg: 'chrome.imaFrame.invokeWithCallback is unavailable', data: '' });
    return;
  }
  const timer = setTimeout(() => resolve({ code: 996, msg: 'imaFrame timeout', data: '' }), timeout);
  bridge.invokeWithCallback({ action, params: JSON.stringify(params) }, (result) => {
    clearTimeout(timer);
    resolve(result || {});
  });
});
const parseData = (result) => {
  try {
    return typeof result.data === 'string' ? JSON.parse(result.data || '{}') : (result.data || {});
  } catch {
    return {};
  }
};
const buildImaHeaders = async (extensionVersion) => {
  const accountResult = await invoke('getAccountInfo');
  const deviceResult = await invoke('getDeviceInfo');
  const account = parseData(accountResult);
  const device = parseData(deviceResult);
  if (!account.user_id || !account.token || !account.refresh_token) {
    throw new Error('ima WebContents bridge is not logged in.');
  }
  const cookieInfo = {
    PLATFORM: 'H5',
    'CLIENT-TYPE': 'mac',
    'WEB-VERSION': extensionVersion,
    'IMA-GUID': device.guid || '',
    'IMA-Q36': device.q36 || '',
    'IMA-IUA': device.qua || '',
    'IMA-UID': account.user_id || '',
    'IMA-TOKEN': account.token || '',
    'IMA-REFRESH-TOKEN': account.refresh_token || '',
    'UID-TYPE': account.id_type == null ? '' : String(account.id_type),
    'TOKEN-TYPE': account.token_type == null ? '' : String(account.token_type),
  };
  const cookie = Object.entries(cookieInfo)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => key + '=' + value)
    .join('; ');
  return {
    'x-ima-cookie': cookie,
    from_browser_ima: '1',
    extension_version: extensionVersion,
    'x-ima-bkn': String(hashBkn(account.token || '')),
  };
};
`;

const SSE_HELPERS = `
const parseMaybeJson = (value) => {
  if (!value) return value;
  try { return JSON.parse(value); } catch { return value; }
};
const parseSseMessage = (message) => {
  const lines = message.split(/\\r?\\n/);
  let event = 'message';
  let id = '';
  const dataLines = [];
  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const index = rawLine.indexOf(':');
    const field = index === -1 ? rawLine : rawLine.slice(0, index);
    let value = index === -1 ? '' : rawLine.slice(index + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'id') id = value;
    if (field === 'data') dataLines.push(value);
  }
  const dataRaw = dataLines.join('\\n');
  if (!event && !dataRaw) return null;
  return { event, id, dataRaw, data: parseMaybeJson(dataRaw) };
};
const countReferences = (values) => {
  let count = 0;
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      count += value.length;
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (/references?|list|items/i.test(key) && Array.isArray(nested)) {
        count += nested.length;
      } else {
        visit(nested);
      }
    }
  };
  values.forEach(visit);
  return count;
};
const collectQaStream = async (response) => {
  const events = [];
  const answerParts = [];
  const references = [];
  const decoder = new TextDecoder();
  const reader = response.body && response.body.getReader();
  if (!reader) throw new Error('ima WebContents QA response has no readable stream');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split(/\\r?\\n\\r?\\n/);
    buffer = messages.pop() || '';
    for (const message of messages) {
      const event = parseSseMessage(message);
      if (!event) continue;
      events.push(event);
      if (event.event === 'MESSAGE') {
        const text = event.data && (event.data.Text || event.data.text);
        answerParts.push(typeof text === 'string' ? text : event.dataRaw);
      } else if (['CONTEXT_REFERENCES', 'PARAGRAPH_REFERENCES', 'IMAGE_REFERENCES', 'SEARCH_MEDIAS'].includes(event.event)) {
        references.push(event.data);
      } else if (event.event === 'COMPLETED') {
        const code = Number((event.data && (event.data.Code ?? event.data.code)) ?? 0);
        if (code !== 0) {
          const msg = (event.data && (event.data.Msg || event.data.msg)) || ('code=' + code);
          throw new Error('ima WebContents QA failed: ' + msg);
        }
      } else if (['FRONTEND_FINISH', 'FRONTEND_FINNISH'].includes(event.event)) {
        const code = Number((event.data && (event.data.Code ?? event.data.code)) ?? 0);
        if (code !== 0) {
          const msg = (event.data && (event.data.Msg || event.data.msg)) || ('code=' + code);
          throw new Error('ima WebContents QA failed: ' + msg);
        }
      } else if (['FRONTEND_EXCEPTION', 'FRONTEND_TIMEOUT'].includes(event.event)) {
        const msg = (event.data && (event.data.Msg || event.data.msg || event.data.message)) || event.dataRaw || event.event;
        throw new Error('ima WebContents QA failed: ' + msg);
      }
    }
  }
  if (buffer.trim()) {
    const event = parseSseMessage(buffer);
    if (event) events.push(event);
  }
  return {
    answer: answerParts.join('').trim(),
    referencesFound: countReferences(references),
    eventCount: events.length,
    eventNames: events.map((event) => event.event).filter(Boolean).join(', '),
  };
};
`;

async function evaluateImaWebContents(expression, { timeoutMs = DEFAULT_CDP_TIMEOUT_MS } = {}) {
  const target = await findImaWebContentsTarget();
  const result = await withCdpTarget(target, async (cdp) => cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  }, timeoutMs + 1000));

  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown exception';
    throw new Error(`ima WebContents evaluation failed: ${description}`);
  }
  const value = result.result?.value;
  return typeof value === 'string' ? parseMaybeJson(value) : value;
}

async function findImaWebContentsTarget() {
  const port = getCdpPort();
  await ensureImaCdp(port);
  const deadline = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
  let lastTargets = [];
  while (Date.now() < deadline) {
    const targets = await fetchCdpJson(port, '/json/list').catch(() => []);
    lastTargets = Array.isArray(targets) ? targets : [];
    const selected = selectImaWebContentsTarget(lastTargets);
    if (selected) return selected;
    await sleep(400);
  }
  throw new Error(`Could not find an ima WebContents target. Targets seen: ${lastTargets.map((target) => target.type).join(', ') || 'none'}.`);
}

function selectImaWebContentsTarget(targets) {
  const candidates = targets.filter((target) => target.webSocketDebuggerUrl && ['page', 'other'].includes(target.type));
  return candidates.find((target) => target.url === 'chrome://allknowledge/') ||
    candidates.find((target) => target.url?.startsWith(`chrome-extension://${KNOWLEDGE_EXTENSION_ID}/`)) ||
    candidates.find((target) => target.url === 'chrome://home/') ||
    candidates.find((target) => target.url);
}

async function ensureImaCdp(port) {
  const version = await fetchCdpJson(port, '/json/version').catch(() => null);
  if (version?.webSocketDebuggerUrl) return version;
  if (process.env.IMA_WEBCONTENTS_LAUNCH === '0') {
    throw new Error(`ima WebContents CDP is not reachable on port ${port}. Start ima.copilot with remote debugging or unset IMA_WEBCONTENTS_LAUNCH=0.`);
  }

  await launchImaForWebContents(port);
  const deadline = Date.now() + DEFAULT_CDP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const next = await fetchCdpJson(port, '/json/version').catch(() => null);
    if (next?.webSocketDebuggerUrl) return next;
    await sleep(500);
  }
  throw new Error(`ima WebContents CDP did not become reachable on port ${port}.`);
}

async function launchImaForWebContents(port) {
  quitIma();
  await waitForImaExit();
  const profileLink = createProfileSymlink();
  execFileSync('open', [
    '-n',
    '-a',
    APP_PATH,
    '--args',
    `--user-data-dir=${profileLink}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--enable-features=TencentRemoteDebugSwitch',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function quitIma() {
  try {
    execFileSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch {
    // The app may not be running.
  }
}

async function waitForImaExit() {
  for (let index = 0; index < 30; index += 1) {
    if (!isImaProcessRunning()) return;
    await sleep(300);
  }
}

function isImaProcessRunning() {
  try {
    execFileSync('pgrep', ['-f', `${APP_PATH}/Contents/MacOS/ima.copilot`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function createProfileSymlink() {
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ima-profile-link-'));
  fs.rmdirSync(link);
  fs.symlinkSync(APP_SUPPORT_DIR, link, 'dir');
  return link;
}

async function withCdpTarget(target, callback) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node.js WebSocket global is unavailable. Use Node.js 22+ for ima WebContents transport.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(JSON.stringify(message.error)));
    } else {
      waiter.resolve(message.result);
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  const cdp = (method, params = {}, timeoutMs = DEFAULT_CDP_TIMEOUT_MS) => {
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP method ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  try {
    return await callback(cdp);
  } finally {
    socket.close();
  }
}

async function fetchCdpJson(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  return response.json();
}

function getCdpPort() {
  const port = Number(process.env.IMA_WEBCONTENTS_CDP_PORT || DEFAULT_CDP_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('IMA_WEBCONTENTS_CDP_PORT must be a positive integer.');
  }
  return port;
}

function getApiBase() {
  const raw = process.env.IMA_API_BASE || DEFAULT_API_BASE;
  return String(raw).replace(/\/assistant_nl\/knowledge_base_qa$/, '').replace(/\/+$/, '');
}

function getKnowledgeExtensionVersion() {
  if (process.env.IMA_EXTENSION_VERSION) return process.env.IMA_EXTENSION_VERSION;
  const root = path.join(PROFILE_DIR, 'Extensions', KNOWLEDGE_EXTENSION_ID);
  try {
    const versions = fs.readdirSync(root)
      .filter((name) => name.endsWith('_0'))
      .map((dir) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'manifest.json'), 'utf8'));
        return manifest.version;
      })
      .filter(Boolean)
      .sort(compareVersion);
    return versions.at(-1) || '4.28.6';
  } catch {
    return '4.28.6';
  }
}

function compareVersion(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseKnowledgePath(value) {
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.');
}

function looksLikeKnowledgeBaseId(value) {
  return /^[A-Za-z0-9_-]{8,}$/.test(value) && !/[\s\u4e00-\u9fff]/.test(value);
}

function formatKnowledgeBaseLabel(item) {
  return `${item.name || '(unnamed)'}:${item.id}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const __test__ = {
  buildFrontendQaPayload,
  buildInitSessionPayload,
  buildPostJsonExpression,
  buildAskExpression,
  extractSessionId,
  selectImaWebContentsTarget,
};
