import { describe, expect, it } from 'vitest';
import viteConfig from './vite.config.js';

describe('Vite development proxy', () => {
  it('uses the local-only gateway without manufacturing proxy identity', () => {
    if (typeof viteConfig === 'function') throw new Error('expected static Vite config');
    const proxy = viteConfig.server?.proxy?.['/api'];
    expect(proxy).toMatchObject({
      target: 'http://127.0.0.1:4174',
      changeOrigin: true
    });
  });
});
