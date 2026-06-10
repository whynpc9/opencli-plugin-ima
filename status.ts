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
  columns: ['Status', 'Running', 'Trusted', 'ComposerReady', 'Title', 'KnowledgeBase', 'ApiReady', 'TokenCookie', 'CookieRows', 'ExtensionVersion', 'Endpoint'],
  func: async () => {
    const state = inspectIma();
    const api = inspectApiState();
    const uiProbeUnavailable = Boolean(state.error);
    const platformIncomplete = uiProbeUnavailable && api.platform && api.platform !== 'macos';
    const composerReady = !uiProbeUnavailable && Boolean(state.composerReady);
    return [{
      Status: api.ready
        ? (uiProbeUnavailable ? 'API login state found; UI probe unavailable' : (composerReady ? 'API login state found' : 'API login state found; UI composer unavailable'))
        : (platformIncomplete ? `${api.platformLabel || api.platform} support incomplete` : (uiProbeUnavailable ? 'UI probe unavailable' : (state.running ? 'App connected' : 'Not ready'))),
      Running: uiProbeUnavailable ? 'unknown' : (state.running ? 'yes' : 'no'),
      Trusted: uiProbeUnavailable ? 'unknown' : (state.trusted ? 'yes' : 'no'),
      ComposerReady: uiProbeUnavailable ? 'unknown' : (composerReady ? 'yes' : 'no'),
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
