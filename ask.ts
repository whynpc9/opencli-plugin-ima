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
    { name: 'session', required: false, choices: ['new', 'continue'], help: 'WebContents session mode: new or continue from the last cached ask session' },
    { name: 'session-id', required: false, help: 'Existing ima session id to continue through WebContents' },
    { name: 'model', required: false, help: 'Model alias or numeric model type, such as hy, hy-think, ds-v3.2, or ds-v3.2-think' },
    { name: 'model-type', type: 'int', required: false, help: 'Raw ima model_type to send in model_info' },
    { name: 'model-id', required: false, help: 'Raw ima model_id to send in model_info' },
    { name: 'think', required: false, choices: ['default', 'fast', 'deep', 'instruct', 'thinking'], help: 'Thinking mode alias. fast/instruct selects non-thinking; deep/thinking selects paired thinking models when known.' },
    { name: 'timeout', type: 'int', default: 120, help: 'Max seconds to wait for the answer (default: 120)' },
  ],
  columns: ['Status', 'Transport', 'KnowledgeBase', 'KnowledgeBaseId', 'SessionId', 'SessionMode', 'Model', 'Question', 'Answer', 'ReferencesFound'],
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
    const sessionId = String(kwargs['session-id'] || '').trim();
    const explicitSessionMode = String(kwargs.session || '').trim();
    const sessionMode = normalizeAskSessionMode(explicitSessionMode, { hasSessionId: Boolean(sessionId) });
    const hasSessionControls = Boolean(sessionId || explicitSessionMode);
    const modelOptions = parseModelOptions(kwargs);
    const askOptions = {
      question,
      kbId,
      kb,
      timeout,
      sessionId,
      sessionMode,
      ...modelOptions.request,
    };
    if (hasSessionControls && transport === 'api') {
      throw new ArgumentError('Session controls require --transport webcontents or --transport auto.');
    }
    if ((hasSessionControls || modelOptions.hasModelControls) && transport === 'ui') {
      throw new ArgumentError('Session and model controls are not supported by UI transport. Use --transport webcontents or --transport auto.');
    }
    let apiError = null;
    let uiError = null;

    if (transport === 'webcontents') {
      try {
        return [formatAskResult(await askImaWebContents(askOptions), { transport: 'webcontents', question })];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CommandExecutionError('ima/ask failed', message);
      }
    }

    if (transport !== 'ui' && !hasSessionControls) {
      try {
        const result = await askImaApi({
          question,
          kbId,
          kb,
          timeout,
          ...modelOptions.request,
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
      if (hasSessionControls) {
        uiError = 'UI transport skipped because session controls require WebContents.';
      } else if (modelOptions.hasModelControls) {
        uiError = 'UI transport skipped because model controls require API or WebContents.';
      } else if (kb) {
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
        return [formatAskResult(await askImaWebContents(askOptions), { transport: 'webcontents', question })];
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
    SessionId: result.sessionId || '',
    SessionMode: result.sessionMode || '',
    Model: formatModelLabel(result),
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

const MODEL_ALIASES = new Map([
  ['hy', 0],
  ['hy-2.0', 0],
  ['hunyuan', 0],
  ['hunyuan-2.0', 0],
  ['hy-think', 2],
  ['hy-2.0-think', 2],
  ['hunyuan-think', 2],
  ['hunyuan-2.0-think', 2],
  ['deepseek-r1', 1],
  ['ds-r1', 1],
  ['deepseek-v3', 3],
  ['ds-v3', 3],
  ['deepseek', 4],
  ['ds', 4],
  ['deepseek-v3.2', 4],
  ['ds-v3.2', 4],
  ['ds-fast', 4],
  ['deepseek-v3.2-think', 5],
  ['ds-v3.2-think', 5],
  ['ds-think', 5],
  ['ds-deep', 5],
  ['glm5', 3000],
  ['glm-5', 3000],
  ['glm5-think', 3001],
  ['glm-5-think', 3001],
  ['kimi-k2.5', 4000],
  ['kimi-k2.5-think', 4001],
  ['copilot-default', 100000],
  ['official-paid', 110000],
  ['custom', 1000000],
  ['customize', 1000000],
]);

const THINK_PAIRS = new Map([
  [0, { instruct: 0, thinking: 2 }],
  [2, { instruct: 0, thinking: 2 }],
  [4, { instruct: 4, thinking: 5 }],
  [5, { instruct: 4, thinking: 5 }],
  [3000, { instruct: 3000, thinking: 3001 }],
  [3001, { instruct: 3000, thinking: 3001 }],
  [4000, { instruct: 4000, thinking: 4001 }],
  [4001, { instruct: 4000, thinking: 4001 }],
]);

function normalizeAskSessionMode(value, { hasSessionId = false } = {}) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode) return hasSessionId ? 'continue' : 'new';
  if (['new', 'continue'].includes(mode)) return mode;
  throw new ArgumentError('Session must be one of: new, continue.');
}

function parseModelOptions(kwargs) {
  const rawModel = String(kwargs.model || '').trim();
  const rawModelType = kwargs['model-type'];
  const rawModelId = String(kwargs['model-id'] || '').trim();
  const think = normalizeThinkMode(kwargs.think);
  let modelType;
  let modelId = rawModelId;
  let hasModelControls = Boolean(rawModel || rawModelId || think);

  if (rawModel) {
    modelType = parseModel(rawModel);
  }

  if (rawModelType !== undefined && rawModelType !== null && String(rawModelType).trim() !== '') {
    const explicitModelType = Number(rawModelType);
    if (!Number.isInteger(explicitModelType) || explicitModelType < 0) {
      throw new ArgumentError('model-type must be a non-negative integer.');
    }
    if (modelType !== undefined && modelType !== explicitModelType) {
      throw new ArgumentError('Use either --model or --model-type, or make sure they resolve to the same model type.');
    }
    modelType = explicitModelType;
    hasModelControls = true;
  }

  if (think) {
    modelType = applyThinkMode(modelType, think);
  }

  const request = {};
  if (modelType !== undefined) request.modelType = modelType;
  if (modelId) request.modelId = modelId;
  return { request, hasModelControls };
}

function parseModel(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const key = normalizeModelAlias(value);
  if (MODEL_ALIASES.has(key)) return MODEL_ALIASES.get(key);
  throw new ArgumentError(`Unknown model alias "${value}". Use --model-type for raw ima model_type values.`);
}

function normalizeThinkMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || mode === 'default') return '';
  if (mode === 'fast' || mode === 'instruct') return 'instruct';
  if (mode === 'deep' || mode === 'thinking') return 'thinking';
  throw new ArgumentError('think must be one of: default, fast, deep, instruct, thinking.');
}

function applyThinkMode(modelType, think) {
  const base = modelType === undefined ? 0 : modelType;
  return THINK_PAIRS.get(base)?.[think] ?? base;
}

function normalizeModelAlias(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function formatModelLabel(result) {
  const type = result.modelType;
  const id = result.modelId || '';
  if (type === undefined || type === null || type === '') return id;
  return id ? `${type}:${id}` : String(type);
}

export const __test__ = {
  buildAutoFailureMessage,
  formatAskResult,
  normalizeAskSessionMode,
  parseModelOptions,
  summarizeUiPreflight,
};
