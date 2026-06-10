import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
import { askImaApi } from './lib/api.js';
import { askIma, inspectIma } from './lib/ax.js';
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
    let uiError = null;

    if (transport === 'webcontents') {
      try {
        return [formatAskResult(await askImaWebContents({
          question,
          kbId,
          kb,
          timeout,
        }), { transport: 'webcontents', question })];
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
        return [formatAskResult(result, { transport: 'api', question })];
      } catch (error) {
        apiError = error instanceof Error ? error.message : String(error);
        if (transport === 'api') {
          throw new CommandExecutionError('ima/ask failed', apiError);
        }
      }
    }

    if (transport === 'auto') {
      if (kb) {
        const state = inspectIma({ activate: true });
        if (state.composerReady) {
          try {
            return [formatAskResult(askIma({ question, kb, timeout }), {
              transport: 'ui',
              question,
              knowledgeBaseId: kbId,
            })];
          } catch (error) {
            uiError = error instanceof Error ? error.message : String(error);
          }
        } else {
          uiError = summarizeUiPreflight(state);
        }
      } else {
        uiError = 'UI transport requires --kb <knowledgeBaseName>.';
      }

      try {
        return [formatAskResult(await askImaWebContents({
          question,
          kbId,
          kb,
          timeout,
        }), { transport: 'webcontents', question })];
      } catch (error) {
        const webContentsError = error instanceof Error ? error.message : String(error);
        throw new CommandExecutionError('ima/ask failed', buildAutoFailureMessage({
          apiError,
          uiError,
          webContentsError,
        }));
      }
    }

    if (transport === 'ui' && kbId && !kb) {
      throw new CommandExecutionError('ima/ask failed', `${apiError ? `${apiError}; ` : ''}UI transport requires --kb <knowledgeBaseName>.`);
    }
    if (!kb) {
      throw new ArgumentError('Knowledge base name is required for UI transport. Use --kb <knowledgeBaseName>.');
    }

    try {
      const result = askIma({ question, kb, timeout });
      return [formatAskResult(result, { transport: 'ui', question, knowledgeBaseId: kbId })];
    } catch (error) {
      const uiError = error instanceof Error ? error.message : String(error);
      const prefix = apiError ? `API transport failed: ${apiError}; ` : '';
      throw new CommandExecutionError('ima/ask failed', `${prefix}UI transport failed: ${uiError}`);
    }
  },
});

function formatAskResult(result, { transport, question, knowledgeBaseId = '' }) {
  return {
    Status: result.status || 'success',
    Transport: transport,
    KnowledgeBase: result.knowledgeBase || '',
    KnowledgeBaseId: result.knowledgeBaseId || knowledgeBaseId || '',
    Question: result.question || question,
    Answer: result.answer || '',
    ReferencesFound: result.referencesFound ?? '',
  };
}

function summarizeUiPreflight(state) {
  if (state?.error) return `UI probe unavailable: ${state.error}`;
  if (!state?.running) return 'UI transport skipped because ima.copilot is not running.';
  if (state?.trusted === false) return 'UI transport skipped because Accessibility permission is not granted.';
  if (!state?.composerReady) {
    return `UI transport skipped because the ima question composer is not visible to Accessibility.${state?.textCount != null ? ` Accessible text nodes: ${state.textCount}.` : ''}`;
  }
  return 'UI transport skipped because its readiness could not be confirmed.';
}

function buildAutoFailureMessage({ apiError, uiError, webContentsError }) {
  return [
    apiError ? `API transport failed: ${apiError}` : '',
    uiError ? `UI transport skipped/failed: ${uiError}` : '',
    webContentsError ? `WebContents transport failed: ${webContentsError}` : '',
  ].filter(Boolean).join('; ');
}

export const __test__ = {
  buildAutoFailureMessage,
  formatAskResult,
  summarizeUiPreflight,
};
