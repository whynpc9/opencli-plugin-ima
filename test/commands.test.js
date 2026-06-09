import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRegistry } from '@jackwener/opencli/registry';

import '../ask.js';
import '../kb.js';
import '../setup.js';
import '../status.js';
import '../dump.js';
import '../ls.js';
import '../export.js';

test('registers the complete ima command surface', () => {
  const registry = getRegistry();
  const expected = ['ask', 'kb', 'setup', 'status', 'dump', 'ls', 'export'];

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
  assert.deepEqual(args.get('transport')?.choices, ['api', 'webcontents']);
  assert.equal(args.get('transport')?.default, 'api');
});

test('ask command exposes one-shot knowledge-base QA arguments', () => {
  const ask = getRegistry().get('ima/ask');
  assert.deepEqual(ask.columns, [
    'Status',
    'Transport',
    'KnowledgeBase',
    'KnowledgeBaseId',
    'Question',
    'Answer',
    'ReferencesFound',
  ]);

  const args = new Map(ask.args.map((arg) => [arg.name, arg]));
  assert.equal(args.get('question')?.positional, true);
  assert.equal(args.get('question')?.required, true);
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'webcontents', 'ui']);
  assert.equal(args.get('transport')?.default, 'auto');
  assert.equal(args.get('timeout')?.default, 120);
});
