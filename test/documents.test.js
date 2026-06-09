import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractPreviewDocumentsFromText } from '../lib/documents.js';

test('extractPreviewDocumentsFromText parses ima preview originUrl documents', () => {
  const origin = new URL('https://res-skb.example.invalid/file_manager/example.pdf');
  origin.searchParams.set('media_id', 'pdf_example_media_id');
  origin.searchParams.set('media_title', '示例文档.pdf');
  origin.searchParams.set('sign', 'test-sign');
  const preview = `chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html?originUrl=${encodeURIComponent(origin.toString())}&relatedSceneType=0*`;

  const rows = extractPreviewDocumentsFromText(`prefix ${preview} suffix`, '/tmp/session');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, '示例文档.pdf');
  assert.equal(rows[0].mediaId, 'pdf_example_media_id');
  assert.equal(rows[0].url, origin.toString());
  assert.equal(rows[0].source, '/tmp/session');
});
