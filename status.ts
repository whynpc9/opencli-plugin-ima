import { cli, Strategy } from '@jackwener/opencli/registry';
import * as fs from 'node:fs';
import { inspectIma } from './lib/ax.js';
import { inspectApiState } from './lib/api.js';
import { getImaRuntimeConfig } from './lib/platform.js';

export const statusCommand = cli({
  site: 'ima',
  name: 'status',
  access: 'read',
  description: 'Check ima.copilot app and local API login state',
  example: 'opencli ima status -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  columns: ['Status', 'Running', 'Trusted', 'ComposerReady', 'WebContents', 'Title', 'KnowledgeBase', 'ApiReady', 'TokenCookie', 'CookieRows', 'ExtensionVersion', 'Endpoint'],
  func: async () => {
    const runtime = getImaRuntimeConfig();
    const state = inspectIma();
    const api = inspectApiState();
    const uiProbeUnavailable = Boolean(state.error);
    const platformIncomplete = uiProbeUnavailable && api.platform && api.platform !== 'macos';
    const composerReady = !uiProbeUnavailable && Boolean(state.composerReady);
    const webContents = inspectWebContents(runtime);
    return [{
      Status: webContents.ready
        ? (api.ready ? 'WebContents ready; API login state found' : 'WebContents ready')
        : api.ready
        ? (uiProbeUnavailable ? 'API login state found; UI probe unavailable' : (composerReady ? 'API login state found' : 'API login state found; UI composer unavailable'))
        : (platformIncomplete ? `${api.platformLabel || api.platform} support incomplete` : (uiProbeUnavailable ? 'UI probe unavailable' : (state.running ? 'App connected' : 'Not ready'))),
      Running: uiProbeUnavailable ? 'unknown' : (state.running ? 'yes' : 'no'),
      Trusted: uiProbeUnavailable ? 'unknown' : (state.trusted ? 'yes' : 'no'),
      ComposerReady: uiProbeUnavailable ? 'unknown' : (composerReady ? 'yes' : 'no'),
      WebContents: webContents.label,
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

function inspectWebContents(runtime) {
  if (!runtime.capabilities.webContentsLaunch) return { ready: false, label: 'no' };
  if (!runtime.paths.appPath || !fs.existsSync(runtime.paths.appPath)) return { ready: false, label: 'app missing' };
  if (!runtime.paths.profileDir || !fs.existsSync(runtime.paths.profileDir)) return { ready: false, label: 'profile missing' };
  return { ready: true, label: 'yes' };
}
