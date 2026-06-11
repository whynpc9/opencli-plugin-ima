import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { listKnowledgeBases } from './lib/api.js';
import { getImaRuntimeConfig } from './lib/platform.js';
import { listKnowledgeBasesWebContents } from './lib/webcontents.js';

export const kbCommand = cli({
  site: 'ima',
  name: 'kb',
  access: 'read',
  description: 'List or search ima.copilot knowledge bases available to the local account',
  example: 'opencli ima kb --query "我的知识库" -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'query', required: false, help: 'Knowledge base name to search' },
    { name: 'transport', default: 'auto', choices: ['auto', 'api', 'webcontents'], help: 'Transport: auto, api, or webcontents (default: auto)' },
    { name: 'limit', type: 'int', default: 20, help: 'Maximum rows to return (default: 20)' },
  ],
  columns: ['Name', 'KnowledgeBaseId', 'Type', 'Creator'],
  func: async (kwargs) => {
    const limit = Number(kwargs.limit || 20);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError('Limit must be a positive integer.');
    }

    try {
      const transport = String(kwargs.transport || 'auto').trim().toLowerCase();
      if (!['auto', 'api', 'webcontents'].includes(transport)) {
        throw new ArgumentError('Transport must be one of: auto, api, webcontents.');
      }
      const args = {
        query: String(kwargs.query || '').trim(),
        limit,
        maxPages: 2,
      };
      const rows = await listWithTransport(transport, args);
      if (!rows.length) {
        throw new EmptyResultError('ima/kb', 'No knowledge bases matched. Confirm ima.copilot is logged in, or use --kb-id if you already know the id.');
      }
      return rows.slice(0, limit).map((item) => ({
        Name: item.name || '',
        KnowledgeBaseId: item.id || '',
        Type: item.type || '',
        Creator: item.creator || '',
      }));
    } catch (error) {
      if (error instanceof EmptyResultError || error instanceof ArgumentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError('ima/kb failed', message);
    }
  },
});

async function listWithTransport(transport, args) {
  if (transport === 'webcontents') return listKnowledgeBasesWebContents(args);
  if (transport === 'api') return listKnowledgeBases(args);

  if (shouldPreferWebContents()) {
    return listKnowledgeBasesWebContents(args);
  }

  try {
    return await listKnowledgeBases(args);
  } catch (error) {
    try {
      return await listKnowledgeBasesWebContents(args);
    } catch (webContentsError) {
      const apiMessage = error instanceof Error ? error.message : String(error);
      const webContentsMessage = webContentsError instanceof Error ? webContentsError.message : String(webContentsError);
      throw new Error(`API transport failed: ${apiMessage}; WebContents transport failed: ${webContentsMessage}`);
    }
  }
}

function shouldPreferWebContents() {
  const runtime = getImaRuntimeConfig();
  const explicitCookie = Boolean(process.env.IMA_COOKIE || process.env.IMA_COOKIE_HEADER);
  return runtime.os === 'windows' && !runtime.capabilities.apiCookieDecryption && !explicitCookie;
}
