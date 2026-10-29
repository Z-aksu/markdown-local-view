#!/usr/bin/env node

const { program } = require('commander');
const path = require('path');
const { startServer } = require('../src/server');
const packageJson = require('../package.json');

program
  .name('doc-server')
  .description('A simple CLI to serve and view markdown files as a tree')
  .version(packageJson.version)
  .option('-p, --port <number>', 'port to run the server on', 3590)
  .option('-H, --host <address>', 'address to bind the server to (use 0.0.0.0 for LAN access)', '0.0.0.0')
  .option('-d, --dir <path>', 'directory to serve', process.cwd())
  .action((options) => {
    const targetDir = path.resolve(options.dir);
    startServer(options.port, targetDir, options.host);
  });

program.parse();
