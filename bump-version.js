#!/usr/bin/env node
/**
 * Version bump script for Tab Mirror
 *
 * Updates the version in manifest.json, package.json, and all .md files
 * that reference the zip filename or version string.
 *
 * Usage: node bump-version.js <new-version>
 * Example: node bump-version.js 0.2.0
 */

const fs = require('fs');
const path = require('path');

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node bump-version.js <new-version>');
  console.error('Example: node bump-version.js 0.2.0');
  process.exit(1);
}

const ROOT = __dirname;

// Read current version from manifest.json
const manifestPath = path.join(ROOT, 'src/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const oldVersion = manifest.version;

if (oldVersion === newVersion) {
  console.log(`Already at version ${newVersion}, nothing to do.`);
  process.exit(0);
}

console.log(`Bumping version: ${oldVersion} -> ${newVersion}`);

// 1. Update manifest.json
manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`  Updated src/manifest.json`);

// 2. Update package.json
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  Updated package.json`);

// 3. Update .md files -- replace zip filenames and version references
const mdFiles = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.md'))
  .map(f => path.join(ROOT, f));

// Also check tests/README.md
const testsReadme = path.join(ROOT, 'tests/README.md');
if (fs.existsSync(testsReadme)) {
  mdFiles.push(testsReadme);
}

const zipPattern = new RegExp(`tab_mirror-${escapeRegex(oldVersion)}\\.zip`, 'g');
const zipReplacement = `tab_mirror-${newVersion}.zip`;

// Match version strings like "v0.1.0" or "Version 0.1.0"
const versionPattern = new RegExp(`(v|Version )${escapeRegex(oldVersion)}`, 'g');
const versionReplacer = (match, prefix) => `${prefix}${newVersion}`;

let mdCount = 0;
for (const file of mdFiles) {
  const content = fs.readFileSync(file, 'utf8');
  let updated = content
    .replace(zipPattern, zipReplacement)
    .replace(versionPattern, versionReplacer);

  if (updated !== content) {
    fs.writeFileSync(file, updated);
    console.log(`  Updated ${path.relative(ROOT, file)}`);
    mdCount++;
  }
}

console.log(`Done. Updated 2 JSON files and ${mdCount} markdown file(s).`);

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
