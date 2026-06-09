import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __test__ } from '../lib/ax.js';

test('parseKnowledgeListTexts maps ima UI text sequence into document rows', () => {
  const rows = __test__.parseKnowledgeListTexts([
    '内容(561)',
    '示例资料目录',
    '示例子目录',
    '30 项 5/26更新',
    '示例资料A.pdf',
    'PDF 5/26',
    '示例资料B.pptx',
    'PPT 4/2',
    '没有更多内容了',
  ], { path: '示例资料目录' });

  assert.deepEqual(rows, [
    {
      name: '示例子目录',
      kind: 'folder',
      mediaType: 'folder',
      mediaId: '',
      folderId: '',
      updateTime: '',
      createTime: '',
      timeWording: '5/26更新',
      fileSize: '',
      path: '示例资料目录/示例子目录',
    },
    {
      name: '示例资料A.pdf',
      kind: 'file',
      mediaType: 'PDF',
      mediaId: '',
      folderId: '',
      updateTime: '',
      createTime: '',
      timeWording: '5/26',
      fileSize: '',
      path: '示例资料目录/示例资料A.pdf',
    },
    {
      name: '示例资料B.pptx',
      kind: 'file',
      mediaType: 'PPT',
      mediaId: '',
      folderId: '',
      updateTime: '',
      createTime: '',
      timeWording: '4/2',
      fileSize: '',
      path: '示例资料目录/示例资料B.pptx',
    },
  ]);
});
