import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { listKnowledgeDocuments } from './lib/api.js';
import { listImaDocumentsUi } from './lib/ax.js';
import { listKnowledgeDocumentsWebContents } from './lib/webcontents.js';

export const lsCommand = cli({
  site: 'ima',
  name: 'ls',
  access: 'read',
  description: 'List documents and folders in an ima.copilot knowledge base',
  example: 'opencli ima ls --kb "我的知识库" --path "资料目录" -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'kb-id', required: false, help: 'ima knowledgeBaseId to list' },
    { name: 'kb', required: false, help: 'Knowledge base name to list' },
    { name: 'path', required: false, help: 'Folder path inside the knowledge base, separated by /' },
    { name: 'transport', default: 'auto', choices: ['auto', 'api', 'webcontents', 'ui'], help: 'Transport: auto, api, webcontents, or ui (default: auto)' },
    { name: 'limit', type: 'int', default: 50, help: 'Maximum rows per page (default: 50)' },
    { name: 'max-pages', type: 'int', default: 3, help: 'Maximum API pages to read (default: 3)' },
  ],
  columns: ['Transport', 'Name', 'Kind', 'MediaType', 'MediaId', 'FolderId', 'UpdatedAt', 'Time', 'FileSize', 'Path'],
  func: async (kwargs) => {
    const limit = Number(kwargs.limit || 50);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError('Limit must be a positive integer.');
    }

    const maxPages = Number(kwargs['max-pages'] || 3);
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new ArgumentError('Max pages must be a positive integer.');
    }

    const kb = String(kwargs.kb || '').trim();
    const kbId = String(kwargs['kb-id'] || '').trim();
    const path = String(kwargs.path || '').trim();
    const transport = String(kwargs.transport || 'auto').trim().toLowerCase();
    if (!['auto', 'api', 'webcontents', 'ui'].includes(transport)) {
      throw new ArgumentError('Transport must be one of: auto, api, webcontents, ui.');
    }

    if (transport === 'webcontents') {
      try {
        const result = await listKnowledgeDocumentsWebContents({
          kb,
          kbId,
          path,
          limit,
          maxPages,
        });
        return formatRows(result.items, { transport: 'webcontents', path: result.path });
      } catch (error) {
        if (error instanceof ArgumentError || error instanceof EmptyResultError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandExecutionError(`ima/ls failed: ${message}`);
      }
    }

    let apiError = null;
    if (transport !== 'ui') {
      try {
        const result = await listKnowledgeDocuments({
          kb,
          kbId,
          path,
          limit,
          maxPages,
        });
        return formatRows(result.items, { transport: 'api', path: result.path });
      } catch (error) {
        if (error instanceof ArgumentError || error instanceof EmptyResultError) throw error;
        apiError = error instanceof Error ? error.message : String(error);
        if (transport === 'api') {
          throw new CommandExecutionError(`ima/ls failed: ${apiError}`);
        }
      }
    }

    if (kbId && !kb) {
      throw new CommandExecutionError(`ima/ls failed: ${apiError ? `${apiError}; ` : ''}UI transport cannot verify a knowledge base by --kb-id. Use --kb <knowledgeBaseName> or switch ima.copilot to the target knowledge base and run --transport ui without --kb-id.`);
    }

    try {
      const result = listImaDocumentsUi({ kb, path, limit });
      if (!result.items.length) {
        throw new Error(`UI transport saw ${result.textCount || 0} accessible text nodes but no document rows. ima.copilot may not be exposing Chromium WebArea list content to macOS Accessibility in the current launch.`);
      }
      return formatRows(result.items, { transport: 'ui', path: result.path });
    } catch (error) {
      if (error instanceof ArgumentError || error instanceof EmptyResultError) throw error;
      const uiError = error instanceof Error ? error.message : String(error);
      const prefix = apiError ? `API transport failed: ${apiError}; ` : '';
      throw new CommandExecutionError(`ima/ls failed: ${prefix}UI transport failed: ${uiError}`);
    }
  },
});

function formatRows(items, { transport, path }) {
  if (!items.length) {
    throw new EmptyResultError('ima/ls', 'No documents matched this knowledge-base path.');
  }

  return items.map((item) => ({
    Transport: transport,
    Name: item.name || '',
    Kind: item.kind || '',
    MediaType: item.mediaType || '',
    MediaId: item.mediaId || '',
    FolderId: item.folderId || '',
    UpdatedAt: formatTimestamp(item.updateTime || item.createTime),
    Time: item.timeWording || '',
    FileSize: item.fileSize || '',
    Path: item.path || joinKnowledgePath(path, item.name),
  }));
}

function joinKnowledgePath(parent, name) {
  const cleanParent = String(parent || '').replace(/^\/+|\/+$/g, '');
  const cleanName = String(name || '').replace(/^\/+|\/+$/g, '');
  if (!cleanParent) return cleanName;
  if (!cleanName) return cleanParent;
  return `${cleanParent}/${cleanName}`;
}

function formatTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '';
  const ms = number < 1000000000000 ? number * 1000 : number;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}
