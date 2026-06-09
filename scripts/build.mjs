import { build } from 'esbuild';

const entryPoints = [
  'ask.ts',
  'kb.ts',
  'setup.ts',
  'status.ts',
  'dump.ts',
  'ls.ts',
  'export.ts',
];

await build({
  entryPoints,
  outdir: '.',
  outbase: '.',
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'info',
});
