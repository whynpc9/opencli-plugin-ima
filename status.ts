import { cli, Strategy } from '@jackwener/opencli/registry';
import { inspectIma } from './lib/ax.js';
import { inspectApiState } from './lib/api.js';

export const statusCommand = cli({
  site: 'ima',
  name: 'status',
  access: 'read',
  description: 'Check ima.copilot app and local API login state',
  example: 'opencli ima status -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  columns: ['Status', 'Running', 'Trusted', 'Title', 'KnowledgeBase', 'ApiReady', 'TokenCookie', 'CookieRows', 'ExtensionVersion', 'Endpoint'],
  func: async () => {
    const state = inspectIma();
    const api = inspectApiState();
    const uiProbeUnavailable = Boolean(state.error);
    return [{
      Status: api.ready
        ? (uiProbeUnavailable ? 'API login state found; UI probe unavailable' : 'API login state found')
        : (uiProbeUnavailable ? 'UI probe unavailable' : (state.running ? 'App connected' : 'Not ready')),
      Running: uiProbeUnavailable ? 'unknown' : (state.running ? 'yes' : 'no'),
      Trusted: uiProbeUnavailable ? 'unknown' : (state.trusted ? 'yes' : 'no'),
      Title: state.title || '',
      KnowledgeBase: state.knowledgeBase || '',
      ApiReady: api.ready ? 'yes' : 'no',
      TokenCookie: api.tokenCookie || api.explicitCookie ? 'yes' : 'no',
      CookieRows: api.cookieRows,
      ExtensionVersion: api.extensionVersion,
      Endpoint: api.endpoint,
    }];
  },
});
