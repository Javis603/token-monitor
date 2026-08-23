'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// ipcMain.handle 对同一 channel 注册两次会在运行时抛错，并中断同一注册
// 函数里后续所有 handler 的注册（renderer 随即收到成片的 "No handler
// registered"）。静态源码断言与真实 Electron 启动之间隔着这一层，所以
// 用本测试补上：显式注册的字面量与共用工厂（registerManagedAccountIpc）
// 展开出的 channel 合并后必须无重复。
const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function explicitChannels(source) {
  return [...source.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]);
}

function factoryChannels(source) {
  const channels = [];
  for (const match of source.matchAll(/registerManagedAccountIpc\(ipcMain,\s*'([^']+)'/g)) {
    for (const suffix of ['accounts', 'setAccountEnabled', 'removeAccount']) {
      channels.push(`${match[1]}:${suffix}`);
    }
  }
  return channels;
}

test('main-process IPC channels are registered exactly once', () => {
  const all = [...explicitChannels(mainSource), ...factoryChannels(mainSource)];
  assert.ok(all.length > 20, 'expected a realistic number of channels');
  const duplicates = all.filter((channel, index) => all.indexOf(channel) !== index);
  assert.deepEqual(duplicates, [], 'duplicate ipcMain.handle channels would throw at startup');
});

test('every managed-account factory channel the preload exposes is registered', () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'preload.js'), 'utf8');
  const registered = new Set([...explicitChannels(mainSource), ...factoryChannels(mainSource)]);
  for (const prefix of ['mimo', 'minimax']) {
    for (const suffix of ['accounts', 'setAccountEnabled', 'removeAccount']) {
      assert.ok(registered.has(`${prefix}:${suffix}`), `${prefix}:${suffix} must be registered`);
    }
  }
  // preload 里 invoke 的每个 channel 必须有对应 handler（只覆盖托管账号
  // 相关的通道，避免全量清单随功能演进而漂移）。
  for (const match of preloadSource.matchAll(/ipcRenderer\.invoke\('(mimo:[^']+|minimax:[^']+)'/g)) {
    assert.ok(registered.has(match[1]), `preload invokes ${match[1]} but no handler registers it`);
  }
});
