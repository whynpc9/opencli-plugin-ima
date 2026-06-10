import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { listKnowledgeBases } from './lib/api.js';
import { listKnowledgeBasesWebContents } from './lib/webcontents.js';

export const kbInfoCommand = cli({
  site: 'ima',
  name: 'kb-info',
  access: 'read',
  description: 'List detailed ima.copilot knowledge-base information available to the local account',
  example: 'opencli ima kb-info --transport webcontents -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'query', required: false, help: 'Optional knowledge-base name filter' },
    { name: 'transport', default: 'webcontents', choices: ['api', 'webcontents'], help: 'Transport: api or webcontents (default: webcontents)' },
    { name: 'limit', type: 'int', default: 100, help: 'Maximum rows per API page (default: 100)' },
    { name: 'max-pages', type: 'int', default: 20, help: 'Maximum API pages to read (default: 20)' },
  ],
  columns: [
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
  ],
  func: async (kwargs) => {
    const limit = Number(kwargs.limit || 100);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new ArgumentError('Limit must be a positive integer.');
    }

    const maxPages = Number(kwargs['max-pages'] || 20);
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new ArgumentError('Max pages must be a positive integer.');
    }

    const transport = String(kwargs.transport || 'webcontents').trim().toLowerCase();
    if (!['api', 'webcontents'].includes(transport)) {
      throw new ArgumentError('Transport must be one of: api, webcontents.');
    }

    try {
      const list = transport === 'webcontents' ? listKnowledgeBasesWebContents : listKnowledgeBases;
      const rows = await list({
        query: String(kwargs.query || '').trim(),
        limit,
        maxPages,
      });
      if (!rows.length) {
        throw new EmptyResultError('ima/kb-info', 'No knowledge bases matched. Confirm ima.copilot is logged in.');
      }
      return rows.map(formatKnowledgeBaseInfo);
    } catch (error) {
      if (error instanceof EmptyResultError || error instanceof ArgumentError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError('ima/kb-info failed', message);
    }
  },
});

function formatKnowledgeBaseInfo(item) {
  return {
    Name: item.name || '',
    KnowledgeBaseId: item.id || '',
    Type: item.type || '',
    TypeName: item.typeName || '',
    Creator: item.creator || '',
    OwnerId: item.ownerId || '',
    Role: item.role || '',
    Visibility: item.visibility || '',
    DocumentCount: formatOptionalNumber(item.documentCount),
    FolderCount: formatOptionalNumber(item.folderCount),
    MemberCount: formatOptionalNumber(item.memberCount),
    CreatedAt: formatTimestamp(item.createTime),
    UpdatedAt: formatTimestamp(item.updateTime),
    Description: item.description || '',
  };
}

function formatOptionalNumber(value) {
  return value === '' || value === undefined || value === null ? '' : value;
}

function formatTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return '';
  const ms = number < 1000000000000 ? number * 1000 : number;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

export const __test__ = {
  formatKnowledgeBaseInfo,
  formatTimestamp,
};
