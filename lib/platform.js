import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const DEFAULT_DISPLAY_NAME = 'ima.copilot';
const DEFAULT_MACOS_BUNDLE_ID = 'com.tencent.imamac';
const DEFAULT_MACOS_APP_PATH = '/Applications/ima.copilot.app';
const DEFAULT_WINDOWS_BUNDLE_ID = 'com.tencent.imawin';
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
    const pathLib = path.posix;
    const appSupportDir = env.IMA_APP_SUPPORT_DIR ||
      pathLib.join(homeDir, 'Library/Application Support/com.tencent.imamac');
    const profileDir = env.IMA_PROFILE_DIR || pathLib.join(appSupportDir, 'Default');
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
      paths: buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId, pathLib }),
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
    const pathLib = path.win32;
    const localAppData = env.LOCALAPPDATA || pathLib.join(homeDir, 'AppData', 'Local');
    const installRoot = pathLib.join(localAppData, 'ima.copilot');
    const appSupportDir = env.IMA_APP_SUPPORT_DIR || pathLib.join(installRoot, 'User Data');
    const profileDir = env.IMA_PROFILE_DIR || pathLib.join(appSupportDir, 'Default');
    const appPath = env.IMA_APP_PATH || pathLib.join(installRoot, 'Application', 'ima.copilot.exe');
    return {
      platform,
      os: osName,
      label: 'Windows',
      displayName,
      identifiers: {
        bundleId: env.IMA_BUNDLE_ID || DEFAULT_WINDOWS_BUNDLE_ID,
        knowledgeExtensionId,
        cookieHost,
        clientType: env.IMA_CLIENT_TYPE || 'windows',
      },
      paths: buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId, pathLib }),
      commands: {
        processPattern: env.IMA_PROCESS_PATTERN || 'ima.copilot.exe',
      },
      capabilities: {
        uiTransport: false,
        apiCookieDecryption: false,
        keychainSafeStorage: false,
        webContentsLaunch: true,
        recentPreviewScan: true,
      },
      pending: [
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
  if (config.os === 'macos') {
    quitImaApp();
    await waitForImaExit();
    const profileLink = createProfileSymlink(config.paths.appSupportDir);
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
    return;
  }

  if (config.os === 'windows') {
    if (!config.paths.appPath || !fs.existsSync(config.paths.appPath)) {
      throw new Error(`ima.copilot executable was not found at ${config.paths.appPath || '(empty)'}. Set IMA_APP_PATH to the installed ima.copilot.exe.`);
    }
    if (!config.paths.appSupportDir || !fs.existsSync(config.paths.appSupportDir)) {
      throw new Error(`ima.copilot user data directory was not found at ${config.paths.appSupportDir || '(empty)'}. Set IMA_APP_SUPPORT_DIR to the Chromium User Data directory.`);
    }

    quitImaApp();
    await waitForImaExit();
    const profileLink = createWindowsProfileJunction(config.paths.appSupportDir);
    const child = spawn(config.paths.appPath, [
      `--user-data-dir=${profileLink}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--enable-features=TencentRemoteDebugSwitch',
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return;
  }

  throw new Error(`ima WebContents launch is not implemented for ${config.label}.`);
}

export function quitImaApp() {
  const config = getImaRuntimeConfig();
  if (config.os === 'windows') {
    try {
      execFileSync('taskkill', ['/IM', 'ima.copilot.exe', '/T', '/F'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      // The app may not be running.
    }
    return;
  }

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
  if (config.os === 'windows') {
    try {
      const output = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ima.copilot.exe', '/NH'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return /\bima\.copilot\.exe\b/i.test(output);
    } catch {
      return false;
    }
  }

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

function buildPaths({ appPath, appSupportDir, profileDir, knowledgeExtensionId, pathLib = path }) {
  return {
    appPath,
    appSupportDir,
    profileDir,
    mmkvDir: appSupportDir ? pathLib.join(appSupportDir, 'mmkv') : '',
    cookieDb: profileDir ? pathLib.join(profileDir, 'Extension Cookies') : '',
    preferences: profileDir ? pathLib.join(profileDir, 'Preferences') : '',
    extensionRoot: profileDir ? pathLib.join(profileDir, 'Extensions', knowledgeExtensionId) : '',
  };
}

function createProfileSymlink(appSupportDir) {
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ima-profile-link-'));
  fs.rmdirSync(link);
  fs.symlinkSync(appSupportDir, link, 'dir');
  return link;
}

function createWindowsProfileJunction(appSupportDir) {
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-ima-user-data-link-'));
  fs.rmdirSync(link);
  fs.symlinkSync(path.resolve(appSupportDir), link, 'junction');
  return link;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
