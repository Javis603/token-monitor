'use strict';

const fs = require('node:fs');
const path = require('node:path');

// electron-builder uses this implementation for its own blockmaps. Keeping the
// same implementation avoids producing a subtly incompatible differential
// update after Authenticode changes the installer bytes.
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function basenameOf(urlOrPath) {
  return path.posix.basename(unquote(urlOrPath));
}

function renderArtifactName(template, version) {
  const rendered = template.replaceAll('${version}', version).replaceAll('${ext}', 'exe');
  if (
    rendered.includes('${') ||
    path.posix.basename(rendered) !== rendered ||
    path.win32.basename(rendered) !== rendered ||
    /[\r\n]/.test(rendered)
  ) {
    throw new Error(`Unsupported Windows artifactName template: ${template}`);
  }
  return rendered;
}

function expectedWindowsArtifacts(packageJsonPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const version = pkg.version;
  if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`Unsupported package version for signing: ${String(version)}`);
  }
  const installer = renderArtifactName(pkg.build?.nsis?.artifactName || '', version);
  const portable = renderArtifactName(pkg.build?.portable?.artifactName || '', version);
  if (!installer || !portable || installer === portable) {
    throw new Error('package.json must define distinct NSIS and portable Windows artifact names');
  }
  return { version, installer, portable };
}

function signingInputPaths(names) {
  return {
    installer: path.posix.join('installer', names.installer),
    portable: path.posix.join('portable', names.portable)
  };
}

function assertExactTopLevelWindowsArtifacts(distDir, names) {
  const expected = [names.installer, names.portable].sort();
  const actual = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name)
    .sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Top-level Windows artifacts must be exactly ${expected.join(', ')}; found ` +
        (actual.length ? actual.join(', ') : 'no executable files')
    );
  }
}

function prepareUnsignedWindowsArtifacts({ distDir, inputDir, packageJsonPath }) {
  const names = expectedWindowsArtifacts(packageJsonPath);
  const relativePaths = signingInputPaths(names);
  assertExactTopLevelWindowsArtifacts(distDir, names);

  fs.rmSync(inputDir, { recursive: true, force: true });
  for (const kind of ['installer', 'portable']) {
    const destination = path.join(inputDir, ...relativePaths[kind].split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(distDir, names[kind]), destination);
  }

  return { ...names, relativePaths };
}

// Authenticode changes the installer after electron-builder has already hashed
// it into latest.yml and generated its blockmap. Update both from the signed
// bytes. blockMapSize is not used by electron-updater's plain NSIS differential
// path, so remove the now-stale value instead of inventing one.
function patchLatestYamlForSignedFile(yamlText, { fileName, sha512, size }) {
  const lines = yamlText.split('\n');
  let listEntryStart = -1;
  let listEntryIndent = -1;
  let matched = false;
  let rootPathMatched = false;
  let rootShaPatched = false;

  for (let i = 0; i < lines.length; i++) {
    const listItemMatch = lines[i].match(/^(\s*)-\s*url:\s*(.+)$/);
    if (listItemMatch && basenameOf(listItemMatch[2]) === fileName) {
      if (listEntryStart >= 0) {
        throw new Error(`Updater metadata contains more than one files entry for ${fileName}`);
      }
      listEntryStart = i;
      listEntryIndent = listItemMatch[1].length;
      matched = true;
    }

    const pathMatch = lines[i].match(/^path:\s*(.+)$/);
    if (pathMatch && basenameOf(pathMatch[1]) === fileName) {
      matched = true;
      rootPathMatched = true;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^sha512:/.test(lines[j])) {
          lines[j] = lines[j].replace(/sha512:.*/, `sha512: ${sha512}`);
          rootShaPatched = true;
          break;
        }
        if (/^\S/.test(lines[j])) break;
      }
    }
  }

  if (listEntryStart < 0) {
    return {
      text: lines.join('\n'),
      matched,
      complete: matched && (!rootPathMatched || rootShaPatched)
    };
  }

  let end = listEntryStart + 1;
  while (end < lines.length) {
    const fieldMatch = lines[end].match(/^(\s*)\S/);
    if (!fieldMatch || fieldMatch[1].length <= listEntryIndent) break;
    end++;
  }

  const patchedFields = [];
  let listShaPatched = false;
  let listSizePatched = false;
  for (let i = listEntryStart + 1; i < end; i++) {
    if (/^\s*sha512:/.test(lines[i])) {
      patchedFields.push(lines[i].replace(/sha512:.*/, `sha512: ${sha512}`));
      listShaPatched = true;
    } else if (/^\s*size:/.test(lines[i])) {
      patchedFields.push(lines[i].replace(/size:.*/, `size: ${size}`));
      listSizePatched = true;
    } else if (/^\s*blockMapSize:/.test(lines[i])) {
      continue;
    } else {
      patchedFields.push(lines[i]);
    }
  }
  lines.splice(listEntryStart + 1, end - (listEntryStart + 1), ...patchedFields);

  return {
    text: lines.join('\n'),
    matched,
    complete: listShaPatched && listSizePatched && (!rootPathMatched || rootShaPatched)
  };
}

function listExeFiles(rootDir, relativeDir = '') {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.statSync(absoluteDir, { throwIfNoEntry: false })?.isDirectory()) return [];

  return fs.readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) return listExeFiles(rootDir, relativePath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.exe') ? [relativePath] : [];
  });
}

async function applySignedWindowsArtifacts({ distDir, signedDir, packageJsonPath }) {
  const names = expectedWindowsArtifacts(packageJsonPath);
  const relativePaths = signingInputPaths(names);
  const expectedExePaths = Object.values(relativePaths).sort();
  const actualExePaths = listExeFiles(signedDir).sort();

  if (JSON.stringify(actualExePaths) !== JSON.stringify(expectedExePaths)) {
    throw new Error(
      `Signed artifact must contain exactly ${expectedExePaths.join(', ')}; found ` +
        (actualExePaths.length ? actualExePaths.join(', ') : 'no executable files')
    );
  }
  assertExactTopLevelWindowsArtifacts(distDir, names);

  for (const kind of ['installer', 'portable']) {
    const source = path.join(signedDir, ...relativePaths[kind].split('/'));
    fs.copyFileSync(source, path.join(distDir, names[kind]));
  }

  const installerPath = path.join(distDir, names.installer);
  const blockmapPath = `${installerPath}.blockmap`;
  const { sha512, size } = await buildBlockMap(installerPath, 'gzip', blockmapPath);

  const ymlFiles = fs.readdirSync(distDir).filter((name) => /^latest(?:-[^.]+)?\.ya?ml$/.test(name));
  const patchedYmlFiles = [];
  for (const ymlFile of ymlFiles) {
    const ymlPath = path.join(distDir, ymlFile);
    const original = fs.readFileSync(ymlPath, 'utf8');
    const patched = patchLatestYamlForSignedFile(original, {
      fileName: names.installer,
      sha512,
      size
    });
    if (patched.matched) {
      if (!patched.complete) {
        throw new Error(`${ymlFile} has an incomplete updater entry for ${names.installer}`);
      }
      fs.writeFileSync(ymlPath, patched.text);
      patchedYmlFiles.push(ymlFile);
    }
  }

  if (patchedYmlFiles.length === 0) {
    throw new Error(
      `${names.installer} was signed but is not referenced by any updater metadata in ${distDir}; ` +
        'refusing to ship a build where the update feed still points at the unsigned hash'
    );
  }

  return { ...names, sha512, size, patchedYmlFiles };
}

if (require.main === module) {
  const [, , command, distDirArg, signingDirArg, packageJsonPathArg = 'package.json'] = process.argv;
  if (!['prepare', 'apply'].includes(command) || !distDirArg || !signingDirArg) {
    console.error(
      'Usage: node signpath-windows-artifacts.js <prepare|apply> <distDir> <signingDir> [packageJson]'
    );
    process.exitCode = 1;
  } else {
    const options = {
      distDir: path.resolve(distDirArg),
      packageJsonPath: path.resolve(packageJsonPathArg)
    };
    const operation =
      command === 'prepare'
        ? Promise.resolve(
            prepareUnsignedWindowsArtifacts({ ...options, inputDir: path.resolve(signingDirArg) })
          )
        : applySignedWindowsArtifacts({ ...options, signedDir: path.resolve(signingDirArg) });

    operation
      .then((result) => {
        if (command === 'prepare') {
          console.log(`version=${result.version}`);
          console.log(`installer=${result.installer}`);
          console.log(`portable=${result.portable}`);
        } else {
          console.log(
            `Applied signed ${result.installer} and ${result.portable}; updated ${result.patchedYmlFiles.join(', ')}`
          );
        }
      })
      .catch((error) => {
        console.error(error.message || String(error));
        process.exitCode = 1;
      });
  }
}

module.exports = {
  expectedWindowsArtifacts,
  signingInputPaths,
  assertExactTopLevelWindowsArtifacts,
  prepareUnsignedWindowsArtifacts,
  patchLatestYamlForSignedFile,
  listExeFiles,
  applySignedWindowsArtifacts
};
