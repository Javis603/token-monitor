'use strict';

const fs = require('node:fs');
const path = require('node:path');

function stripYamlQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function artifactNameFromReference(value) {
  const reference = stripYamlQuotes(value);
  let pathname = reference;
  try {
    pathname = new URL(reference, 'https://release.invalid/').pathname;
  } catch (_) {}
  try {
    pathname = decodeURIComponent(pathname);
  } catch (_) {}
  return path.posix.basename(pathname);
}

function referencedArtifactNames(contents) {
  const names = new Set();
  const referencePattern = /^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/gm;
  for (const match of contents.matchAll(referencePattern)) {
    const name = artifactNameFromReference(match[1]);
    if (name) names.add(name);
  }
  return [...names];
}

function verifyUpdaterArtifactNames(distDir) {
  const metadataFiles = fs.readdirSync(distDir)
    .filter((name) => /^latest(?:-[^.]+)?\.ya?ml$/.test(name))
    .sort();
  if (metadataFiles.length === 0) {
    throw new Error(`No updater metadata found in ${distDir}`);
  }

  const missing = [];
  for (const metadataFile of metadataFiles) {
    const contents = fs.readFileSync(path.join(distDir, metadataFile), 'utf8');
    const names = referencedArtifactNames(contents);
    if (names.length === 0) {
      throw new Error(`${metadataFile} does not reference any artifacts`);
    }
    for (const name of names) {
      if (!fs.existsSync(path.join(distDir, name))) {
        missing.push(`${metadataFile} -> ${name}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(`Updater metadata references missing artifacts:\n${missing.join('\n')}`);
  }
  return { metadataFiles };
}

if (require.main === module) {
  const distDir = path.resolve(process.argv[2] || 'dist');
  try {
    const result = verifyUpdaterArtifactNames(distDir);
    console.log(`Verified updater artifact names in ${result.metadataFiles.join(', ')}`);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  artifactNameFromReference,
  referencedArtifactNames,
  verifyUpdaterArtifactNames
};
