'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { parseUsageSummary, parseUserInfo, probe } = require('../../src/shared/cursorProbe');

test('parseUsageSummary maps cents to USD and reads billing cycle end', () => {
  const input = {
    billingCycleStart: '2026-05-01T00:00:00Z',
    billingCycleEnd: '2026-06-01T00:00:00Z',
    membershipType: 'pro',
    individualUsage: {
      plan: { used: 1234, limit: 2000, autoPercentUsed: 30, apiPercentUsed: 70, totalPercentUsed: 50 },
      onDemand: { used: 500, limit: 5000 }
    }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planUsedUsd, 12.34);
  assert.equal(result.planLimitUsd, 20.0);
  assert.equal(result.onDemandUsedUsd, 5.0);
  assert.equal(result.onDemandLimitUsd, 50.0);
  assert.equal(result.planPercent, 50);
  assert.equal(result.autoPercent, 30);
  assert.equal(result.apiPercent, 70);
  assert.equal(result.billingCycleEnd, '2026-06-01T00:00:00Z');
  assert.equal(result.membershipType, 'pro');
});

test('parseUsageSummary falls back to (used / limit) when totalPercentUsed missing', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { used: 500, limit: 2000 } }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planPercent, 25);
});

test('parseUsageSummary falls back to Auto/API average before dollars', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { used: 500, limit: 2000, autoPercentUsed: 10, apiPercentUsed: 50 } }
  };
  const result = parseUsageSummary(input);
  assert.equal(result.planPercent, 30);
});

test('parseUsageSummary reads legacy request-based usage', () => {
  const input = {
    billingCycleEnd: '2026-06-01T00:00:00Z',
    individualUsage: { plan: { totalPercentUsed: 12 } }
  };
  const requestUsage = { 'gpt-4': { numRequestsTotal: 7, maxRequestUsage: 10 } };
  const result = parseUsageSummary(input, { requestUsage });
  assert.equal(result.requestsUsed, 7);
  assert.equal(result.requestsLimit, 10);
});

test('parseUsageSummary uses enterprise overall when plan is absent', () => {
  const result = parseUsageSummary({
    membershipType: 'enterprise',
    limitType: 'team',
    individualUsage: {
      overall: { enabled: true, used: 7384, limit: 10000, remaining: 2616 }
    },
    teamUsage: {
      pooled: { enabled: true, used: 12725135, limit: 28122000, remaining: 15396865 }
    }
  });
  assert.equal(Math.round(result.planPercent * 100) / 100, 73.84);
  assert.equal(result.planUsedUsd, 73.84);
  assert.equal(result.planLimitUsd, 100);
  assert.equal(result.planRemainingUsd, 26.16);
  assert.equal(result.teamPooledUsedUsd, 127251.35);
  assert.equal(result.teamPooledLimitUsd, 281220);
});

test('parseUsageSummary falls back to enterprise pooled usage when individual data is absent', () => {
  const result = parseUsageSummary({
    membershipType: 'enterprise',
    limitType: 'team',
    teamUsage: {
      pooled: { enabled: true, used: 12725135, limit: 28122000, remaining: 15396865 }
    }
  });
  assert.equal(Math.round(result.planPercent * 100) / 100, 45.25);
  assert.equal(result.planUsedUsd, 127251.35);
  assert.equal(result.planLimitUsd, 281220);
});

test('parseUsageSummary tolerates missing fields', () => {
  const result = parseUsageSummary({});
  assert.equal(result.planPercent, 0);
  assert.equal(result.planUsedUsd, 0);
  assert.equal(result.billingCycleEnd, null);
  assert.equal(result.membershipType, null);
});

test('parseUserInfo picks email/name/sub', () => {
  const info = parseUserInfo({ email: 'a@b.com', name: 'Alice', sub: 'user_1', extra: 'ignored' });
  assert.deepEqual(info, { email: 'a@b.com', name: 'Alice', sub: 'user_1' });
});

test('probe returns unauthorized error for 401', async () => {
  const fakeHttps = {
    request(opts, cb) {
      const res = { statusCode: 401, on() {}, headers: {} };
      // emulate the response stream: end immediately
      setImmediate(() => { cb(res); res.on && res.on('data', () => {}); });
      return { on() {}, end() {}, write() {} };
    }
  };
  const result = await probe('tok', { httpsLib: fakeHttps });
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'unauthorized');
});

test('probe includes legacy request usage when auth returns a user id', async () => {
  const calls = [];
  const fakeHttps = {
    request(opts, cb) {
      calls.push(opts.path);
      let payload;
      if (opts.path === '/api/usage-summary') {
        payload = {
          billingCycleEnd: '2026-06-01T00:00:00Z',
          individualUsage: { plan: { totalPercentUsed: 11, autoPercentUsed: 5, apiPercentUsed: 20 } }
        };
      } else if (opts.path === '/api/auth/me') {
        payload = { email: 'a@b.com', name: 'Alice', sub: 'user_1' };
      } else if (opts.path === '/api/usage?user=user_1') {
        payload = { 'gpt-4': { numRequestsTotal: 4, maxRequestUsage: 8 } };
      } else {
        payload = {};
      }
      const res = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        cb(res);
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify(payload)));
          res.emit('end');
        });
      });
      return { on() {}, end() {}, write() {}, setTimeout() {} };
    }
  };

  const result = await probe('tok', { httpsLib: fakeHttps });
  assert.equal(result.ok, true);
  assert.equal(result.usage.requestsUsed, 4);
  assert.equal(result.usage.requestsLimit, 8);
  assert.deepEqual(calls.sort(), ['/api/auth/me', '/api/usage-summary', '/api/usage?user=user_1'].sort());
});

test('probe destroys in-flight HTTPS requests when the parent signal aborts', async () => {
  const controller = new AbortController();
  const requests = [];
  const fakeHttps = {
    request() {
      const req = new EventEmitter();
      req.end = () => {};
      req.setTimeout = () => {};
      req.destroy = () => { req.destroyed = true; };
      requests.push(req);
      return req;
    }
  };

  const pending = probe('tok', { httpsLib: fakeHttps, signal: controller.signal });
  controller.abort(new Error('stop cursor probe'));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'network');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.destroyed));
});
