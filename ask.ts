import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { askImaApi } from './lib/api.js';
import { askIma } from './lib/ax.js';
import { askImaWebContents } from './lib/webcontents.js';

export const askCommand = cli({
  site: 'ima',
  name: 'ask',
  access: 'write',
  description: 'Ask one question against a selected ima.copilot knowledge base and return the generated answer',
  example: 'opencli ima ask "请总结这个知识库" --kb "我的知识库" -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'question', required: true, positional: true, help: 'Question to ask ima.copilot' },
    { name: 'kb-id', required: false, help: 'ima knowledgeBaseId to ask against' },
    { name: 'kb', required: false, help: 'Knowledge base name to ask against. Required for UI fallback.' },
    { name: 'transport', default: 'auto', choices: ['auto', 'api', 'webcontents', 'ui'], help: 'Transport: auto, api, webcontents, or ui (default: auto)' },
    { name: 'timeout', type: 'int', default: 120, help: 'Max seconds to wait for the answer (default: 120)' },
  ],
  columns: ['Status', 'Transport', 'KnowledgeBase', 'KnowledgeBaseId', 'Question', 'Answer', 'ReferencesFound'],
  func: async (kwargs) => {
    const question = String(kwargs.question || '').trim();
    if (!question) {
      throw new ArgumentError('Question cannot be empty.');
    }

    const timeout = Number(kwargs.timeout || 120);
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new ArgumentError('Timeout must be a positive integer.');
    }

    const kbId = String(kwargs['kb-id'] || '').trim();
    const kb = String(kwargs.kb || '').trim();
    const transport = String(kwargs.transport || 'auto').trim().toLowerCase();
    if (!['auto', 'api', 'webcontents', 'ui'].includes(transport)) {
      throw new ArgumentError('Transport must be one of: auto, api, webcontents, ui.');
    }
    let apiError = null;

    if (transport === 'webcontents') {
      try {
        const result = await askImaWebContents({
          question,
          kbId,
          kb,
          timeout,
        });
        return [{
          Status: result.status || 'success',
          Transport: 'webcontents',
          KnowledgeBase: result.knowledgeBase || '',
          KnowledgeBaseId: result.knowledgeBaseId || '',
          Question: result.question || question,
          Answer: result.answer || '',
          ReferencesFound: result.referencesFound ?? '',
        }];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandExecutionError('ima/ask failed', message);
      }
    }

    if (transport !== 'ui') {
      try {
        const result = await askImaApi({
          question,
          kbId,
          kb,
          timeout,
        });
        return [{
          Status: result.status || 'success',
          Transport: 'api',
          KnowledgeBase: result.knowledgeBase || '',
          KnowledgeBaseId: result.knowledgeBaseId || '',
          Question: result.question || question,
          Answer: result.answer || '',
          ReferencesFound: result.referencesFound ?? '',
        }];
      } catch (error) {
        apiError = error instanceof Error ? error.message : String(error);
        if (transport === 'api') {
          throw new CommandExecutionError('ima/ask failed', apiError);
        }
      }
    }

    if (kbId && !kb) {
      throw new CommandExecutionError('ima/ask failed', `${apiError ? `${apiError}; ` : ''}UI transport requires --kb <knowledgeBaseName>.`);
    }
    if (!kb) {
      throw new ArgumentError('Knowledge base name is required for UI transport. Use --kb <knowledgeBaseName>.');
    }

    try {
      const result = askIma({ question, kb, timeout });
      return [{
        Status: result.status || 'success',
        Transport: 'ui',
        KnowledgeBase: result.knowledgeBase || kb || '',
        KnowledgeBaseId: kbId,
        Question: result.question || question,
        Answer: result.answer || '',
        ReferencesFound: result.referencesFound ?? '',
      }];
    } catch (error) {
      const uiError = error instanceof Error ? error.message : String(error);
      const prefix = apiError ? `API transport failed: ${apiError}; ` : '';
      throw new CommandExecutionError('ima/ask failed', `${prefix}UI transport failed: ${uiError}`);
    }
  },
});
