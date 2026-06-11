import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getImaProfileDir } from './platform.js';

const MAX_SCAN_FILE_BYTES = 160 * 1024 * 1024;
const PREVIEW_URL_RE = /chrome-extension:\/\/[a-z]{32}\/index\.html\?originUrl=[^\s"'<>]+/g;

export function findRecentDocumentPreviews({ title = '', mediaId = '' } = {}) {
  const queryTitle = normalizeTitle(title);
  const queryMediaId = String(mediaId || '').trim();
  const previews = [];

  for (const file of getRecentPreviewCandidateFiles()) {
    let buffer;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SCAN_FILE_BYTES) continue;
      buffer = fs.readFileSync(file);
    } catch {
      continue;
    }

    for (const text of decodeBufferCandidates(buffer)) {
      previews.push(...extractPreviewDocumentsFromText(text, file));
    }
  }

  const unique = dedupePreviews(previews);
  if (!queryTitle && !queryMediaId) return unique;

  const exact = unique.filter((item) => (
    (queryMediaId && item.mediaId === queryMediaId) ||
    (queryTitle && normalizeTitle(item.title) === queryTitle)
  ));
  if (exact.length) return exact;

  return unique.filter((item) => (
    (queryMediaId && item.mediaId.includes(queryMediaId)) ||
    (queryTitle && normalizeTitle(item.title).includes(queryTitle))
  ));
}

export function extractPreviewDocumentsFromText(text, source = '') {
  const rows = [];
  for (const match of String(text || '').matchAll(PREVIEW_URL_RE)) {
    const previewUrl = cleanPreviewUrl(match[0]);
    const row = parsePreviewUrl(previewUrl, source);
    if (row) rows.push(row);
  }
  return rows;
}

export async function downloadDocumentUrl({ url, output = '', title = 'ima-document' } = {}) {
  if (!url) throw new Error('Download URL is required.');

  const finalPath = reserveOutputPath({ output, title });
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.download-${process.pid}`;

  const response = await fetch(url, {
    headers: {
      accept: '*/*',
      'user-agent': 'opencli-plugin-ima',
    },
  });
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error('download response has no readable body');
  }

  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpPath));
    await fs.promises.rename(tmpPath, finalPath);
  } catch (error) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  const stat = await fs.promises.stat(finalPath);
  return {
    output: finalPath,
    bytes: stat.size,
    contentType: response.headers.get('content-type') || '',
    status: response.status,
  };
}

function getRecentPreviewCandidateFiles() {
  const profileDir = getImaProfileDir();
  if (!profileDir) return [];
  const files = [];
  collectFiles(path.join(profileDir, 'Sessions'), files, { recursive: false });
  collectFiles(path.join(profileDir, 'shared_proto_db'), files, { recursive: false });

  try {
    for (const name of fs.readdirSync(profileDir)) {
      if (!/^IMA_/i.test(name)) continue;
      const root = path.join(profileDir, name);
      collectFiles(root, files, {
        recursive: true,
        include: (file) => /(?:^|[\\/])(History|History-wal|History-shm|LOG|CURRENT|MANIFEST-|[0-9]+\.log)$/i.test(file),
      });
    }
  } catch {
    // The local profile is best-effort; callers get an empty result if it is unavailable.
  }

  return [...new Set(files)];
}

function collectFiles(dir, output, { recursive = false, include = () => true } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) collectFiles(file, output, { recursive, include });
      continue;
    }
    if (entry.isFile() && include(file)) output.push(file);
  }
}

function decodeBufferCandidates(buffer) {
  return [
    buffer.toString('utf8'),
    buffer.toString('utf16le'),
    buffer.length > 1 ? buffer.subarray(1).toString('utf16le') : '',
  ].filter(Boolean);
}

function cleanPreviewUrl(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]+/g, '')
    .replace(/[)\]}*,.;]+$/g, '');
}

function parsePreviewUrl(previewUrl, source) {
  let preview;
  try {
    preview = new URL(previewUrl);
  } catch {
    return null;
  }

  const originUrl = preview.searchParams.get('originUrl') || '';
  if (!originUrl) return null;

  let origin;
  try {
    origin = new URL(originUrl);
  } catch {
    return null;
  }

  const mediaId = origin.searchParams.get('media_id') || origin.searchParams.get('mediaId') || '';
  const title = origin.searchParams.get('media_title') || origin.searchParams.get('mediaTitle') || safeBasename(origin.pathname);
  return {
    title,
    mediaId,
    url: origin.toString(),
    previewUrl,
    source,
  };
}

function dedupePreviews(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = `${item.mediaId}\n${item.title}\n${item.url}`;
    if (!item.url || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function reserveOutputPath({ output, title }) {
  const expanded = expandHome(String(output || '').trim());
  const fileName = safeFileName(title || 'ima-document');
  const basePath = expanded
    ? resolveOutputArgument(expanded, fileName)
    : path.join(os.homedir(), 'Downloads', fileName);

  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`could not reserve output path for ${basePath}`);
}

function resolveOutputArgument(output, fileName) {
  if (output.endsWith(path.sep)) return path.join(output, fileName);
  try {
    if (fs.existsSync(output) && fs.statSync(output).isDirectory()) {
      return path.join(output, fileName);
    }
  } catch {
    // Fall through and treat output as a file path.
  }
  return output;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function safeBasename(value) {
  const name = path.basename(decodeURIComponent(String(value || '')));
  return name || 'ima-document';
}

function safeFileName(value) {
  const name = String(value || 'ima-document')
    .replace(/[\u0000-\u001f:/\\]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return name || 'ima-document';
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

export const __test__ = {
  cleanPreviewUrl,
  parsePreviewUrl,
  safeFileName,
  reserveOutputPath,
};
