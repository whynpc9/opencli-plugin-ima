import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRegistry } from '@jackwener/opencli/registry';

import '../ask.js';
import '../kb.js';
import '../setup.js';
import '../status.js';
import '../dump.js';

test('registers the complete ima command surface', () => {
  const registry = getRegistry();
  const expected = ['ask', 'kb', 'setup', 'status', 'dump'];

  for (const name of expected) {
    const command = registry.get(`ima/${name}`);
    assert.ok(command, `ima/${name} should be registered`);
    assert.equal(command.site, 'ima');
    assert.equal(command.name, name);
    assert.equal(command.browser, false);
    assert.equal(command.strategy, 'local');
  }
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
  assert.deepEqual(args.get('transport')?.choices, ['auto', 'api', 'ui']);
  assert.equal(args.get('transport')?.default, 'auto');
  assert.equal(args.get('timeout')?.default, 120);
});
