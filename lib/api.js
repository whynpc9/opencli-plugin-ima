import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROFILE_DIR = path.join(os.homedir(), 'Library/Application Support/com.tencent.imamac/Default');
const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library/Application Support/com.tencent.imamac');
const MMKV_DIR = path.join(APP_SUPPORT_DIR, 'mmkv');
const COOKIE_DB = path.join(PROFILE_DIR, 'Extension Cookies');
const PREFERENCES = path.join(PROFILE_DIR, 'Preferences');
const KNOWLEDGE_EXTENSION_ID = 'nkohmbngmopdajidckglcoehlaeepeoi';
const COOKIE_HOST = 'khmgfdkajnigikondkcjbaflpjflfiee';
const DEFAULT_API_BASE = 'https://ima.qq.com/cgi-bin';
const DEFAULT_ENDPOINT = `${DEFAULT_API_BASE}/assistant_nl/knowledge_base_qa`;
const KNOWLEDGE_READER_PREFIX = 'knowledge_tab_reader';
const DEFAULT_MODEL_TYPE = 3;
const DEFAULT_MODEL_ID = 'official_3';
const KEYCHAIN_TIMEOUT_MS = 3000;
const SQLITE_TIMEOUT_MS = 5000;
const DEFAULT_KB_LIST_LIMIT = 50;
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
  modelType = DEFAULT_MODEL_TYPE,
  modelId = DEFAULT_MODEL_ID,
  channelId = '',
} = {}) {
  const knowledgeBase = await resolveKnowledgeBase({ kb, kbId });
  const knowledgeBaseId = knowledgeBase.id;
  const headers = getImaHeaders();
  const endpoint = getQaEndpoint();
  const body = toSnakeCase({
    knowledgeBaseId,
    question,
    modelInfo: {
      modelType: Number(process.env.IMA_MODEL_TYPE || modelType || DEFAULT_MODEL_TYPE),
      ...(process.env.IMA_MODEL_ID === ''
        ? {}
        : { modelId: process.env.IMA_MODEL_ID || modelId || DEFAULT_MODEL_ID }),
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

export function inspectApiState() {
  const extensionVersion = getKnowledgeExtensionVersion();
  const preferences = readPreferences();
  const account = parseAccountMeta(preferences);
  const cookieState = inspectCookieDb();
  const deviceInfo = getDeviceInfo();
  const explicitCookie = Boolean(process.env.IMA_COOKIE || process.env.IMA_COOKIE_HEADER);
  const explicitKey = Boolean(process.env.IMA_SAFE_STORAGE_PASSWORD);

  return {
    profileDir: PROFILE_DIR,
    cookieDb: COOKIE_DB,
    cookieDbExists: fs.existsSync(COOKIE_DB),
    cookieHost: COOKIE_HOST,
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
    ready: explicitCookie || (fs.existsSync(COOKIE_DB) && cookieState.names.includes('IMA-TOKEN')),
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

async function postImaJson(endpointPath, payload, { timeout = 16 } = {}) {
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

function extractKnowledgeBaseItems(data) {
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

function extractKnowledgeBaseGroups(data) {
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

function normalizeKnowledgeBase(item) {
  const source = item?.knowledge_base || item?.knowledgeBase || item || {};
  const basic = source.basic_info || source.basicInfo || {};
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
    type: source.new_type ?? source.newType ?? source.type ?? '',
    creator: creator.nickname || creator.name || '',
  };
}

function uniqueKnowledgeBases(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function normalizeName(value) {
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
    'CLIENT-TYPE': cookies['CLIENT-TYPE'] || 'mac',
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
      hostKey: row.host_key || COOKIE_HOST,
      password: safeStoragePassword,
      metaVersion,
    });
  }

  return cookies;
}

function readCookieRows() {
  const rows = runSqliteJson(
    COOKIE_DB,
    `select host_key,name,value,hex(encrypted_value) as encrypted_value from cookies where host_key='${sqlQuote(COOKIE_HOST)}';`,
  );
  const meta = runSqliteJson(COOKIE_DB, "select value from meta where key='version';");
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

  const attempts = [
    ['ima.copilot Safe Storage', 'ima.copilot'],
    ['ima.copilot Safe Storage', ''],
    ['Chrome Safe Storage', 'Chrome'],
  ];

  const timeout = Number(process.env.IMA_KEYCHAIN_TIMEOUT_MS || KEYCHAIN_TIMEOUT_MS);
  for (const [service, account] of attempts) {
    try {
      const args = ['find-generic-password', '-s', service, '-w'];
      if (account) args.splice(3, 0, '-a', account);
      const value = execFileSync('security', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }).trim();
      if (value) return value;
    } catch {
      // Try the next known Chromium safe-storage service.
    }
  }

  throw new Error(
    `Could not read ima.copilot Safe Storage from macOS Keychain within ${timeout}ms per attempt. Unlock/allow the Keychain prompt, or set IMA_SAFE_STORAGE_PASSWORD for local development.`,
  );
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
      consumeQaEvent(event, answerParts, references);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parseSseMessage(buffer);
    if (event) {
      events.push(event);
      consumeQaEvent(event, answerParts, references);
    }
  }

  return {
    answer: answerParts.join('').trim(),
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

function consumeQaEvent(event, answerParts, references) {
  if (event.event === 'MESSAGE') {
    const text = event.data?.Text ?? event.data?.text ?? event.dataRaw;
    if (typeof text === 'string') answerParts.push(text);
    return;
  }

  if (['CONTEXT_REFERENCES', 'PARAGRAPH_REFERENCES', 'IMAGE_REFERENCES'].includes(event.event)) {
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

function parseMaybeJson(value) {
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

function toSnakeCase(value, preserveNestedValue = false) {
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
  try {
    return JSON.parse(fs.readFileSync(PREFERENCES, 'utf8'));
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
  if (!fs.existsSync(MMKV_DIR)) return info;

  for (const file of safeListFiles(MMKV_DIR)) {
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
  const root = path.join(PROFILE_DIR, 'Extensions', KNOWLEDGE_EXTENSION_ID);
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

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, 500);
}

export const __test__ = {
  toSnakeCase,
  hashBkn,
  parseSseMessage,
  consumeQaEvent,
  looksLikeKnowledgeBaseId,
  extractKnowledgeBaseItems,
  normalizeKnowledgeBase,
  extractKnowledgeBaseGroups,
  getDeviceInfo,
};
