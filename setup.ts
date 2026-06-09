import { cli, Strategy } from '@jackwener/opencli/registry';
import { inspectIma } from './lib/ax.js';
import { inspectApiState } from './lib/api.js';

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
  columns: ['Status', 'Running', 'ApiReady', 'LoginCookies', 'SafeStorage', 'Hint'],
  func: async (kwargs) => {
    const state = inspectIma({ activate: Boolean(kwargs.activate) });
    const api = inspectApiState();
    const running = Boolean(state.running);
    const uiProbeUnavailable = Boolean(state.error);
    let status = 'Ready';
    let hint = 'Run opencli ima ask "<question>" --kb "<knowledgeBaseName>". Use --transport ui when direct API is unavailable.';

    if (uiProbeUnavailable && api.ready) {
      status = 'API ready; UI probe unavailable';
      hint = 'API transport can use --kb-id. UI fallback needs Accessibility access and --kb "<knowledgeBaseName>".';
    } else if (uiProbeUnavailable) {
      status = 'UI probe unavailable';
      hint = 'Open and log in to ima.copilot, then retry. You can also set IMA_COOKIE for local development.';
    } else if (!running) {
      status = 'ima.copilot not running';
      hint = 'Open ima.copilot first so local login cookies are current, then retry opencli ima setup --activate.';
    } else if (!api.cookieDbExists && !api.explicitCookie) {
      status = 'Cookie DB missing';
      hint = 'Open and log in to ima.copilot, or set IMA_COOKIE for local development.';
    } else if (!api.ready) {
      status = 'Login cookie missing';
      hint = 'Confirm ima.copilot is logged in. The required IMA-TOKEN cookie was not found.';
    } else if (api.encryptedCookies > 0 && !api.explicitSafeStoragePassword) {
      status = 'Ready; Keychain may prompt';
      hint = 'The first kb or ask command may need macOS Keychain access to decrypt ima cookies.';
    }

    return [{
      Status: status,
      Running: uiProbeUnavailable ? 'unknown' : (running ? 'yes' : 'no'),
      ApiReady: api.ready ? 'yes' : 'no',
      LoginCookies: api.tokenCookie || api.explicitCookie ? 'yes' : 'no',
      SafeStorage: api.explicitSafeStoragePassword ? 'env' : (api.encryptedCookies > 0 ? 'keychain' : 'not needed'),
      Hint: hint,
    }];
  },
});
