import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { listKnowledgeBases } from './lib/api.js';
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
    { name: 'transport', default: 'api', choices: ['api', 'webcontents'], help: 'Transport: api or webcontents (default: api)' },
    { name: 'limit', type: 'int', default: 20, help: 'Maximum rows to return (default: 20)' },
  ],
  columns: ['Name', 'KnowledgeBaseId', 'Type', 'Creator'],
  func: async (kwargs) => {
    const limit = Number(kwargs.limit || 20);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError('Limit must be a positive integer.');
    }

    try {
      const transport = String(kwargs.transport || 'api').trim().toLowerCase();
      if (!['api', 'webcontents'].includes(transport)) {
        throw new ArgumentError('Transport must be one of: api, webcontents.');
      }
      const list = transport === 'webcontents' ? listKnowledgeBasesWebContents : listKnowledgeBases;
      const rows = await list({
        query: String(kwargs.query || '').trim(),
        limit,
        maxPages: 2,
      });
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
