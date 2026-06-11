import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { getKnowledgeDocumentDownloadUrl, listKnowledgeDocuments } from './lib/api.js';
import { downloadDocumentUrl, findRecentDocumentPreviews } from './lib/documents.js';
import {
  getKnowledgeDocumentDownloadUrlWebContents,
  listKnowledgeDocumentsWebContents,
} from './lib/webcontents.js';

export const exportCommand = cli({
  site: 'ima',
  name: 'export',
  access: 'read',
  description: 'Download an ima.copilot knowledge-base document by title or mediaId',
  example: 'opencli ima export "文档.pdf" --kb "我的知识库" --output ~/Downloads -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'document', required: false, positional: true, help: 'Document title or mediaId' },
    { name: 'title', required: false, help: 'Document title to download' },
    { name: 'media-id', required: false, help: 'ima mediaId to download' },
    { name: 'kb-id', required: false, help: 'ima knowledgeBaseId used by API transport' },
    { name: 'kb', required: false, help: 'Knowledge base name used to find the document by title' },
    { name: 'path', required: false, help: 'Folder path used when finding a title through API transport' },
    { name: 'output', required: false, help: 'Output file path or directory. Defaults to ~/Downloads/<document title>' },
    { name: 'transport', default: 'auto', choices: ['auto', 'api', 'webcontents', 'recent'], help: 'Transport: auto, api, webcontents, or recent (default: auto)' },
    { name: 'limit', type: 'int', default: 100, help: 'Maximum rows per API page when finding a title (default: 100)' },
    { name: 'max-pages', type: 'int', default: 3, help: 'Maximum API pages when finding a title (default: 3)' },
  ],
  columns: ['Status', 'Transport', 'Title', 'MediaId', 'Output', 'Bytes', 'ContentType', 'Source'],
  func: async (kwargs) => {
    const document = String(kwargs.document || '').trim();
    const explicitTitle = String(kwargs.title || '').trim();
    const explicitMediaId = String(kwargs['media-id'] || '').trim();
    const targetMediaId = explicitMediaId || (looksLikeMediaId(document) ? document : '');
    const targetTitle = explicitTitle || (targetMediaId === document ? '' : document);
    const transport = String(kwargs.transport || 'auto').trim().toLowerCase();
    if (!['auto', 'api', 'webcontents', 'recent'].includes(transport)) {
      throw new ArgumentError('Transport must be one of: auto, api, webcontents, recent.');
    }
    if (!targetTitle && !targetMediaId) {
      throw new ArgumentError('Document title or mediaId is required.');
    }

    const limit = Number(kwargs.limit || 100);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError('Limit must be a positive integer.');
    }

    const maxPages = Number(kwargs['max-pages'] || 3);
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new ArgumentError('Max pages must be a positive integer.');
    }

    if (transport === 'webcontents') {
      try {
        const resolved = await resolveWebContentsDownloadTarget({
          title: targetTitle,
          mediaId: targetMediaId,
          kb: String(kwargs.kb || '').trim(),
          kbId: String(kwargs['kb-id'] || '').trim(),
          path: String(kwargs.path || '').trim(),
          limit,
          maxPages,
        });
        const downloaded = await downloadDocumentUrl({
          url: resolved.url,
          output: kwargs.output || '',
          title: resolved.title || targetTitle || resolved.mediaId || 'ima-document',
        });
        return [formatResult({
          transport: 'webcontents',
          title: resolved.title || targetTitle,
          mediaId: resolved.mediaId || targetMediaId,
          downloaded,
          source: resolved.source,
        })];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandExecutionError(`ima/export failed: ${message}`);
      }
    }

    let apiError = null;
    let webContentsError = null;
    if (transport !== 'recent') {
      try {
        const resolved = await resolveApiDownloadTarget({
          title: targetTitle,
          mediaId: targetMediaId,
          kb: String(kwargs.kb || '').trim(),
          kbId: String(kwargs['kb-id'] || '').trim(),
          path: String(kwargs.path || '').trim(),
          limit,
          maxPages,
        });
        const downloaded = await downloadDocumentUrl({
          url: resolved.url,
          output: kwargs.output || '',
          title: resolved.title || targetTitle || resolved.mediaId || 'ima-document',
        });
        return [formatResult({
          transport: 'api',
          title: resolved.title || targetTitle,
          mediaId: resolved.mediaId || targetMediaId,
          downloaded,
          source: resolved.source,
        })];
      } catch (error) {
        apiError = error instanceof Error ? error.message : String(error);
        if (transport === 'api') {
          throw new CommandExecutionError(`ima/export failed: ${apiError}`);
        }
      }
    }

    if (transport === 'auto') {
      try {
        const resolved = await resolveWebContentsDownloadTarget({
          title: targetTitle,
          mediaId: targetMediaId,
          kb: String(kwargs.kb || '').trim(),
          kbId: String(kwargs['kb-id'] || '').trim(),
          path: String(kwargs.path || '').trim(),
          limit,
          maxPages,
        });
        const downloaded = await downloadDocumentUrl({
          url: resolved.url,
          output: kwargs.output || '',
          title: resolved.title || targetTitle || resolved.mediaId || 'ima-document',
        });
        return [formatResult({
          transport: 'webcontents',
          title: resolved.title || targetTitle,
          mediaId: resolved.mediaId || targetMediaId,
          downloaded,
          source: resolved.source,
        })];
      } catch (error) {
        webContentsError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const previews = findRecentDocumentPreviews({ title: targetTitle, mediaId: targetMediaId });
      if (!previews.length) {
        const prefix = buildFailurePrefix({ apiError, webContentsError });
        throw new Error(`${prefix}no matching local preview URL was found. Open the document once in ima.copilot, then retry export.`);
      }
      const preview = preferPreview(previews, { title: targetTitle, mediaId: targetMediaId });
      const downloaded = await downloadDocumentUrl({
        url: preview.url,
        output: kwargs.output || '',
        title: preview.title || targetTitle || preview.mediaId || 'ima-document',
      });
      return [formatResult({
        transport: 'recent',
        title: preview.title || targetTitle,
        mediaId: preview.mediaId || targetMediaId,
        downloaded,
        source: preview.source,
      })];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError(`ima/export failed: ${message}`);
    }
  },
});

function buildFailurePrefix({ apiError, webContentsError }) {
  return [
    apiError ? `API transport failed: ${apiError}` : '',
    webContentsError ? `WebContents transport failed: ${webContentsError}` : '',
  ].filter(Boolean).join('; ') + (apiError || webContentsError ? '; ' : '');
}

async function resolveApiDownloadTarget({ title, mediaId, kb, kbId, path, limit, maxPages }) {
  let resolvedMediaId = mediaId;
  let resolvedTitle = title;

  if (!resolvedMediaId) {
    if (!kb && !kbId) {
      throw new Error('API transport needs --media-id, or --kb/--kb-id when downloading by title.');
    }
    const listing = await listKnowledgeDocuments({ kb, kbId, path, limit, maxPages });
    const match = findDocumentByTitle(listing.items, title);
    if (!match) {
      throw new Error(`Document "${title}" was not found in knowledge path "${path || '/'}".`);
    }
    resolvedMediaId = match.mediaId;
    resolvedTitle = match.name || title;
  }

  const resolved = await getKnowledgeDocumentDownloadUrl({ mediaId: resolvedMediaId, kbId });
  return {
    ...resolved,
    mediaId: resolved.mediaId || resolvedMediaId,
    title: resolved.title || resolvedTitle,
  };
}

async function resolveWebContentsDownloadTarget({ title, mediaId, kb, kbId, path, limit, maxPages }) {
  let resolvedMediaId = mediaId;
  let resolvedTitle = title;
  let resolvedKnowledgeBaseId = kbId;

  if (!resolvedMediaId) {
    if (!kb && !kbId) {
      throw new Error('WebContents transport needs --media-id, or --kb/--kb-id when downloading by title.');
    }
    const listing = await listKnowledgeDocumentsWebContents({ kb, kbId, path, limit, maxPages });
    const match = findDocumentByTitle(listing.items, title);
    if (!match) {
      throw new Error(`Document "${title}" was not found in knowledge path "${path || '/'}".`);
    }
    resolvedMediaId = match.mediaId;
    resolvedTitle = match.name || title;
    resolvedKnowledgeBaseId = listing.knowledgeBaseId || resolvedKnowledgeBaseId;
  }

  const resolved = await getKnowledgeDocumentDownloadUrlWebContents({
    mediaId: resolvedMediaId,
    kbId: resolvedKnowledgeBaseId,
  });
  return {
    ...resolved,
    mediaId: resolved.mediaId || resolvedMediaId,
    title: resolved.title || resolvedTitle,
  };
}

function findDocumentByTitle(items, title) {
  const normalized = normalizeTitle(title);
  const exact = items.find((item) => normalizeTitle(item.name) === normalized);
  if (exact) return exact;
  return items.find((item) => normalizeTitle(item.name).includes(normalized));
}

function preferPreview(items, { title, mediaId }) {
  const normalized = normalizeTitle(title);
  return items.find((item) => mediaId && item.mediaId === mediaId) ||
    items.find((item) => normalized && normalizeTitle(item.title) === normalized) ||
    items[0];
}

function formatResult({ transport, title, mediaId, downloaded, source }) {
  return {
    Status: 'success',
    Transport: transport,
    Title: title || '',
    MediaId: mediaId || '',
    Output: downloaded.output,
    Bytes: downloaded.bytes,
    ContentType: downloaded.contentType,
    Source: source || '',
  };
}

function looksLikeMediaId(value) {
  return /^(?:pdf|doc|docx|ppt|pptx|xls|xlsx|txt|md|file|media)_[A-Za-z0-9_-]+/.test(String(value || '')) ||
    /^[A-Za-z0-9_-]{32,}$/.test(String(value || ''));
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}
