import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses loopback-safe defaults', () => {
    expect(loadConfig({ TOKEN_MONITOR_SECRET: 'test-secret' })).toMatchObject({
      hubUrl: 'http://127.0.0.1:17321',
      host: '127.0.0.1',
      port: 4174,
      secret: 'test-secret',
      trustOidcProxy: false
    });
  });

  it('requires a server-side secret', () => {
    expect(() => loadConfig({})).toThrow(/TOKEN_MONITOR_SECRET/);
    expect(() => loadConfig({ TOKEN_MONITOR_SECRET: '  ' })).toThrow(/TOKEN_MONITOR_SECRET/);
  });

  it('validates Hub URLs and gateway ports', () => {
    expect(() => loadConfig({ TOKEN_MONITOR_SECRET: 'x', HUB_URL: 'file:///tmp/hub' })).toThrow(/HUB_URL/);
    expect(() => loadConfig({ TOKEN_MONITOR_SECRET: 'x', GATEWAY_PORT: '0' })).toThrow(/GATEWAY_PORT/);
    expect(() => loadConfig({ TOKEN_MONITOR_SECRET: 'x', GATEWAY_PORT: '70000' })).toThrow(/GATEWAY_PORT/);
  });
});

it('requires explicit proxy mode and rejects remote binds in local mode',()=>{
  expect(()=>loadConfig({TOKEN_MONITOR_SECRET:'test',GATEWAY_HOST:'0.0.0.0'})).toThrow(/loopback/);
  expect(loadConfig({TOKEN_MONITOR_SECRET:'test',WEB_AUTH_MODE:'proxy'}).authMode).toBe('proxy');
  expect(()=>loadConfig({TOKEN_MONITOR_SECRET:'test',WEB_AUTH_MODE:'unknown'})).toThrow(/WEB_AUTH_MODE/);
  expect(loadConfig({TOKEN_MONITOR_SECRET:'test',WEB_AUTH_MODE:'proxy',GATEWAY_SESSION_SECRET:'test-signing-secret'})).toMatchObject({authMode:'proxy',trustOidcProxy:true});
});
