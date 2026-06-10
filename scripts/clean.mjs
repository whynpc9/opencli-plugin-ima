import * as fs from 'node:fs';

for (const file of ['ask.js', 'kb.js', 'kb-info.js', 'setup.js', 'status.js', 'dump.js', 'ls.js', 'export.js']) {
  try {
    fs.rmSync(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
