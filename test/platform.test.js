import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getImaRuntimeConfig, normalizePlatform } from '../lib/platform.js';

test('platform config preserves current macOS runtime defaults', () => {
  const config = getImaRuntimeConfig({
    platform: 'darwin',
    homeDir: '/Users/example',
    env: {},
  });

  assert.equal(config.os, 'macos');
  assert.equal(config.label, 'macOS');
  assert.equal(config.identifiers.bundleId, 'com.tencent.imamac');
  assert.equal(config.identifiers.clientType, 'mac');
  assert.equal(config.paths.appPath, '/Applications/ima.copilot.app');
  assert.equal(config.paths.appSupportDir, '/Users/example/Library/Application Support/com.tencent.imamac');
  assert.equal(config.paths.profileDir, '/Users/example/Library/Application Support/com.tencent.imamac/Default');
  assert.equal(config.paths.cookieDb, '/Users/example/Library/Application Support/com.tencent.imamac/Default/Extension Cookies');
  assert.equal(config.capabilities.uiTransport, true);
  assert.equal(config.capabilities.apiCookieDecryption, true);
  assert.equal(config.capabilities.webContentsLaunch, true);
});

test('platform config records Windows WebContents support and remaining gaps', () => {
  const config = getImaRuntimeConfig({
    platform: 'win32',
    env: {
      IMA_APP_PATH: 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\ima.exe',
      IMA_APP_SUPPORT_DIR: 'C:\\Users\\example\\AppData\\Roaming\\ima.copilot',
      IMA_PROFILE_DIR: 'C:\\Users\\example\\AppData\\Roaming\\ima.copilot\\Default',
    },
  });

  assert.equal(config.os, 'windows');
  assert.equal(config.label, 'Windows');
  assert.equal(config.identifiers.clientType, 'windows');
  assert.equal(config.paths.appPath, 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\ima.exe');
  assert.equal(config.paths.profileDir, 'C:\\Users\\example\\AppData\\Roaming\\ima.copilot\\Default');
  assert.equal(config.commands.processPattern, 'ima.exe');
  assert.equal(config.capabilities.uiTransport, false);
  assert.equal(config.capabilities.apiCookieDecryption, false);
  assert.equal(config.capabilities.webContentsLaunch, true);
  assert.ok(config.pending.some((item) => item.includes('DPAPI')));
});

test('platform config discovers Windows ima defaults from LocalAppData', () => {
  const config = getImaRuntimeConfig({
    platform: 'win32',
    homeDir: 'C:\\Users\\example',
    env: {
      LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local',
    },
  });

  assert.equal(config.paths.appPath, 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\Application\\ima.copilot.exe');
  assert.equal(config.paths.appSupportDir, 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\User Data');
  assert.equal(config.paths.profileDir, 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\User Data\\Default');
  assert.equal(config.paths.cookieDb, 'C:\\Users\\example\\AppData\\Local\\ima.copilot\\User Data\\Default\\Extension Cookies');
  assert.equal(config.commands.processPattern, 'ima.copilot.exe');
  assert.equal(config.capabilities.webContentsLaunch, true);
  assert.equal(config.capabilities.recentPreviewScan, true);
});

test('platform config honors Windows process pattern overrides', () => {
  const config = getImaRuntimeConfig({
    platform: 'win32',
    homeDir: 'C:\\Users\\example',
    env: {
      IMA_APP_PATH: 'D:\\Apps\\ima-custom\\custom-ima.exe',
      IMA_PROCESS_PATTERN: 'D:\\Apps\\ima-custom\\runner.exe',
    },
  });

  assert.equal(config.paths.appPath, 'D:\\Apps\\ima-custom\\custom-ima.exe');
  assert.equal(config.commands.processPattern, 'D:\\Apps\\ima-custom\\runner.exe');
});

test('normalizePlatform maps Node platform ids to adapter names', () => {
  assert.equal(normalizePlatform('darwin'), 'macos');
  assert.equal(normalizePlatform('win32'), 'windows');
  assert.equal(normalizePlatform('linux'), 'unsupported');
});
