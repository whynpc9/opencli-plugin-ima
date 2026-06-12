import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { askImaApi, listKnowledgeBases, listKnowledgeDocuments, normalizeKnowledgeBase, __test__ as apiTest } from '../lib/api.js';

const REQUIRED_COOKIE = [
  'IMA-UID=user-1',
  'IMA-TOKEN=token-1',
  'IMA-REFRESH-TOKEN=refresh-1',
  'UID-TYPE=1',
  'TOKEN-TYPE=1',
  'WEB-VERSION=4.28.6',
].join('; ');

let originalFetch;
let originalEnv;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnv = { ...process.env };
  process.env.IMA_COOKIE = REQUIRED_COOKIE;
  process.env.IMA_API_BASE = 'https://ima.qq.com/cgi-bin';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
});

test('listKnowledgeBases searches with frontend-compatible support types', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return jsonResponse({
      code: 0,
      searched_knowledge_bases: [
        { knowledge_base_id: 'kb-search-1', basic_info: { name: '我的知识库' }, new_type: 1001 },
      ],
      is_end: true,
    });
  };

  const rows = await listKnowledgeBases({ query: '我的知识库', limit: 10, maxPages: 1 });

  assert.deepEqual(rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    creator: row.creator,
  })), [
    { id: 'kb-search-1', name: '我的知识库', type: 1001, creator: '' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/search_knowledge_base');
  assert.deepEqual(calls[0].body, {
    query: '我的知识库',
    cursor: '',
    limit: 10,
    policy: 1,
    support_types: [1001, 1002, 1004, 1005],
  });
  assert.equal(calls[0].headers.from_browser_ima, '1');
  assert.match(calls[0].headers['x-ima-cookie'], /IMA-TOKEN=token-1/);
  assert.match(calls[0].headers['x-ima-bkn'], /^\d+$/);
});

test('listKnowledgeBases lists grouped knowledge bases and paginates unfinished groups', async () => {
  const calls = [];
  const responses = [
    {
      code: 0,
      list: [
        {
          type: 1001,
          next_cursor: 'cursor-2',
          is_end: false,
          list: [{ id: 'kb-mine-1', basic_info: { name: 'Mine One' }, new_type: 1001 }],
        },
        {
          type: 1002,
          next_cursor: '',
          is_end: true,
          list: [{ knowledge_base_id: 'kb-shared-1', name: 'Shared One', new_type: 1002 }],
        },
      ],
    },
    {
      code: 0,
      list: [
        {
          type: 1001,
          next_cursor: '',
          is_end: true,
          list: [{ knowledgeBaseId: 'kb-mine-2', basicInfo: { name: 'Mine Two' }, newType: 1001 }],
        },
      ],
    },
  ];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return jsonResponse(responses.shift());
  };

  const rows = await listKnowledgeBases({ limit: 20, maxPages: 3 });

  assert.deepEqual(rows.map((row) => [row.id, row.name, row.type]), [
    ['kb-mine-1', 'Mine One', 1001],
    ['kb-shared-1', 'Shared One', 1002],
    ['kb-mine-2', 'Mine Two', 1001],
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, {
    params: [
      { type: 1001, cursor: '', limit: 20 },
      { type: 1002, cursor: '', limit: 20 },
      { type: 1004, cursor: '', limit: 20 },
      { type: 1005, cursor: '', limit: 20 },
    ],
  });
  assert.deepEqual(calls[1].body, {
    params: [{ type: 1001, cursor: 'cursor-2', limit: 20 }],
  });
});

test('normalizeKnowledgeBase extracts optional detail metadata', () => {
  const row = normalizeKnowledgeBase({
    knowledge_base_id: 'kb-info-1',
    name: 'Knowledge One',
    desc: 'Shared internal notes',
    new_type: 1001,
    type_name: 'Mine',
    role: 'owner',
    visibility: 'private',
    basic_info: {
      creator: { nickname: 'Owner', user_id: 'user-1' },
      create_time: 1710000000,
      update_time: 1710003600,
    },
    stat_info: {
      media_count: 12,
      folder_count: 3,
      member_count: 2,
    },
  });

  assert.deepEqual(row, {
    id: 'kb-info-1',
    name: 'Knowledge One',
    description: 'Shared internal notes',
    type: 1001,
    typeName: 'Mine',
    creator: 'Owner',
    ownerId: 'user-1',
    role: 'owner',
    visibility: 'private',
    documentCount: 12,
    folderCount: 3,
    memberCount: 2,
    createTime: 1710000000,
    updateTime: 1710003600,
  });
});

test('listKnowledgeDocuments sends frontend-compatible folder listing payload', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return jsonResponse({
      code: 0,
      knowledge_list: [
        {
          media_id: 'pdf_media_1',
          title: '示例文档.pdf',
          media_type: 3,
          update_time: 1710000000,
          file_size: 12345,
        },
      ],
      next_cursor: '',
      is_end: true,
    });
  };

  const result = await listKnowledgeDocuments({ kbId: 'kb-doc-1', limit: 10, maxPages: 1 });

  assert.equal(result.knowledgeBaseId, 'kb-doc-1');
  assert.equal(result.folderId, 'kb-doc-1');
  assert.deepEqual(result.items.map((item) => ({
    name: item.name,
    mediaId: item.mediaId,
    mediaType: item.mediaType,
    updateTime: item.updateTime,
    fileSize: item.fileSize,
  })), [
    {
      name: '示例文档.pdf',
      mediaId: 'pdf_media_1',
      mediaType: 3,
      updateTime: 1710000000,
      fileSize: 12345,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/knowledge_tab_reader/get_knowledge_list');
  assert.deepEqual(calls[0].body, {
    sort_type: 9,
    need_default_cover: true,
    knowledge_base_id: 'kb-doc-1',
    folder_id: 'kb-doc-1',
    cursor: '',
    limit: 10,
    version: '',
    filters: [
      {
        filter_type: 1,
        media_state_filter: {
          media_states: [2],
        },
      },
    ],
  });
  assert.match(calls[0].headers['x-ima-cookie'], /IMA-TOKEN=token-1/);
});

test('askImaApi sends one QA request and joins streamed MESSAGE events', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return sseResponse([
      { event: 'MESSAGE', data: { Text: '第一段' } },
      { event: 'MESSAGE', data: { text: '，第二段。' } },
      { event: 'CONTEXT_REFERENCES', data: { list: [{ id: 'ref-1' }, { id: 'ref-2' }] } },
      { event: 'COMPLETED', data: { Code: 0 } },
    ]);
  };

  const result = await askImaApi({
    question: '请总结',
    kbId: 'kb-direct-1',
    timeout: 5,
  });

  assert.equal(result.status, 'success');
  assert.equal(result.knowledgeBaseId, 'kb-direct-1');
  assert.equal(result.modelType, 3);
  assert.equal(result.modelId, 'official_3');
  assert.equal(result.answer, '第一段，第二段。');
  assert.equal(result.referencesFound, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ima.qq.com/cgi-bin/assistant_nl/knowledge_base_qa');
  assert.deepEqual(calls[0].body, {
    knowledge_base_id: 'kb-direct-1',
    question: '请总结',
    model_info: { model_type: 3, model_id: 'official_3' },
    channel_id: '',
  });
  assert.equal(calls[0].headers.accept, 'text/event-stream');
});

test('askImaApi preserves explicit zero model type', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return sseResponse([
      { event: 'MESSAGE', data: { Text: 'answer' } },
      { event: 'COMPLETED', data: { Code: 0 } },
    ]);
  };

  const result = await askImaApi({
    question: '请总结',
    kbId: 'kb-direct-1',
    modelType: 0,
    modelId: '',
    timeout: 5,
  });

  assert.equal(result.modelType, 0);
  assert.equal(result.modelId, '');
  assert.deepEqual(calls[0].body.model_info, { model_type: 0 });
});

test('structured QA blocks can be used as an answer fallback', () => {
  const text = apiTest.extractStructuredBlockText({
    blocks: [
      { type: 'paragraph', content: [{ text: 'hello' }, { text: ' world' }] },
      { markdown: '\nfrom markdown' },
    ],
  });

  assert.equal(text, 'hello world\nfrom markdown');
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(events) {
  const body = events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
