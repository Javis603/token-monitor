'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function compileWindowsDock({ output, sources, target = 'winexe' }) {
  if (process.platform !== 'win32') throw new Error('The Windows Dock helper must be built on Windows.');
  const windows = process.env.WINDIR || 'C:\\Windows';
  const framework = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const metadata = path.join(windows, 'System32', 'WinMetadata');
  const gac = path.join(windows, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
  const assembly = (name) => {
    const base = path.join(gac, name);
    for (const version of fs.readdirSync(base)) {
      const file = path.join(base, version, `${name}.dll`);
      if (fs.existsSync(file)) return file;
    }
    throw new Error(`Windows .NET assembly missing: ${name}`);
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const references = [
    'System.Web.Extensions.dll', 'System.Numerics.dll',
    ...['Windows.UI', 'Windows.Graphics', 'Windows.Foundation'].map((name) => path.join(metadata, `${name}.winmd`)),
    path.join(framework, 'System.Runtime.WindowsRuntime.dll'),
    assembly('System.Runtime'), assembly('System.Numerics.Vectors')
  ];
  execFileSync(path.join(framework, 'csc.exe'), [
    '/nologo', `/target:${target}`, '/platform:x64', '/optimize+', `/out:${output}`,
    ...references.map((file) => `/r:${file}`),
    ...sources
  ], { stdio: 'inherit', windowsHide: true });
  return output;
}

function buildWindowsDock({ root = path.resolve(__dirname, '..') } = {}) {
  return compileWindowsDock({
    output: path.join(root, 'build', 'windows-dock', 'TokenMonitor.DockBackdrop.exe'),
    sources: ['NativeCurve.cs', 'DockBackdrop.cs'].map((file) => path.join(root, 'src', 'windows-dock', file))
  });
}

// electron-builder also invokes this for direct CLI builds; --prepackaged uses
// the helper already present in the unpacked application.
async function beforePack(context) {
  if (context.electronPlatformName === 'win32') buildWindowsDock({ root: context.packager.projectDir });
}

if (require.main === module) console.log(buildWindowsDock());
module.exports = { buildWindowsDock, compileWindowsDock, default: beforePack };
