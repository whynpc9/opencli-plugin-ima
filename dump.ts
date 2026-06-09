import { cli, Strategy } from '@jackwener/opencli/registry';
import { dumpIma } from './lib/ax.js';

export const dumpCommand = cli({
  site: 'ima',
  name: 'dump',
  access: 'read',
  description: 'Dump the macOS Accessibility tree of ima.copilot for selector debugging',
  example: 'opencli ima dump --output /tmp/ima-a11y.json -f json',
  strategy: Strategy.LOCAL,
  browser: false,
  args: [
    { name: 'output', required: false, help: 'Output JSON file path (default: /tmp/ima-a11y.json)' },
  ],
  columns: ['Action', 'File'],
  func: async (kwargs) => {
    const file = dumpIma(kwargs.output || '/tmp/ima-a11y.json');
    return [{ Action: 'Dumped', File: file }];
  },
});
