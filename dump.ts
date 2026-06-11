import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dumpIma } from './lib/ax.js';
import { getImaRuntimeConfig } from './lib/platform.js';
import { inspectImaWebContentsTargets } from './lib/webcontents.js';

export const dumpCommand = cli({
  site: 'ima',
  name: 'dump',
  access: 'read',
  description: 'Dump ima.copilot diagnostics for selector or WebContents debugging',
  example: 'opencli ima dump --output /tmp/ima-dump.json -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'output', required: false, help: 'Output JSON file path' },
  ],
  columns: ['Action', 'File'],
  func: async (kwargs) => {
    const runtime = getImaRuntimeConfig();
    const output = String(kwargs.output || '').trim() || defaultDumpPath(runtime);
    try {
      if (runtime.capabilities.uiTransport) {
        const file = dumpIma(output);
        return [{ Action: 'Dumped Accessibility', File: file }];
      }

      if (runtime.capabilities.webContentsLaunch) {
        const dump = await inspectImaWebContentsTargets();
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await fs.promises.writeFile(output, JSON.stringify(dump, null, 2), 'utf8');
        return [{ Action: 'Dumped WebContents', File: output }];
      }

      throw new Error(`ima dump is not implemented for ${runtime.label}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandExecutionError('ima/dump failed', message);
    }
  },
});

function defaultDumpPath(runtime) {
  if (runtime.os === 'windows') return path.join(os.tmpdir(), 'ima-webcontents.json');
  return '/tmp/ima-a11y.json';
}
