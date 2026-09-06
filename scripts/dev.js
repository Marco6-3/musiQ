'use strict';
// Preserve Electron development; supervised visual QA forwards --host/--port.
if (process.argv.includes('--host')) {
  import('./preview-ui.mjs').catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { spawn } = require('node:child_process');
  const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('exit', code => { process.exitCode = code || 0; });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
}
