#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '..', 'node_modules', '@solid', 'community-server', 'dist');
const nestedDir = path.join(sourceDir, 'dist');

if (!fs.existsSync(sourceDir)) {
  process.exit(0);
}

if (!fs.existsSync(nestedDir)) {
  try {
    fs.symlinkSync(sourceDir, nestedDir, 'junction');
  } catch (error) {
    if (error.code === 'EEXIST') {
      // Already created by another run.
      return;
    }
    // Fall back to copying the folder if symlinks are not permitted.
    fs.cpSync(sourceDir, nestedDir, { recursive: true });
  }
}
