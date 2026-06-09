import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __test__ } from '../lib/webcontents.js';

test('selectImaWebContentsTarget prefers knowledge targets over generic pages', () => {
  const targets = [
    { type: 'page', url: 'chrome://home/', webSocketDebuggerUrl: 'ws://home' },
    { type: 'service_worker', url: 'chrome-extension://ignored/background.js', webSocketDebuggerUrl: 'ws://worker' },
    { type: 'other', url: 'chrome-extension://nkohmbngmopdajidckglcoehlaeepeoi/index.html', webSocketDebuggerUrl: 'ws://extension' },
    { type: 'page', url: 'chrome://allknowledge/', webSocketDebuggerUrl: 'ws://allknowledge' },
  ];

  assert.equal(__test__.selectImaWebContentsTarget(targets).webSocketDebuggerUrl, 'ws://allknowledge');
});

test('selectImaWebContentsTarget falls back to extension then home targets', () => {
  const extensionTarget = __test__.selectImaWebContentsTarget([
    { type: 'page', url: 'chrome://home/', webSocketDebuggerUrl: 'ws://home' },
    { type: 'other', url: 'chrome-extension://nkohmbngmopdajidckglcoehlaeepeoi/index.html', webSocketDebuggerUrl: 'ws://extension' },
  ]);
  const homeTarget = __test__.selectImaWebContentsTarget([
    { type: 'page', url: 'chrome://home/', webSocketDebuggerUrl: 'ws://home' },
  ]);

  assert.equal(extensionTarget.webSocketDebuggerUrl, 'ws://extension');
  assert.equal(homeTarget.webSocketDebuggerUrl, 'ws://home');
});

test('WebContents API expression uses ima bridge headers and browser fetch timeout', () => {
  const expression = __test__.buildPostJsonExpression({
    endpoint: 'https://ima.qq.com/cgi-bin/example_endpoint',
    payload: { knowledgeBaseId: 'kb-example-1' },
    extensionVersion: '4.0.0',
    timeoutMs: 1000,
  });

  assert.match(expression, /chrome\.imaFrame\.invokeWithCallback/);
  assert.match(expression, /getAccountInfo/);
  assert.match(expression, /getDeviceInfo/);
  assert.match(expression, /x-ima-cookie/);
  assert.match(expression, /AbortController/);
  assert.match(expression, /signal: controller\.signal/);
});

test('WebContents QA expression reads SSE stream before clearing timeout', () => {
  const expression = __test__.buildAskExpression({
    endpoint: 'https://ima.qq.com/cgi-bin/assistant/qa',
    payload: { sessionId: 'session-example-1', question: 'example question' },
    extensionVersion: '4.0.0',
    timeoutMs: 1000,
  });

  assert.match(expression, /collectQaStream/);
  assert.match(expression, /event\.event === 'MESSAGE'/);
  assert.ok(
    expression.indexOf('const parsed = await collectQaStream(response);') <
      expression.indexOf('clearTimeout(timer);', expression.indexOf('const parsed = await collectQaStream(response);')),
  );
});

test('WebContents frontend QA payload follows ima session-based request shape', () => {
  const initPayload = __test__.buildInitSessionPayload({ knowledgeBaseId: 'kb-example-1' });
  const qaPayload = __test__.buildFrontendQaPayload({
    sessionId: 'session-example-1',
    question: 'example question',
    modelType: 0,
  });

  assert.deepEqual(initPayload, {
    envInfo: { robotType: 5, interactType: 0 },
    relatedUrl: 'kb-example-1',
    sceneType: 1,
    msgsLimit: 10,
    forbidAutoAddToHistoryList: false,
    knowledgeBaseInfoWithFolder: {
      knowledgeBaseId: 'kb-example-1',
      folderIds: [],
    },
  });
  assert.equal(qaPayload.sessionId, 'session-example-1');
  assert.equal(qaPayload.robotType, 5);
  assert.equal(qaPayload.questionType, 2);
  assert.equal(qaPayload.commandInfo.type, 14);
  assert.deepEqual(qaPayload.commandInfo.knowledgeQaInfo.tags, []);
  assert.deepEqual(qaPayload.commandInfo.knowledgeQaInfo.knowledgeIds, []);
  assert.deepEqual(qaPayload.commandInfo.knowledgeQaInfo.mediaIdInfos, []);
  assert.deepEqual(qaPayload.historyInfo, {});
  assert.deepEqual(qaPayload.clientTools, []);
  assert.equal(qaPayload.modelInfo.enableEnhancement, false);
  assert.match(qaPayload.clientId, /^[0-9a-f-]{36}$/);
});

test('extractSessionId supports frontend init_session response variants', () => {
  assert.equal(__test__.extractSessionId({ session_id: 'session-a' }), 'session-a');
  assert.equal(__test__.extractSessionId({ sessionInfo: { id: 'session-b' } }), 'session-b');
  assert.equal(__test__.extractSessionId({ session_info: { id: 'session-c' } }), 'session-c');
});
