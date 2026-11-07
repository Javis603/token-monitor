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
  const helper = compileWindowsDock({
    output: path.join(root, 'build', 'windows-dock', 'TokenMonitor.DockBackdrop.exe'),
    sources: ['NativeCurve.cs', 'DockBackdrop.cs'].map((file) => path.join(root, 'src', 'windows-dock', file))
  });
  buildWindowsInput({ root });
  return helper;
}

function msvcEnvironment() {
  if (process.env.VSCMD_VER && process.env.VSCMD_ARG_TGT_ARCH === 'x64') return process.env;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) throw new Error('Windows input DLL requires Visual Studio C++ Build Tools, or CC set to a MinGW-w64 C compiler.');
  const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!installation) throw new Error('Visual Studio C++ Build Tools are not installed; install Desktop development with C++, or set CC to a MinGW-w64 C compiler.');
  const vcvars = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', `call "${vcvars}" >nul && set`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  const env = {};
  for (const line of output.split(/\r?\n/)) {
    const equals = line.indexOf('=');
    if (equals > 0) env[line.slice(0, equals)] = line.slice(equals + 1);
  }
  return env;
}

function buildWindowsInput({ root = path.resolve(__dirname, '..'), output = path.join(root, 'build/windows-dock/TokenMonitor.WindowInput.dll'), compiler = process.env.CC } = {}) {
  if (process.platform !== 'win32') throw new Error('The Windows input DLL must be built on Windows.');
  const source = path.join(root, 'src/windows-dock/WindowInput.c');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (compiler) {
    execFileSync(compiler, ['-shared', '-O2', '-Wall', '-Wextra', '-Werror', '-o', output, source, '-lcomctl32', '-luser32'], { stdio: 'inherit', windowsHide: true });
  } else {
    execFileSync('cl.exe', ['/nologo', '/LD', '/O2', '/W4', '/WX', `/Fo${path.join(path.dirname(output), 'WindowInput.obj')}`, source, '/link', `/OUT:${output}`, 'comctl32.lib', 'user32.lib'], { env: msvcEnvironment(), stdio: 'inherit', windowsHide: true });
  }
  return output;
}

// electron-builder also invokes this for direct CLI builds; --prepackaged uses
// the helper already present in the unpacked application.
async function beforePack(context) {
  if (context.electronPlatformName === 'win32') buildWindowsDock({ root: context.packager.projectDir });
}

if (require.main === module) console.log(buildWindowsDock());
module.exports = { buildWindowsDock, buildWindowsInput, compileWindowsDock, default: beforePack };
