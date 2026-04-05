#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const builderConfig = path.join(rootDir, 'desktop', 'builder.json');
const freshOutputRootDir = path.join(rootDir, '.build-fresh');
const finalOutputDir = path.join(rootDir, '.build');

function toPosixRelative(targetPath) {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
}

function getNewestExe(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const exeFiles = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => {
      const fullPath = path.join(directoryPath, entry.name);
      return {
        fullPath,
        stat: fs.statSync(fullPath),
      };
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return exeFiles.length > 0 ? exeFiles[0].fullPath : null;
}

function main() {
  const buildStamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const freshOutputDir = path.join(freshOutputRootDir, `build-${buildStamp}`);
  fs.mkdirSync(freshOutputDir, { recursive: true });

  const npxCommand = 'npx';

  const builderArgs = [
    'electron-builder',
    '--win',
    '--x64',
    '--config',
    toPosixRelative(builderConfig),
    `--config.directories.output=${toPosixRelative(freshOutputDir)}`,
    '--publish',
    'never',
  ];

  console.log('Building desktop app using fresh output directory:', toPosixRelative(freshOutputDir));
  const buildResult = spawnSync(npxCommand, builderArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
  });

  if (buildResult.error) {
    console.error('Failed to start electron-builder:', buildResult.error.message);
    process.exit(1);
  }

  if (buildResult.status !== 0) {
    process.exit(buildResult.status || 1);
  }

  const freshExePath = getNewestExe(freshOutputDir);
  if (!freshExePath) {
    console.error('Build finished but no .exe was found in', toPosixRelative(freshOutputDir));
    process.exit(1);
  }

  fs.mkdirSync(finalOutputDir, { recursive: true });
  const finalExePath = path.join(finalOutputDir, path.basename(freshExePath));

  try {
    fs.copyFileSync(freshExePath, finalExePath);
    console.log('Copied latest executable to', toPosixRelative(finalExePath));
  } catch (error) {
    console.warn('Could not copy executable to .build (it may be locked by a running app).');
    console.warn('Latest build is still available at', toPosixRelative(freshExePath));
    console.warn(error.message);
  }

  console.log('Desktop build completed successfully.');
}

main();
