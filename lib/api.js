import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getImaClientType,
  getImaCookieDb,
  getImaCookieHost,
  getImaMmkvDir,
  getImaPreferencesPath,
  getImaRuntimeConfig,
  readImaSafeStoragePassword,
} from './platform.js';

const DEFAULT_API_BASE = 'https://ima.qq.com/cgi-bin';
const DEFAULT_ENDPOINT = `${DEFAULT_API_BASE}/assistant_nl/knowledge_base_qa`;
const KNOWLEDGE_READER_PREFIX = 'knowledge_tab_reader';
const DEFAULT_MODEL_TYPE = 3;
const DEFAULT_MODEL_ID = 'official_3';
const KEYCHAIN_TIMEOUT_MS = 3000;
const SQLITE_TIMEOUT_MS = 5000;
const DEFAULT_KB_LIST_LIMIT = 50;
const DEFAULT_DOC_LIST_LIMIT = 50;
const DEFAULT_DOC_LIST_SORT_TYPE = 9;
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

export async function askImaApi({
  question,
  kb = '',
  kbId = '',
  timeout = 120,
  modelType,
  modelId,
  channelId = '',
} = {}) {
  const knowledgeBase = await resolveKnowledgeBase({ kb, kbId });
  const knowledgeBaseId = knowledgeBase.id;
  const headers = getImaHeaders();
  const endpoint = getQaEndpoint();
  const hasExplicitModelType = modelType !== undefined && modelType !== null && String(modelType).trim() !== '';
  const resolvedModelType = Number(process.env.IMA_MODEL_TYPE !== undefined && process.env.IMA_MODEL_TYPE !== ''
    ? process.env.IMA_MODEL_TYPE
    : hasExplicitModelType ? modelType : DEFAULT_MODEL_TYPE);
  const resolvedModelId = process.env.IMA_MODEL_ID === ''
    ? ''
    : String(process.env.IMA_MODEL_ID || (modelId ?? (hasExplicitModelType ? '' : DEFAULT_MODEL_ID)) || '').trim();
  const body = toSnakeCase({
    knowledgeBaseId,
    question,
    modelInfo: {
      modelType: resolvedModelType,
      ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
    },
    channelId: process.env.IMA_CHANNEL_ID || channelId || '',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeout) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ima API returned HTTP ${response.status}: ${compact(text)}`);
    }

    const parsed = await collectQaStream(response);
    if (!parsed.answer) {
      const eventNames = parsed.events.map((event) => event.event).filter(Boolean).join(', ');
      throw new Error(`ima API completed without MESSAGE text. Events: ${eventNames || 'none'}`);
    }

    return {
      status: 'success',
      knowledgeBase: knowledgeBase.name || kb || knowledgeBaseId,
      knowledgeBaseId,
      modelType: resolvedModelType,
      modelId: resolvedModelId,
      question,
      answer: parsed.answer,
      referencesFound: parsed.referencesFound,
      eventCount: parsed.events.length,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`ima API timed out after ${timeout} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listKnowledgeBases({ query = '', limit = DEFAULT_KB_LIST_LIMIT, maxPages = 3 } = {}) {
  const cleanQuery = String(query || '').trim();
  const endpointPath = cleanQuery
    ? `${KNOWLEDGE_READER_PREFIX}/search_knowledge_base`
    : `${KNOWLEDGE_READER_PREFIX}/get_knowledge_base_list`;
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
        ? await postImaJson(endpointPath, payload)
        : await postKnowledgeBaseList(payload);
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
    const fallback = await listKnowledgeBases({ limit, maxPages });
    const normalizedQuery = normalizeName(cleanQuery);
    const matches = fallback.filter((item) => normalizeName(item.name).includes(normalizedQuery));
    if (matches.length || !searchError) return uniqueKnowledgeBases(matches);
    throw searchError;
  }

  return uniqueKnowledgeBases(knowledgeBases);
}

export async function listKnowledgeDocuments({
  kb = '',
  kbId = '',
  path: knowledgePath = '',
  limit = DEFAULT_DOC_LIST_LIMIT,
  maxPages = 3,
} = {}) {
  const knowledgeBase = await resolveKnowledgeBase({ kb, kbId });
  const pathParts = parseKnowledgePath(knowledgePath);
  let folderId = knowledgeBase.id;

  for (const part of pathParts) {
    const page = await fetchKnowledgeDocumentsPage({
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
    const page = await fetchKnowledgeDocumentsPage({
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

export async function getKnowledgeDocumentDownloadUrl({ mediaId, kbId = '' } = {}) {
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
      endpoint: `${KNOWLEDGE_READER_PREFIX}/get_knowledge`,
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
      const data = await postImaJson(attempt.endpoint, attempt.payload);
      const url = findFirstHttpUrl(data);
      if (url) {
        return {
          url,
          mediaId: cleanMediaId,
          title: findFirstStringByKey(data, /(?:title|name|media_title|mediaTitle)$/i),
          source: `api:${attempt.endpoint}`,
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

export function inspectApiState() {
  const runtime = getImaRuntimeConfig();
  const cookieDb = getImaCookieDb();
  const extensionVersion = getKnowledgeExtensionVersion();
  const preferences = readPreferences();
  const account = parseAccountMeta(preferences);
  const cookieState = inspectCookieDb();
  const deviceInfo = getDeviceInfo();
  const explicitCookie = Boolean(process.env.IMA_COOKIE || process.env.IMA_COOKIE_HEADER);
  const explicitKey = Boolean(process.env.IMA_SAFE_STORAGE_PASSWORD);

  return {
    platform: runtime.os,
    platformLabel: runtime.label,
    capabilities: runtime.capabilities,
    profileDir: runtime.paths.profileDir,
    cookieDb,
    cookieDbExists: Boolean(cookieDb && fs.existsSync(cookieDb)),
    cookieHost: runtime.identifiers.cookieHost,
    cookieRows: cookieState.rows,
    tokenCookie: cookieState.names.includes('IMA-TOKEN'),
    uidCookie: cookieState.names.includes('IMA-UID'),
    encryptedCookies: cookieState.encrypted,
    metaVersion: cookieState.metaVersion,
    extensionVersion,
    accountLogin: Boolean(account?.is_login),
    userIdPresent: Boolean(account?.user_id),
    tokenTypePresent: account?.token_type !== undefined,
    deviceGuidPresent: Boolean(deviceInfo.guid),
    deviceQ36Present: Boolean(deviceInfo.q36),
    deviceIuaPresent: Boolean(deviceInfo.qua),
    explicitCookie,
    explicitSafeStoragePassword: explicitKey,
    endpoint: getQaEndpoint(),
    apiBase: getApiBase(),
    knowledgeBaseListEndpoint: `${getApiBase()}/${KNOWLEDGE_READER_PREFIX}/get_knowledge_base_list`,
    ready: explicitCookie || (Boolean(cookieDb) && fs.existsSync(cookieDb) && cookieState.names.includes('IMA-TOKEN')),
  };
}

async function resolveKnowledgeBase({ kb, kbId }) {
  const explicit = String(kbId || process.env.IMA_KB_ID || '').trim();
  if (explicit) return { id: explicit, name: String(kb || '').trim() || explicit };

  const candidate = String(kb || '').trim();
  if (candidate && looksLikeKnowledgeBaseId(candidate)) return { id: candidate, name: candidate };

  if (candidate) {
    return findKnowledgeBaseByName(candidate);
  }

  throw new Error('Knowledge base id is required. Use --kb <knowledgeBaseName>, --kb-id <knowledgeBaseId>, or set IMA_KB_ID.');
}

async function findKnowledgeBaseByName(name) {
  const searched = await listKnowledgeBases({ query: name, maxPages: 2 });
  const fallback = searched.length ? [] : await listKnowledgeBases({ maxPages: 3 });
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
    `Knowledge base "${name}" was not found from ima.copilot account data.${available ? ` Available candidates: ${available}.` : ''} Use --kb-id if you already know the id.`,
  );
}

function looksLikeKnowledgeBaseId(value) {
  return /^[A-Za-z0-9_-]{8,}$/.test(value) && !/[\s\u4e00-\u9fff]/.test(value);
}

function getImaHeaders() {
  const cookies = buildCookieInfo();
  const encoded = encodeCookie(cookies);
  const token = cookies['IMA-TOKEN'];
  return {
    'x-ima-cookie': encoded,
    from_browser_ima: '1',
    extension_version: String(cookies['WEB-VERSION'] || getKnowledgeExtensionVersion()),
    ...(token ? { 'x-ima-bkn': String(hashBkn(token)) } : {}),
  };
}

export async function postImaJson(endpointPath, payload, { timeout = 16 } = {}) {
  const endpoint = `${getApiBase()}/${String(endpointPath).replace(/^\/+/, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeout) * 1000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...getImaHeaders(),
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(toSnakeCase(payload || {})),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = parseMaybeJson(text);
    if (!response.ok) {
      throw new Error(`ima API returned HTTP ${response.status} for ${endpointPath}: ${compact(text)}`);
    }

    const code = Number(data?.code ?? data?.Code ?? 0);
    if (code !== 0) {
      const msg = data?.msg || data?.Msg || `code=${code}`;
      throw new Error(`ima API ${endpointPath} failed: ${msg} (code=${code})`);
    }
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`ima API ${endpointPath} timed out after ${timeout} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postKnowledgeBaseList(payload) {
  try {
    return await postImaJson(`${KNOWLEDGE_READER_PREFIX}/get_knowledge_base_list`, payload);
  } catch (error) {
    const homePagePayload = {
      needFolderNumber: true,
      needFirstKnowledgeBase: false,
      knowledgeBaseListReq: payload,
    };
    try {
      return await postImaJson(`${KNOWLEDGE_READER_PREFIX}/get_home_page_data`, homePagePayload);
    } catch (fallbackError) {
      const primary = error instanceof Error ? error.message : String(error);
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primary}; fallback get_home_page_data failed: ${fallback}`);
    }
  }
}

async function fetchKnowledgeDocumentsPage({ knowledgeBaseId, folderId, cursor = '', limit = DEFAULT_DOC_LIST_LIMIT }) {
  const data = await postImaJson(`${KNOWLEDGE_READER_PREFIX}/get_knowledge_list`, {
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

function parseKnowledgePath(value) {
  return String(value || '')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.');
}

export function extractKnowledgeDocumentItems(data) {
  const roots = [
    data?.knowledge_list,
    data?.knowledgeList,
    data?.knowledge_list_rsp?.knowledge_list,
    data?.knowledgeListRsp?.knowledgeList,
    data?.knowledge_list_info?.list,
    data?.knowledgeListInfo?.list,
    data?.medias,
    data?.media_list,
    data?.mediaList,
    data?.items,
    data?.list,
    data?.data?.knowledge_list,
    data?.data?.knowledgeList,
    data?.data?.knowledge_list_rsp?.knowledge_list,
    data?.data?.knowledgeListRsp?.knowledgeList,
    data?.data?.knowledge_list_info?.list,
    data?.data?.knowledgeListInfo?.list,
    data?.data?.media_list,
    data?.data?.mediaList,
    data?.data?.items,
    data?.data?.list,
  ];
  const direct = roots.find(Array.isArray);
  if (direct) return direct;

  const nested = [];
  collectLikelyKnowledgeDocuments(data, nested);
  return nested;
}

function collectLikelyKnowledgeDocuments(value, output) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectLikelyKnowledgeDocuments(item, output);
    return;
  }

  const normalized = normalizeKnowledgeDocument(value);
  if (normalized.name && (normalized.mediaId || normalized.id || normalized.folderId)) {
    output.push(value);
    return;
  }

  for (const nested of Object.values(value)) {
    collectLikelyKnowledgeDocuments(nested, output);
  }
}

export function normalizeKnowledgeDocument(item, defaultKnowledgeBaseId = '') {
  const source = item?.knowledge || item?.knowledge_info || item?.knowledgeInfo || item?.media || item || {};
  const basic = source.basic_info || source.basicInfo || {};
  const media = source.media_info || source.mediaInfo || {};
  const folder = source.folder_info || source.folderInfo || {};
  const name = firstNonEmptyString(
    source.name,
    source.title,
    source.source_name,
    source.sourceName,
    source.media_title,
    source.mediaTitle,
    basic.name,
    basic.title,
    media.name,
    media.title,
    media.media_title,
    media.mediaTitle,
    folder.name,
    folder.title,
  );
  const mediaId = firstNonEmptyString(
    source.media_id,
    source.mediaId,
    source.id,
    source.knowledge_id,
    source.knowledgeId,
    media.media_id,
    media.mediaId,
    media.id,
    folder.folder_id,
    folder.folderId,
    folder.id,
  );
  const explicitFolderId = firstNonEmptyString(
    source.folder_id,
    source.folderId,
    source.knowledge_folder_id,
    source.knowledgeFolderId,
    source.knowledge_base_folder_id,
    source.knowledgeBaseFolderId,
    folder.folder_id,
    folder.folderId,
    folder.id,
  );
  const mediaType = source.media_type ?? source.mediaType ?? media.media_type ?? media.mediaType ?? folder.media_type ?? folder.mediaType ?? '';
  const updateTimestamp = firstNumber(
    source.update_time,
    source.updateTime,
    source.last_modify_time,
    source.lastModifyTime,
    source.modify_time,
    source.modifyTime,
    media.update_time,
    media.updateTime,
  );
  const createTimestamp = firstNumber(source.create_time, source.createTime, media.create_time, media.createTime);
  const fileSize = firstNumber(source.file_size, source.fileSize, source.size, media.file_size, media.fileSize, media.size);

  return {
    id: mediaId,
    name,
    mediaId,
    folderId: explicitFolderId || mediaId,
    knowledgeBaseId: firstNonEmptyString(
      source.knowledge_base_id,
      source.knowledgeBaseId,
      media.knowledge_base_id,
      media.knowledgeBaseId,
      defaultKnowledgeBaseId,
    ),
    mediaType,
    kind: inferDocumentKind({ source, mediaType, name }),
    fileSize: fileSize || '',
    updateTime: updateTimestamp || '',
    createTime: createTimestamp || '',
    timeWording: firstNonEmptyString(
      source.time_wording,
      source.timeWording,
      source.update_time_wording,
      source.updateTimeWording,
      source.create_time_wording,
      source.createTimeWording,
    ),
    raw: source,
  };
}

function inferDocumentKind({ source, mediaType, name }) {
  const typeText = normalizeName(source.type_name || source.typeName || source.kind || source.file_type || source.fileType || '');
  if (/folder|dir|目录|文件夹/.test(typeText)) return 'folder';
  if (source.folder_info || source.folderInfo) return 'folder';
  if (!path.extname(String(name || '')) && /folder/i.test(String(mediaType || ''))) return 'folder';
  return 'file';
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function firstOptionalNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return '';
}

export function findFirstHttpUrl(value) {
  const seen = new Set();
  const visit = (item) => {
    if (!item || seen.has(item)) return '';
    if (typeof item === 'string') {
      return /^https?:\/\//i.test(item) ? item : '';
    }
    if (Array.isArray(item)) {
      for (const nested of item) {
        const found = visit(nested);
        if (found) return found;
      }
      return '';
    }
    if (typeof item !== 'object') return '';
    seen.add(item);

    const priorityKeys = Object.keys(item)
      .filter((key) => /(?:origin|download|file|preview|url|link)/i.test(key))
      .sort((left, right) => urlKeyRank(left) - urlKeyRank(right));
    for (const key of priorityKeys) {
      const found = visit(item[key]);
      if (found) return found;
    }
    for (const nested of Object.values(item)) {
      const found = visit(nested);
      if (found) return found;
    }
    return '';
  };
  return visit(value);
}

function urlKeyRank(key) {
  const text = String(key || '').toLowerCase();
  if (/origin/.test(text)) return 0;
  if (/download/.test(text)) return 1;
  if (/original|source/.test(text)) return 2;
  if (/file/.test(text)) return 3;
  if (/preview/.test(text)) return 4;
  if (/cover|thumb|image|icon/.test(text)) return 9;
  if (/url|link/.test(text)) return 5;
  return 8;
}

export function findFirstStringByKey(value, pattern) {
  const seen = new Set();
  const visit = (item) => {
    if (!item || typeof item !== 'object' || seen.has(item)) return '';
    seen.add(item);
    for (const [key, nested] of Object.entries(item)) {
      if (pattern.test(key) && typeof nested === 'string' && nested.trim()) {
        return nested.trim();
      }
    }
    for (const nested of Object.values(item)) {
      const found = visit(nested);
      if (found) return found;
    }
    return '';
  };
  return visit(value);
}

function getQaEndpoint() {
  if (process.env.IMA_API_ENDPOINT) return process.env.IMA_API_ENDPOINT;
  if (process.env.IMA_API_BASE && /knowledge_base_qa/.test(process.env.IMA_API_BASE)) {
    return process.env.IMA_API_BASE;
  }
  return `${getApiBase()}/assistant_nl/knowledge_base_qa`;
}

function getApiBase() {
  const raw = process.env.IMA_API_BASE || DEFAULT_API_BASE;
  return String(raw).replace(/\/assistant_nl\/knowledge_base_qa$/, '').replace(/\/+$/, '');
}

export function extractKnowledgeBaseItems(data) {
  const roots = [
    data?.knowledge_base_list,
    data?.knowledgeBaseList,
    data?.knowledge_bases,
    data?.knowledgeBases,
    data?.searched_knowledge_base_list,
    data?.searchedKnowledgeBaseList,
    data?.searched_knowledge_bases,
    data?.searchedKnowledgeBases,
    data?.addable_knowledge_base_list,
    data?.addableKnowledgeBaseList,
    data?.addable_knowledge_bases,
    data?.addableKnowledgeBases,
    data?.results,
    data?.list,
    data?.items,
    data?.data?.knowledge_base_list,
    data?.data?.knowledgeBaseList,
    data?.data?.knowledge_bases,
    data?.data?.knowledgeBases,
    data?.data?.searched_knowledge_bases,
    data?.data?.searchedKnowledgeBases,
    data?.data?.results,
    data?.data?.list,
  ];
  const direct = roots.find(Array.isArray);
  if (direct) {
    const directItems = direct.map(normalizeKnowledgeBase).filter((item) => item.id);
    if (directItems.length) return direct;
  }

  const nested = [];
  collectLikelyKnowledgeBases(data, nested);
  return nested;
}

export function extractKnowledgeBaseGroups(data) {
  const roots = [
    data?.list,
    data?.results,
    data?.knowledge_base_list,
    data?.knowledgeBaseList,
    data?.data?.list,
    data?.data?.results,
    data?.data?.knowledge_base_list,
    data?.data?.knowledgeBaseList,
  ].filter(Array.isArray);

  const groups = [];
  for (const root of roots) {
    for (const item of root) {
      if (!item || typeof item !== 'object') continue;
      const type = Number(item.type ?? item.new_type ?? item.newType ?? 0);
      const list = item.list ?? item.knowledge_base_list ?? item.knowledgeBaseList;
      if (!type || !Array.isArray(list)) continue;
      const nextCursor = String(item.next_cursor ?? item.nextCursor ?? item.cursor ?? '');
      groups.push({
        type,
        nextCursor,
        isEnd: Boolean(item.is_end ?? item.isEnd ?? !nextCursor),
      });
    }
  }
  return groups;
}

function collectLikelyKnowledgeBases(value, output) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectLikelyKnowledgeBases(item, output);
    return;
  }

  const normalized = normalizeKnowledgeBase(value);
  if (normalized.id && normalized.name) {
    output.push(value);
    return;
  }

  for (const nested of Object.values(value)) {
    collectLikelyKnowledgeBases(nested, output);
  }
}

export function normalizeKnowledgeBase(item) {
  const source = item?.knowledge_base || item?.knowledgeBase || item || {};
  const basic = source.basic_info || source.basicInfo || {};
  const stats = source.stat_info || source.statInfo || source.statistics || source.stats || basic.stat_info || basic.statInfo || {};
  const creator = basic.creator || source.creator || {};
  return {
    id: String(
      source.id ??
      source.knowledge_base_id ??
      source.knowledgeBaseId ??
      basic.id ??
      basic.knowledge_base_id ??
      basic.knowledgeBaseId ??
      '',
    ).trim(),
    name: String(source.name ?? source.title ?? basic.name ?? basic.title ?? '').trim(),
    description: firstNonEmptyString(
      source.description,
      source.desc,
      source.introduction,
      source.intro,
      basic.description,
      basic.desc,
      basic.introduction,
      basic.intro,
    ),
    type: source.new_type ?? source.newType ?? source.type ?? '',
    typeName: firstNonEmptyString(source.type_name, source.typeName, source.category, basic.type_name, basic.typeName),
    creator: creator.nickname || creator.name || '',
    ownerId: firstNonEmptyString(creator.user_id, creator.userId, creator.uid, source.owner_id, source.ownerId),
    role: firstNonEmptyString(source.role, source.permission, source.permission_name, source.permissionName, basic.role),
    visibility: firstNonEmptyString(source.visibility, source.share_type, source.shareType, source.scope, basic.visibility),
    documentCount: firstOptionalNumber(
      source.document_count,
      source.documentCount,
      source.media_count,
      source.mediaCount,
      source.knowledge_count,
      source.knowledgeCount,
      stats.document_count,
      stats.documentCount,
      stats.media_count,
      stats.mediaCount,
      stats.knowledge_count,
      stats.knowledgeCount,
    ),
    folderCount: firstOptionalNumber(source.folder_count, source.folderCount, stats.folder_count, stats.folderCount),
    memberCount: firstOptionalNumber(source.member_count, source.memberCount, stats.member_count, stats.memberCount),
    createTime: firstOptionalNumber(source.create_time, source.createTime, source.created_at, source.createdAt, basic.create_time, basic.createTime),
    updateTime: firstOptionalNumber(
      source.update_time,
      source.updateTime,
      source.modify_time,
      source.modifyTime,
      source.last_modify_time,
      source.lastModifyTime,
      basic.update_time,
      basic.updateTime,
    ),
  };
}

export function uniqueKnowledgeBases(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

export function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function formatKnowledgeBaseLabel(item) {
  return `${item.name || '(unnamed)'}:${item.id}`;
}

function buildCookieInfo() {
  const envCookie = process.env.IMA_COOKIE || process.env.IMA_COOKIE_HEADER;
  const cookies = envCookie ? parseCookieHeader(envCookie) : decryptCookieDb();
  const account = parseAccountMeta(readPreferences());
  const extensionVersion = process.env.IMA_EXTENSION_VERSION || getKnowledgeExtensionVersion();
  const deviceInfo = getDeviceInfo();

  const merged = {
    ...cookies,
    PLATFORM: cookies.PLATFORM || 'H5',
    'CLIENT-TYPE': cookies['CLIENT-TYPE'] || getImaClientType(),
    'WEB-VERSION': cookies['WEB-VERSION'] || extensionVersion,
  };

  if (deviceInfo.guid) merged['IMA-GUID'] = deviceInfo.guid;
  if (deviceInfo.q36) merged['IMA-Q36'] = deviceInfo.q36;
  if (deviceInfo.qua) merged['IMA-IUA'] = deviceInfo.qua;

  if (!merged['TOKEN-TYPE'] && account?.token_type !== undefined) {
    merged['TOKEN-TYPE'] = String(account.token_type);
  }

  for (const required of ['IMA-UID', 'IMA-TOKEN', 'IMA-REFRESH-TOKEN', 'UID-TYPE']) {
    if (!merged[required]) {
      throw new Error(`Missing ${required} in ima login cookies. Open ima.copilot and confirm it is logged in.`);
    }
  }

  return merged;
}

function decryptCookieDb() {
  const { rows, metaVersion } = readCookieRows();
  const safeStoragePassword = getSafeStoragePassword();
  const cookies = {};

  for (const row of rows) {
    const name = row.name;
    if (!name) continue;
    if (row.value) {
      cookies[name] = row.value;
      continue;
    }
    if (!row.encrypted_value) continue;
    cookies[name] = decryptChromeCookie({
      encryptedHex: row.encrypted_value,
      hostKey: row.host_key || getImaCookieHost(),
      password: safeStoragePassword,
      metaVersion,
    });
  }

  return cookies;
}

function readCookieRows() {
  const cookieDb = getImaCookieDb();
  const cookieHost = getImaCookieHost();
  if (!cookieDb) return { rows: [], metaVersion: 0 };
  const rows = runSqliteJson(
    cookieDb,
    `select host_key,name,value,hex(encrypted_value) as encrypted_value from cookies where host_key='${sqlQuote(cookieHost)}';`,
  );
  const meta = runSqliteJson(cookieDb, "select value from meta where key='version';");
  return {
    rows,
    metaVersion: Number(meta?.[0]?.value || 0),
  };
}

function inspectCookieDb() {
  try {
    const { rows, metaVersion } = readCookieRows();
    return {
      rows: rows.length,
      names: rows.map((row) => row.name).filter(Boolean),
      encrypted: rows.filter((row) => row.encrypted_value).length,
      metaVersion,
    };
  } catch {
    return { rows: 0, names: [], encrypted: 0, metaVersion: 0 };
  }
}

function runSqliteJson(db, query) {
  const raw = execFileSync('sqlite3', ['-json', db, query], {
    encoding: 'utf8',
    timeout: SQLITE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  return raw ? JSON.parse(raw) : [];
}

function getSafeStoragePassword() {
  if (process.env.IMA_SAFE_STORAGE_PASSWORD) return process.env.IMA_SAFE_STORAGE_PASSWORD;
  const timeout = Number(process.env.IMA_KEYCHAIN_TIMEOUT_MS || KEYCHAIN_TIMEOUT_MS);
  return readImaSafeStoragePassword({ timeoutMs: timeout });
}

function decryptChromeCookie({ encryptedHex, hostKey, password, metaVersion }) {
  let encrypted = Buffer.from(encryptedHex, 'hex');
  const prefix = encrypted.subarray(0, 3).toString('utf8');
  if (prefix === 'v10' || prefix === 'v11') {
    encrypted = encrypted.subarray(3);
  }

  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  if (metaVersion >= 24 && plaintext.length > 32) {
    const hostDigest = crypto.createHash('sha256').update(hostKey).digest();
    if (plaintext.subarray(0, 32).equals(hostDigest)) {
      plaintext = plaintext.subarray(32);
    }
  }

  return plaintext.toString('utf8');
}

async function collectQaStream(response) {
  const events = [];
  const answerParts = [];
  const structuredAnswerParts = [];
  const references = [];
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('ima API response has no readable stream');
  }

  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split(/\r?\n\r?\n/);
    buffer = messages.pop() || '';
    for (const message of messages) {
      const event = parseSseMessage(message);
      if (!event) continue;
      events.push(event);
      consumeQaEvent(event, answerParts, structuredAnswerParts, references);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseMessage(buffer);
    if (event) {
      events.push(event);
      consumeQaEvent(event, answerParts, structuredAnswerParts, references);
    }
  }

  const answer = answerParts.length ? answerParts.join('') : structuredAnswerParts.join('');
  return {
    answer: answer.trim(),
    referencesFound: countReferences(references),
    events,
  };
}

function parseSseMessage(message) {
  const lines = message.split(/\r?\n/);
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

  const dataRaw = dataLines.join('\n');
  if (!event && !dataRaw) return null;

  return {
    event,
    id,
    dataRaw,
    data: parseMaybeJson(dataRaw),
  };
}

function consumeQaEvent(event, answerParts, structuredAnswerParts, references) {
  if (event.event === 'MESSAGE') {
    const text = event.data?.Text ?? event.data?.text ?? event.dataRaw;
    if (typeof text === 'string') answerParts.push(text);
    return;
  }

  if (event.event === 'STRUCTURED_BLOCK') {
    const text = extractStructuredBlockText(event.data);
    if (text) structuredAnswerParts.push(text);
    return;
  }

  if (['CONTEXT_REFERENCES', 'PARAGRAPH_REFERENCES', 'IMAGE_REFERENCES', 'SEARCH_MEDIAS'].includes(event.event)) {
    references.push(event.data);
    return;
  }

  if (event.event === 'COMPLETED') {
    const code = Number(event.data?.Code ?? event.data?.code ?? 0);
    if (code !== 0) {
      const msg = event.data?.Msg || event.data?.msg || `code=${code}`;
      throw new Error(`ima QA failed: ${msg}`);
    }
  }
}

function extractStructuredBlockText(value) {
  const parts = [];
  collectStructuredText(value, parts);
  return parts.join('');
}

function collectStructuredText(value, output) {
  if (!value) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectStructuredText(item, output));
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && /^(?:text|content|markdown|answer|delta)$/i.test(key) && nested.trim()) {
      output.push(nested);
    } else if (nested && typeof nested === 'object') {
      collectStructuredText(nested, output);
    }
  }
}

export function parseMaybeJson(value) {
  if (!value) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function countReferences(values) {
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
}

export function toSnakeCase(value, preserveNestedValue = false) {
  if (!value || typeof value !== 'object' || value instanceof Date || value instanceof RegExp) return value;
  if (Array.isArray(value)) {
    return value.map((item) => (preserveNestedValue && typeof item !== 'object' ? item : toSnakeCase(item)));
  }
  return Object.keys(value).reduce((result, key) => {
    result[snakeCase(key)] = preserveNestedValue ? value[key] : toSnakeCase(value[key]);
    return result;
  }, {});
}

function snakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function encodeCookie(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function parseCookieHeader(header) {
  return String(header)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf('=');
      if (index === -1) return cookies;
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
      return cookies;
    }, {});
}

function hashBkn(token) {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash += (hash << 5) + token.charAt(index).charCodeAt(0);
  }
  return hash & 2147483647;
}

function readPreferences() {
  const preferences = getImaPreferencesPath();
  if (!preferences) return {};
  try {
    return JSON.parse(fs.readFileSync(preferences, 'utf8'));
  } catch {
    return {};
  }
}

function parseAccountMeta(preferences) {
  const raw = preferences?.tencent?.wxlogin?.account_meta;
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function getDeviceInfo() {
  const env = {
    guid: process.env.IMA_GUID || '',
    q36: process.env.IMA_Q36 || '',
    qua: process.env.IMA_IUA || process.env.IMA_QUA || '',
  };
  const cached = readCachedDeviceInfo();
  const guid = env.guid || cached.guid || cached.qimei || '';
  return {
    guid,
    q36: env.q36 || cached.q36 || cached.qimei || guid || '',
    qua: env.qua || cached.qua || '',
  };
}

function readCachedDeviceInfo() {
  const info = {};
  const mmkvDir = getImaMmkvDir();
  if (!mmkvDir || !fs.existsSync(mmkvDir)) return info;

  for (const file of safeListFiles(mmkvDir)) {
    let text = '';
    try {
      text = fs.readFileSync(file).toString('utf8');
    } catch {
      continue;
    }

    for (const key of ['guid', 'qimei', 'q36', 'qua', 'appVersion', 'osVersion', 'model', 'language']) {
      const matches = [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g'))];
      const value = matches.at(-1)?.[1];
      if (value) info[key] = value;
    }
  }

  return info;
}

function safeListFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return fs.statSync(file).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function getKnowledgeExtensionVersion() {
  if (process.env.IMA_EXTENSION_VERSION) return process.env.IMA_EXTENSION_VERSION;
  const root = getImaRuntimeConfig().paths.extensionRoot;
  if (!root) return '4.28.6';
  try {
    const dirs = fs.readdirSync(root).filter((name) => name.endsWith('_0'));
    const versions = dirs
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
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function sqlQuote(value) {
  return String(value).replaceAll("'", "''");
}

export function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, 500);
}

export const __test__ = {
  toSnakeCase,
  hashBkn,
  parseSseMessage,
  consumeQaEvent,
  extractStructuredBlockText,
  looksLikeKnowledgeBaseId,
  extractKnowledgeBaseItems,
  normalizeKnowledgeBase,
  extractKnowledgeBaseGroups,
  getDeviceInfo,
};
