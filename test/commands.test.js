import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRegistry } from '@jackwener/opencli/registry';

import { __test__ as askTest } from '../ask.js';
import { __test__ as kbInfoTest } from '../kb-info.js';
import '../ask.js';
import '../kb.js';
import '../kb-info.js';
import '../setup.js';
import '../status.js';
import '../dump.js';
import '../ls.js';
import '../export.js';

test('registers the complete ima command surface', () => {
  const registry = getRegistry();
  const expected = ['ask', 'kb', 'kb-info', 'setup', 'status', 'dump', 'ls', 'export'];

  for (const name of expected) {
    const command = registry.get(`ima/${name}`);
    assert.ok(command, `ima/${name} should be registered`);
    assert.equal(command.site, 'ima');
    assert.equal(command.name, name);
    assert.equal(command.browser, false);
    assert.equal(command.strategy, 'local');
  }
});

test('ls command exposes knowledge-base document listing arguments', () => {
  const ls = getRegistry().get('ima/ls');
  assert.deepEqual(ls.columns, ['Transport', 'Name', 'Kind', 'MediaType', 'MediaId', 'FolderId', 'UpdatedAt', 'Time', 'FileSize', 'Path']);

  const args = new Map(ls.args.map((arg) => [arg.name, arg]));
  assert.equal(args.get('kb-id')?.required, false);
  assert.equal(args.get('path')?.required, false);
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'webcontents', 'ui']);
  assert.equal(args.get('transport')?.default, 'auto');
  assert.equal(args.get('limit')?.default, 50);
  assert.equal(args.get('max-pages')?.default, 3);
});

test('export command exposes title/mediaId download arguments', () => {
  const command = getRegistry().get('ima/export');
  assert.deepEqual(command.columns, ['Status', 'Transport', 'Title', 'MediaId', 'Output', 'Bytes', 'ContentType', 'Source']);

  const args = new Map(command.args.map((arg) => [arg.name, arg]));
  assert.equal(args.get('document')?.positional, true);
  assert.equal(args.get('document')?.required, false);
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'webcontents', 'recent']);
  assert.equal(args.get('transport')?.default, 'auto');
  assert.equal(args.get('output')?.required, false);
});

test('kb command exposes direct and WebContents transports', () => {
  const command = getRegistry().get('ima/kb');
  const args = new Map(command.args.map((arg) => [arg.name, arg]));
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'webcontents']);
  assert.equal(args.get('transport')?.default, 'auto');
});

test('kb-info command exposes detailed knowledge-base listing arguments', () => {
  const command = getRegistry().get('ima/kb-info');
  assert.deepEqual(command.columns, [
    'Name',
    'KnowledgeBaseId',
    'Type',
    'TypeName',
    'Creator',
    'OwnerId',
    'Role',
    'Visibility',
    'DocumentCount',
    'FolderCount',
    'MemberCount',
    'CreatedAt',
    'UpdatedAt',
    'Description',
  ]);

  const args = new Map(command.args.map((arg) => [arg.name, arg]));
  assert.deepEqual(args.get('transport')?.choices, ['api', 'webcontents']);
  assert.equal(args.get('transport')?.default, 'webcontents');
  assert.equal(args.get('limit')?.default, 100);
  assert.equal(args.get('max-pages')?.default, 20);
});

test('kb-info formatter renders counts and timestamps', () => {
  const row = kbInfoTest.formatKnowledgeBaseInfo({
    id: 'kb-info-1',
    name: 'Knowledge One',
    type: 1001,
    typeName: 'Mine',
    creator: 'Owner',
    documentCount: 12,
    folderCount: 3,
    memberCount: 2,
    createTime: 1710000000,
    updateTime: 1710003600000,
  });

  assert.equal(row.KnowledgeBaseId, 'kb-info-1');
  assert.equal(row.DocumentCount, 12);
  assert.equal(row.FolderCount, 3);
  assert.equal(row.MemberCount, 2);
  assert.equal(row.CreatedAt, '2024-03-09T16:00:00.000Z');
  assert.equal(row.UpdatedAt, '2024-03-09T17:00:00.000Z');
});

test('ask command exposes one-shot knowledge-base QA arguments', () => {
  const ask = getRegistry().get('ima/ask');
  assert.deepEqual(ask.columns, [
    'Status',
    'Transport',
    'KnowledgeBase',
    'KnowledgeBaseId',
    'SessionId',
    'SessionMode',
    'Model',
    'Question',
    'Answer',
    'ReferencesFound',
  ]);

  const args = new Map(ask.args.map((arg) => [arg.name, arg]));
  assert.equal(args.get('question')?.positional, true);
  assert.equal(args.get('question')?.required, true);
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'webcontents', 'ui']);
  assert.equal(args.get('transport')?.default, 'auto');
  assert.deepEqual(args.get('session')?.choices, ['new', 'continue']);
  assert.deepEqual(args.get('think')?.choices, ['default', 'fast', 'deep', 'instruct', 'thinking']);
  assert.equal(args.get('timeout')?.default, 120);
});

test('ask formatter includes session and model metadata', () => {
  const row = askTest.formatAskResult({
    status: 'success',
    knowledgeBase: 'Knowledge One',
    knowledgeBaseId: 'kb-1',
    sessionId: 'session-1',
    sessionMode: 'continue',
    modelType: 5,
    modelId: 'model-id-1',
    question: 'Q',
    answer: 'A',
    referencesFound: 2,
  }, { transport: 'webcontents', question: 'Q' });

  assert.equal(row.SessionId, 'session-1');
  assert.equal(row.SessionMode, 'continue');
  assert.equal(row.Model, '5:model-id-1');
});

test('ask model parser resolves aliases and thinking mode', () => {
  assert.deepEqual(askTest.parseModelOptions({ model: 'ds-v3.2' }).request, { modelType: 4 });
  assert.deepEqual(askTest.parseModelOptions({ model: 'ds-v3.2', think: 'deep' }).request, { modelType: 5 });
  assert.deepEqual(askTest.parseModelOptions({ model: 'hy-think', think: 'fast' }).request, { modelType: 0 });
  assert.deepEqual(askTest.parseModelOptions({ 'model-type': 3000, 'model-id': 'custom-model' }).request, {
    modelType: 3000,
    modelId: 'custom-model',
  });
});

test('status and setup expose UI composer readiness', () => {
  const setup = getRegistry().get('ima/setup');
  const status = getRegistry().get('ima/status');

  assert.ok(setup.columns.includes('ComposerReady'));
  assert.ok(setup.columns.includes('WebContents'));
  assert.ok(status.columns.includes('ComposerReady'));
  assert.ok(status.columns.includes('WebContents'));
});

test('ask auto failure message includes API, UI, and WebContents context', () => {
  const message = askTest.buildAutoFailureMessage({
    apiError: 'api failed',
    uiError: 'composer missing',
    webContentsError: 'cdp failed',
  });

  assert.match(message, /API transport failed: api failed/);
  assert.match(message, /UI transport skipped\/failed: composer missing/);
  assert.match(message, /WebContents transport failed: cdp failed/);
});

test('ask auto UI preflight explains missing composer', () => {
  const message = askTest.summarizeUiPreflight({
    running: true,
    trusted: true,
    composerReady: false,
    textCount: 12,
  });

  assert.match(message, /question composer is not visible/);
  assert.match(message, /Accessible text nodes: 12/);
});
