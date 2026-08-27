'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DOUBAO_DEFAULT_CDP_PORT,
  doubaoCdpPort,
  fetchDoubaoLimits,
  parseDoubaoOverview
} = require('../../src/shared/doubaoLimits');

function overviewBody() {
  return {
    code: 0,
    data: {
      current_subscription: {
        sku_key: 'doubao_personal_std',
        status: 3,
        end_time: 1790266818326,
        subscription_id: '7678002055634042915',
        display: { product_name: '豆包订阅', short_name: '标准套餐' }
      },
      member_info: { hasActiveSubscription: true },
      window_limit_section: {
        entitlement_count: 1,
        window_limit_groups: [
          {
            feature_group: 'general',
            window_limits: [
              { window_type: 1, total_amount: '735', used_amount: '9', used_percent: 1, start_time: 1787720622159, end_time: 1787738622159 },
              { window_type: 2, total_amount: '2,100', used_amount: '9', used_percent: 0, start_time: 1787720622159, end_time: 1788325422159 }
            ]
          }
        ]
      }
    }
  };
}

const DOUBAO_FRAME_TARGET = {
  type: 'iframe',
  url: 'https://www.doubao.com/drive-iframe/drive/home/',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/frame-1'
};

const DOUBAO_HOST_TARGET = {
  type: 'page',
  url: 'doubaowork://doubaowork-chat/chat',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/host-1'
};

function sessionFor(payload) {
  return {
    call: async (method, params = {}) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('subscription/overview')) {
        return { result: { value: JSON.stringify(payload) } };
      }
      return { result: { value: 'ok' } };
    },
    close: () => {}
  };
}

test('doubaoCdpPort prefers settings, supports env aliases, and rejects invalid values', () => {
  assert.equal(doubaoCdpPort({}, { doubaoCdpPort: '9444' }), 9444);
  assert.equal(doubaoCdpPort({ TOKEN_MONITOR_DOUBAO_CDP_PORT: '9555' }, {}), 9555);
  assert.equal(doubaoCdpPort({ DOUBAO_CDP_PORT: '9666' }, {}), 9666);
  assert.equal(doubaoCdpPort({}, { doubaoCdpPort: 'not-a-port' }), DOUBAO_DEFAULT_CDP_PORT);
  assert.equal(doubaoCdpPort({}, { doubaoCdpPort: '0' }), DOUBAO_DEFAULT_CDP_PORT);
  assert.equal(doubaoCdpPort({}, { doubaoCdpPort: 70000 }), DOUBAO_DEFAULT_CDP_PORT);
  assert.equal(doubaoCdpPort({}, {}), DOUBAO_DEFAULT_CDP_PORT);
});

test('parseDoubaoOverview turns both quota windows into credit windows', () => {
  const parsed = parseDoubaoOverview(overviewBody());
  assert.equal(parsed.windows.length, 2);

  const [session, weekly] = parsed.windows;
  assert.equal(session.kind, 'session');
  assert.equal(session.label, '5-hour');
  assert.equal(session.windowMinutes, 300);
  assert.equal(session.used, 9);
  assert.equal(session.limit, 735);
  assert.equal(session.remaining, 726);
  assert.equal(session.usedPercent, (9 / 735) * 100);
  assert.equal(session.resetsAt, new Date(1787738622159).toISOString());
  assert.equal(session.metric, 'credits');
  assert.equal(session.currency, 'CREDITS');

  assert.equal(weekly.kind, 'weekly');
  assert.equal(weekly.label, 'Weekly');
  assert.equal(weekly.limit, 2100);
  assert.equal(weekly.remaining, 2091);
  assert.equal(weekly.usedPercent, (9 / 2100) * 100);
  assert.equal(weekly.resetsAt, new Date(1788325422159).toISOString());

  assert.equal(parsed.planLabel, '标准套餐');
  assert.equal(parsed.planStatus, 'active');
  assert.equal(parsed.subscriptionEndsAt, new Date(1790266818326).toISOString());
});

test('parseDoubaoOverview fails closed without spendable amounts', () => {
  const percentOnly = overviewBody();
  percentOnly.data.window_limit_section.window_limit_groups[0].window_limits = [
    { window_type: 1, used_percent: 1 },
    { window_type: 2, used_percent: 0 }
  ];
  assert.throws(() => parseDoubaoOverview(percentOnly), /no window amounts/);

  const empty = overviewBody();
  empty.data.window_limit_section.window_limit_groups = [];
  assert.throws(() => parseDoubaoOverview(empty), /no window amounts/);
});

test('parseDoubaoOverview rejects error payloads and non-objects', () => {
  assert.throws(() => parseDoubaoOverview({ code: 710010202, msg: '系统错误' }), /code 710010202/);
  assert.throws(() => parseDoubaoOverview(null), /not an object/);
  assert.throws(() => parseDoubaoOverview({ code: 0 }), /no data payload/);
});

test('fetchDoubaoLimits reports notConfigured when the app debug endpoint is unreachable', async () => {
  const result = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => {
      throw new Error('ECONNREFUSED');
    },
    doubaoCdpConnect: async () => {
      throw new Error('should not connect');
    }
  });
  assert.equal(result.provider, 'doubao');
  assert.equal(result.status, 'notConfigured');
  assert.equal(result.source, 'local');
  assert.equal(result.sourceDetail, 'app');
  assert.deepEqual(result.windows, []);
});

test('fetchDoubaoLimits reads quotas from an existing doubao.com frame', async () => {
  let connections = 0;
  const result = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => [DOUBAO_HOST_TARGET, DOUBAO_FRAME_TARGET],
    doubaoCdpConnect: async () => {
      connections += 1;
      return sessionFor({ httpStatus: 200, body: overviewBody() });
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(connections, 1);
  assert.equal(result.planLabel, '标准套餐');
  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[0].kind, 'session');
  assert.equal(result.windows[0].limit, 735);
  assert.equal(result.windows[1].kind, 'weekly');
  assert.equal(result.windows[1].limit, 2100);
  assert.equal(result.balance.amount, 726);
  assert.equal(result.balance.planStatus, 'active');
  assert.ok(result.accountKey.startsWith('sha256:'));
});

test('fetchDoubaoLimits attaches a hidden frame when no doubao.com target is open', async () => {
  const injectedExpressions = [];
  let listCalls = 0;
  const result = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => {
      listCalls += 1;
      return listCalls === 1 ? [DOUBAO_HOST_TARGET] : [DOUBAO_HOST_TARGET, DOUBAO_FRAME_TARGET];
    },
    doubaoCdpConnect: async () => ({
      call: async (method, params = {}) => {
        if (method === 'Runtime.evaluate' && params.expression.includes('subscription/overview')) {
          return { result: { value: JSON.stringify({ httpStatus: 200, body: overviewBody() }) } };
        }
        if (method === 'Runtime.evaluate') injectedExpressions.push(params.expression);
        return { result: { value: 'created' } };
      },
      close: () => {}
    }),
    doubaoCdpTargetPollMs: 1,
    doubaoCdpTargetWaitMs: 250
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.windows.length, 2);
  assert.equal(injectedExpressions.length, 1);
  assert.match(injectedExpressions[0], /token-monitor-doubao-probe/);
  assert.match(injectedExpressions[0], /drive-iframe/);
});

test('fetchDoubaoLimits surfaces auth and transport failures without windows', async () => {
  const unauthorized = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => [DOUBAO_FRAME_TARGET],
    doubaoCdpConnect: async () => sessionFor({ httpStatus: 401, body: null })
  });
  assert.equal(unauthorized.status, 'unauthorized');
  assert.deepEqual(unauthorized.windows, []);

  const failedFetch = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => [DOUBAO_FRAME_TARGET],
    doubaoCdpConnect: async () => sessionFor({ __fetchError: 'NetworkError' })
  });
  assert.equal(failedFetch.status, 'unavailable');
  assert.deepEqual(failedFetch.windows, []);

  const appError = await fetchDoubaoLimits({}, {
    doubaoCdpListTargets: async () => [DOUBAO_FRAME_TARGET],
    doubaoCdpConnect: async () => sessionFor({ httpStatus: 200, body: { code: 710010202 } })
  });
  assert.equal(appError.status, 'error');
  assert.deepEqual(appError.windows, []);
});
