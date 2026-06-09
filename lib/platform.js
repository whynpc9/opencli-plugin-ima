import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_DISPLAY_NAME = 'ima.copilot';
const DEFAULT_MACOS_BUNDLE_ID = 'com.tencent.imamac';
const DEFAULT_MACOS_APP_PATH = '/Applications/ima.copilot.app';
const DEFAULT_KNOWLEDGE_EXTENSION_ID = 'nkohmbngmopdajidckglcoehlaeepeoi';
const DEFAULT_COOKIE_HOST = 'khmgfdkajnigikondkcjbaflpjflfiee';
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 3000;

export function getImaRuntimeConfig({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const osName = normalizePlatform(platform);
  const displayName = env.IMA_DISPLAY_NAME || DEFAULT_DISPLAY_NAME;
  const knowledgeExtensionId = env.IMA_KNOWLEDGE_EXTENSION_ID || DEFAULT_KNOWLEDGE_EXTENSION_ID;
  const cookieHost = env.IMA_COOKIE_HOST || DEFAULT_COOKIE_HOST;

  if (osName === 'macos') {
    const appSupportDir = env.IMA_APP_SUPPORT_DIR ||
      path.join(homeDir, 'Library/Application Support/com.tencent.imamac');
    const profileDir = env.IMA_PROFILE_DIR || path.join(appSupportDir, 'Default');
    const appPath = env.IMA_APP_PATH || DEFAULT_MACOS_APP_PATH;
    const bundleId = env.IMA_BUNDLE_ID || DEFAULT_MACOS_BUNDLE_ID;
    return {
      platform,
      os: osName,
      label: 'macOS',
      displayName,
      identifiers: {
        bundleId,
        knowledgeExtensionId,
        cookieHost,
        clientType: env.IMA_CLIENT_TYPE || 'mac',
      },
      paths: buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId }),
      commands: {
        processPattern: env.IMA_PROCESS_PATTERN || `${appPath}/Contents/MacOS/ima.copilot`,
      },
      capabilities: {
        uiTransport: true,
        apiCookieDecryption: true,
        keychainSafeStorage: true,
        webContentsLaunch: true,
        recentPreviewScan: true,
      },
      pending: [],
    };
  }

  if (osName === 'windows') {
    const appSupportDir = env.IMA_APP_SUPPORT_DIR || '';
    const profileDir = env.IMA_PROFILE_DIR || (appSupportDir ? path.join(appSupportDir, 'Default') : '');
    const appPath = env.IMA_APP_PATH || '';
    return {
      platform,
      os: osName,
      label: 'Windows',
      displayName,
      identifiers: {
        bundleId: env.IMA_BUNDLE_ID || '',
        knowledgeExtensionId,
        cookieHost,
        clientType: env.IMA_CLIENT_TYPE || 'windows',
      },
      paths: buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId }),
      commands: {
        processPattern: env.IMA_PROCESS_PATTERN || '',
      },
      capabilities: {
        uiTransport: false,
        apiCookieDecryption: false,
        keychainSafeStorage: false,
        webContentsLaunch: false,
        recentPreviewScan: Boolean(profileDir),
      },
      pending: [
        'Discover ima.copilot executable path and profile root on Windows.',
        'Implement CDP launch/quit/process detection with Windows process APIs.',
        'Implement Chromium cookie decryption through Windows DPAPI if direct API remains useful.',
        'Implement UI Automation only if a UI fallback is still required after WebContents support.',
      ],
    };
  }

  return {
    platform,
    os: osName,
    label: platform || 'unknown',
    displayName,
    identifiers: {
      bundleId: env.IMA_BUNDLE_ID || '',
      knowledgeExtensionId,
      cookieHost,
      clientType: env.IMA_CLIENT_TYPE || '',
    },
    paths: buildPaths({
      appPath: env.IMA_APP_PATH || '',
      appSupportDir: env.IMA_APP_SUPPORT_DIR || '',
      profileDir: env.IMA_PROFILE_DIR || '',
      knowledgeExtensionId,
    }),
    commands: {
      processPattern: env.IMA_PROCESS_PATTERN || '',
    },
    capabilities: {
      uiTransport: false,
      apiCookieDecryption: false,
      keychainSafeStorage: false,
      webContentsLaunch: false,
      recentPreviewScan: Boolean(env.IMA_PROFILE_DIR),
    },
    pending: ['This operating system is not implemented.'],
  };
}

export function normalizePlatform(value = process.platform) {
  if (value === 'darwin') return 'macos';
  if (value === 'win32') return 'windows';
  return 'unsupported';
}

export function getImaProfileDir() {
  return getImaRuntimeConfig().paths.profileDir;
}

export function getImaAppSupportDir() {
  return getImaRuntimeConfig().paths.appSupportDir;
}

export function getImaCookieDb() {
  return getImaRuntimeConfig().paths.cookieDb;
}

export function getImaPreferencesPath() {
  return getImaRuntimeConfig().paths.preferences;
}

export function getImaMmkvDir() {
  return getImaRuntimeConfig().paths.mmkvDir;
}

export function getKnowledgeExtensionId() {
  return getImaRuntimeConfig().identifiers.knowledgeExtensionId;
}

export function getImaCookieHost() {
  return getImaRuntimeConfig().identifiers.cookieHost;
}

export function getImaClientType() {
  return getImaRuntimeConfig().identifiers.clientType;
}

export function assertImaCapability(capability, featureName) {
  const config = getImaRuntimeConfig();
  if (config.capabilities[capability]) return config;
  const pending = config.pending.length ? ` Pending work: ${config.pending.join(' ')}` : '';
  throw new Error(`${featureName} is not implemented for ${config.label}.${pending}`);
}

export function activateImaApp() {
  const config = assertImaCapability('uiTransport', 'ima UI transport');
  execFileSync('osascript', ['-e', `tell application id "${config.identifiers.bundleId}" to activate`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function launchImaForWebContents({ port }) {
  const config = assertImaCapability('webContentsLaunch', 'ima WebContents launch');
  if (config.os !== 'macos') {
    throw new Error(`ima WebContents launch is not implemented for ${config.label}.`);
  }
  quitImaApp();
  await waitForImaExit();
  const profileLink = createMacOsProfileSymlink(config.paths.appSupportDir);
  execFileSync('open', [
    '-n',
    '-a',
    config.paths.appPath,
    '--args',
    `--user-data-dir=${profileLink}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--enable-features=TencentRemoteDebugSwitch',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function quitImaApp() {
  const config = getImaRuntimeConfig();
  if (config.os !== 'macos' || !config.identifiers.bundleId) return;
  try {
    execFileSync('osascript', ['-e', `tell application id "${config.identifiers.bundleId}" to quit`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch {
    // The app may not be running.
  }
}

export async function waitForImaExit() {
  for (let index = 0; index < 30; index += 1) {
    if (!isImaProcessRunning()) return;
    await sleep(300);
  }
}

export function isImaProcessRunning() {
  const config = getImaRuntimeConfig();
  if (config.os !== 'macos' || !config.commands.processPattern) return false;
  try {
    execFileSync('pgrep', ['-f', config.commands.processPattern], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

export function readImaSafeStoragePassword({ timeoutMs = DEFAULT_KEYCHAIN_TIMEOUT_MS } = {}) {
  const config = assertImaCapability('keychainSafeStorage', 'ima Safe Storage password lookup');
  if (config.os !== 'macos') {
    throw new Error(`ima Safe Storage lookup is not implemented for ${config.label}.`);
  }

  const attempts = [
    ['ima.copilot Safe Storage', 'ima.copilot'],
    ['ima.copilot Safe Storage', ''],
    ['Chrome Safe Storage', 'Chrome'],
  ];

  for (const [service, account] of attempts) {
    try {
      const args = ['find-generic-password', '-s', service, '-w'];
      if (account) args.splice(3, 0, '-a', account);
      const value = execFileSync('security', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      }).trim();
      if (value) return value;
    } catch {
      // Try the next known Chromium safe-storage service.
    }
  }

  throw new Error(
    `Could not read ima.copilot Safe Storage from macOS Keychain within ${timeoutMs}ms per attempt. Unlock/allow the Keychain prompt, or set IMA_SAFE_STORAGE_PASSWORD for local development.`,
  );
}

function buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId }) {
  return {
    appPath,
    appSupportDir,
    profileDir,
    mmkvDir: appSupportDir ? path.join(appSupportDir, 'mmkv') : '',
    cookieDb: profileDir ? path.join(profileDir, 'Extension Cookies') : '',
    preferences: profileDir ? path.join(profileDir, 'Preferences') : '',
    extensionRoot: profileDir ? path.join(profileDir, 'Extensions', knowledgeExtensionId) : '',
  };
}

function createMacOsProfileSymlink(appSupportDir) {
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ima-profile-link-'));
  fs.rmdirSync(link);
  fs.symlinkSync(appSupportDir, link, 'dir');
  return link;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
