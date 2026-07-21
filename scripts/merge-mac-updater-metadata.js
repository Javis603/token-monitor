'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { artifactNameFromReference } = require('./verify-updater-artifact-names');

function stripYamlQuotes(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseMacUpdaterMetadata(contents, label = 'metadata') {
  const lines = String(contents || '').replace(/\r\n/g, '\n').split('\n');
  const versionLine = lines.find((line) => /^version:\s*\S/.test(line));
  if (!versionLine) throw new Error(`${label} has no top-level version`);

  const filesIndex = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (filesIndex < 0) throw new Error(`${label} has no top-level files list`);

  let filesEnd = filesIndex + 1;
  while (filesEnd < lines.length && (lines[filesEnd] === '' || /^\s/.test(lines[filesEnd]))) {
    filesEnd += 1;
  }
  const fileLines = lines.slice(filesIndex + 1, filesEnd);
  while (fileLines.length > 0 && fileLines[0] === '') fileLines.shift();
  while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();

  const fileNames = fileLines
    .filter((line) => /^\s*-\s*url:\s*\S/.test(line))
    .map((line) => artifactNameFromReference(line.replace(/^\s*-\s*url:\s*/, '')));
  if (fileNames.length === 0) throw new Error(`${label} has no updater file entries`);
  if (new Set(fileNames).size !== fileNames.length) {
    throw new Error(`${label} contains duplicate updater file entries`);
  }

  const pathLines = lines.filter((line) => /^path:\s*\S/.test(line));
  if (pathLines.length !== 1) {
    throw new Error(`${label} must have exactly one top-level path`);
  }
  const pathName = artifactNameFromReference(pathLines[0].replace(/^path:\s*/, ''));

  return {
    label,
    lines,
    version: stripYamlQuotes(versionLine.replace(/^version:\s*/, '')),
    filesIndex,
    filesEnd,
    fileLines,
    fileNames,
    pathName
  };
}

function assertArchitecture(metadata, arch) {
  const expected = `-${arch}.`;
  for (const fileName of metadata.fileNames) {
    if (!fileName.includes(expected)) {
      throw new Error(`${metadata.label} references ${fileName}, expected only ${arch} artifacts`);
    }
  }
  for (const extension of ['.zip', '.dmg']) {
    if (!metadata.fileNames.some((fileName) => fileName.endsWith(extension))) {
      throw new Error(`${metadata.label} has no ${arch} ${extension} artifact`);
    }
  }
  if (!metadata.pathName.includes(expected)) {
    throw new Error(`${metadata.label} path ${metadata.pathName} does not reference an ${arch} artifact`);
  }
  if (!metadata.pathName.endsWith('.zip')) {
    throw new Error(`${metadata.label} path ${metadata.pathName} is not a zip artifact`);
  }
  if (!metadata.fileNames.includes(metadata.pathName)) {
    throw new Error(`${metadata.label} path ${metadata.pathName} is not present in its files list`);
  }
}

function mergeMacUpdaterMetadata(arm64Contents, x64Contents) {
  const arm64 = parseMacUpdaterMetadata(arm64Contents, 'arm64 metadata');
  const x64 = parseMacUpdaterMetadata(x64Contents, 'x64 metadata');
  assertArchitecture(arm64, 'arm64');
  assertArchitecture(x64, 'x64');
  if (arm64.version !== x64.version) {
    throw new Error(`mac updater versions differ: arm64=${arm64.version}, x64=${x64.version}`);
  }

  const allNames = [...arm64.fileNames, ...x64.fileNames];
  if (new Set(allNames).size !== allNames.length) {
    throw new Error('mac updater metadata contains duplicate artifact names across architectures');
  }

  // Keep arm64 as the base so path/sha512 stay valid for existing Apple Silicon
  // installs. New Intel builds use the architecture-filtered files list.
  return [
    ...arm64.lines.slice(0, arm64.filesIndex + 1),
    ...arm64.fileLines,
    ...x64.fileLines,
    ...arm64.lines.slice(arm64.filesEnd)
  ].join('\n').replace(/\n*$/, '\n');
}

function mergeMacUpdaterMetadataFiles(outputPath, arm64Path, x64Path) {
  const merged = mergeMacUpdaterMetadata(
    fs.readFileSync(arm64Path, 'utf8'),
    fs.readFileSync(x64Path, 'utf8')
  );
  fs.writeFileSync(outputPath, merged);
  return outputPath;
}

if (require.main === module) {
  const [outputArg, arm64Arg, x64Arg] = process.argv.slice(2);
  if (!outputArg || !arm64Arg || !x64Arg) {
    console.error('Usage: node scripts/merge-mac-updater-metadata.js <output> <arm64-yml> <x64-yml>');
    process.exitCode = 1;
  } else {
    try {
      const outputPath = path.resolve(outputArg);
      mergeMacUpdaterMetadataFiles(outputPath, path.resolve(arm64Arg), path.resolve(x64Arg));
      console.log(`Merged mac updater metadata into ${outputPath}`);
    } catch (error) {
      console.error(error.message || String(error));
      process.exitCode = 1;
    }
  }
}

module.exports = {
  mergeMacUpdaterMetadata,
  mergeMacUpdaterMetadataFiles,
  parseMacUpdaterMetadata
};
