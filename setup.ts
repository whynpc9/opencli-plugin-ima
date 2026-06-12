import { cli, Strategy } from '@jackwener/opencli/registry';
import * as fs from 'node:fs';
import { inspectIma } from './lib/ax.js';
import { inspectApiState } from './lib/api.js';
import { getImaRuntimeConfig } from './lib/platform.js';

export const setupCommand = cli({
  site: 'ima',
  name: 'setup',
  access: 'read',
  description: 'Check local prerequisites for asking ima.copilot through its API login state',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'activate', type: 'boolean', default: false, help: 'Bring ima.copilot to the foreground before checking' },
  ],
  columns: ['Status', 'Running', 'ComposerReady', 'WebContents', 'ApiReady', 'LoginCookies', 'SafeStorage', 'Hint'],
  func: async (kwargs) => {
    const runtime = getImaRuntimeConfig();
    const state = inspectIma({ activate: Boolean(kwargs.activate) });
    const api = inspectApiState();
    const running = Boolean(state.running);
    const uiProbeUnavailable = Boolean(state.error);
    const composerReady = !uiProbeUnavailable && Boolean(state.composerReady);
    const webContents = inspectWebContents(runtime);
    let status = 'Ready';
    let hint = 'Run opencli ima ask "<question>" --kb "<knowledgeBaseName>". Auto transport can use WebContents when direct API and UI are unavailable.';

    if (uiProbeUnavailable && webContents.ready) {
      status = 'Ready via WebContents';
      hint = 'Run opencli ima ask "<question>" --kb "<knowledgeBaseName>". Auto transport can use WebContents with the local ima.copilot login state.';
    } else if (uiProbeUnavailable && api.ready) {
      status = 'API ready; UI probe unavailable';
      hint = 'API transport can use --kb-id. UI fallback needs Accessibility access and --kb "<knowledgeBaseName>".';
    } else if (uiProbeUnavailable && api.platform && api.platform !== 'macos') {
      status = `${api.platformLabel || api.platform} UI fallback incomplete`;
      hint = 'Use WebContents for the reliable Windows path. Direct API can now try DPAPI cookie decryption, but may still return ima business error 600001.';
    } else if (uiProbeUnavailable) {
      status = 'UI probe unavailable';
      hint = 'Open and log in to ima.copilot, then retry. You can also set IMA_COOKIE for local development.';
    } else if (!running) {
      status = 'ima.copilot not running';
      hint = 'Open ima.copilot first so local login cookies are current, then retry opencli ima setup --activate.';
    } else if (!api.cookieDbExists && !api.explicitCookie) {
      status = 'Cookie DB missing';
      hint = 'Open and log in to ima.copilot, or set IMA_COOKIE for local development.';
    } else if (!api.sqliteAvailable && !api.explicitCookie) {
      status = 'sqlite3 missing';
      hint = 'Install sqlite3 or set IMA_COOKIE for direct API experiments. WebContents can still use the local ima.copilot login state.';
    } else if (!api.ready) {
      status = 'Login cookie missing';
      hint = 'Confirm ima.copilot is logged in. The required IMA-TOKEN cookie was not found.';
    } else if (!composerReady) {
      status = 'Ready; UI composer unavailable';
      hint = 'Direct API state is present, but UI fallback cannot see the question composer. Auto transport will try WebContents after API failure.';
    } else if (api.encryptedCookies > 0 && !api.explicitSafeStoragePassword) {
      status = 'Ready; Keychain may prompt';
      hint = 'The first kb or ask command may need macOS Keychain access to decrypt ima cookies.';
    }

    return [{
      Status: status,
      Running: uiProbeUnavailable ? 'unknown' : (running ? 'yes' : 'no'),
      ComposerReady: uiProbeUnavailable ? 'unknown' : (composerReady ? 'yes' : 'no'),
      WebContents: webContents.label,
      ApiReady: api.ready ? 'yes' : 'no',
      LoginCookies: api.tokenCookie || api.explicitCookie ? 'yes' : 'no',
      SafeStorage: api.explicitSafeStoragePassword ? 'env' : storageLabel(api),
      Hint: hint,
    }];
  },
});

function storageLabel(api) {
  if (api.encryptedCookies <= 0) return 'not needed';
  if (api.platform === 'windows') return api.localStateExists ? 'dpapi' : 'local state missing';
  return 'keychain';
}

function inspectWebContents(runtime) {
  if (!runtime.capabilities.webContentsLaunch) return { ready: false, label: 'no' };
  if (!runtime.paths.appPath || !fs.existsSync(runtime.paths.appPath)) return { ready: false, label: 'app missing' };
  if (!runtime.paths.profileDir || !fs.existsSync(runtime.paths.profileDir)) return { ready: false, label: 'profile missing' };
  return { ready: true, label: 'yes' };
}
