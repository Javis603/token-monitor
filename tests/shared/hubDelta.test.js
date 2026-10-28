'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { statsPatch, applyStatsPatch } = require('../../src/shared/hubDelta');
const { createStatsStreamReceiver, encodeSseEvent, prepareSseFanout, sseFrameForClient, sseClientKinds, wantsDeltaEvents, wantsFreshnessEvents } = require('../../src/shared/hubProtocol');
const wire = value => JSON.parse(JSON.stringify(value));
function stats(n = 1) {
  return { periods: { today: { totalTokens: n, sessions: { 'a/~:1': { totalTokens: n, liveActivity: {state: 'running', observedAt: `2026-10-28T10:00:0${n}.000Z`} } } } },
    devices: [{ deviceId: 'one', note: 'unchanged '.repeat(1000), periods: {today: {totalTokens: n}} }], historyRevision: 'one' };
}

test('JSON Patch round-trips additions, removals, null, zero, escaped keys and array structure', () => {
  const cases = [
    [{a: 1, b: null}, {a: null, c: 0}],
    [{a: {b:1}, stable: {}}, {a: {}, stable: {}}],
    [{a:[{b:1},2]}, {a:[{b:2},null]}],
    [{a:[1,2]}, {a:[]}],
    [{a:{}}, {a:[1]}],
    [{a:undefined, list:[undefined]}, {list:[null], b:{c:undefined}}],
    [{'/~':1}, {'/~':0}],
    [JSON.parse('{"__proto__":{"polluted":false},"constructor":0}'), JSON.parse('{"__proto__":{"polluted":true},"constructor":1}')]
  ];
  for (const [before, after] of cases) {
    const original = wire(before);
    const patch = wire(statsPatch(before, after));
    assert.deepEqual(applyStatsPatch(wire(before), patch), wire(after));
    assert.deepEqual(wire(before), original);
  }
  assert.equal({}.polluted, undefined);
});

test('patch application copies only edited branches and handles many edits to the same map', () => {
  const before = stats();const after = stats(2);
  const result = applyStatsPatch(before, wire(statsPatch(before, after)));
  assert.deepEqual(result, after);
  assert.notEqual(result.periods, before.periods);
  assert.equal(result.periods.today.sessions['a/~:1'].liveActivity.state, 'running');
  assert.equal(before.periods.today.totalTokens, 1);
  assert.equal(result.historyRevision, before.historyRevision);
});

test('invalid patches fail without mutating the baseline or traversing inherited properties', () => {
  const before = stats();const original=wire(before);
  for (const entry of [
    {op:'move',path:'/devices',value:[]},
    {op:'replace',path:'/missing',value:1},
    {op:'add',path:'/constructor/prototype/polluted',value:true},
    {op:'remove',path:'/periods/toString'},
    {op:'add',path:'/devices/01',value:{}},
    {op:'replace',path:'/devices/-',value:{}},
    {op:'add',path:'/devices/100',value:{}},
    {op:'replace',path:'/periods/~2',value:1},
    {op:'replace',path:'/devices'},
    {op:'remove',path:''}
  ]) {
    assert.throws(()=>applyStatsPatch(before,[{op:'replace',path:'/historyRevision',value:'two'},entry]));
    assert.deepEqual(before,original);
  }
  assert.equal({}.polluted,undefined);
});

test('connection receiver rejects missing/duplicate/reordered deltas and resets on a full snapshot', () => {
  const r=createStatsStreamReceiver();
  const delta={baseRevision:1,revision:2,patch:statsPatch(stats(),stats(2))};
  assert.throws(()=>r.receive('delta',wire(delta)),/revision/);
  r.receive('snapshot',{stats:stats(),revision:1});
  assert.throws(()=>r.receive('delta',{...delta,baseRevision:0}),/revision/);
  assert.deepEqual(r.receive('delta',wire(delta)),stats(2));
  assert.throws(()=>r.receive('delta',wire(delta)),/revision/);
  r.receive('stats',{stats:stats(3),revision:7});
  assert.deepEqual(r.receive('delta',{baseRevision:7,revision:8,patch:[]}),stats(3));
  r.receive('snapshot',{stats:stats()});
  assert.throws(()=>r.receive('delta',wire(delta)),/revision/);
});

test('mixed v4/v3/legacy fan-out uses one revision chain and a full fallback for late or skipped clients', () => {
  const before=stats(); const after=stats(2);
  const client={deltaEvents:true,freshnessEvents:true,streamRevision:1};
  const frames=prepareSseFanout({stats:after,previousStats:before,revision:2,...sseClientKinds([client,{freshnessEvents:true},{}])});
  assert.match(sseFrameForClient(frames,client),/^event: delta/);
  assert.match(sseFrameForClient(frames,{...client,streamRevision:null}),/^event: stats/);
  assert.match(sseFrameForClient(frames,{freshnessEvents:true}),/^event: stats/);
  const r=createStatsStreamReceiver();r.receive('snapshot',{stats:before,revision:1});
  assert.deepEqual(r.receive('delta',JSON.parse(frames.delta.split('data: ')[1])),after);
  const forced=prepareSseFanout({stats:after,previousStats:before,revision:2,hasDeltaClients:true,allowFreshness:false});
  assert.equal(forced.delta,undefined);
  assert.match(sseFrameForClient(forced,client),/^event: stats/);
  assert.equal(wantsDeltaEvents({'x-token-monitor-stream':'4'}),true);
  assert.equal(wantsDeltaEvents({'x-token-monitor-stream':'3'}),false);
  assert.equal(wantsFreshnessEvents({'x-token-monitor-stream':'3'}),true);
});

test('large delta falls back to a full frame and a subsequent small delta resumes', () => {
  const frames=prepareSseFanout({stats:{n:2},previousStats:{n:1},revision:2,hasDeltaClients:true});
  assert.equal(frames.delta,undefined);
  assert.match(sseFrameForClient(frames,{deltaEvents:true,streamRevision:1}),/^event: stats/);
});

test('fan-out skips UTF-8 encoding when string-length bounds decide the smaller frame', t => {
  const encode = TextEncoder.prototype.encode;
  const spy = t.mock.method(TextEncoder.prototype, 'encode', function (value) {
    return encode.call(this, value);
  });
  const smaller = prepareSseFanout({
    stats: { n: 2, stable: 'x'.repeat(10000) },
    previousStats: { n: 1, stable: 'x'.repeat(10000) },
    revision: 2, hasDeltaClients: true
  });
  assert.match(smaller.delta, /^event: delta/);
  assert.ok(smaller.delta.length * 3 < smaller.stats.length);
  const larger = prepareSseFanout({
    stats: { n: 2 },
    previousStats: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`key${i}`, i])),
    revision: 2, hasDeltaClients: true
  });
  assert.equal(larger.delta, undefined);
  assert.equal(spy.mock.callCount(), 0);
  const overlapping = prepareSseFanout({
    stats: { n: 2 }, previousStats: { n: 1 }, revision: 2, hasDeltaClients: true
  });
  assert.equal(overlapping.delta, undefined);
  assert.equal(spy.mock.callCount(), 2);
});

test('fan-out keeps exact UTF-8 frame selection across Unicode and equal byte lengths', () => {
  const check = (previousStats, stats) => {
    const input = { reason: 'ingest', at: '2026-10-28T10:00:00.000Z', revision: 2 };
    const delta = encodeSseEvent('delta', {
      type: 'delta', reason: input.reason, baseRevision: 1, revision: 2,
      patch: statsPatch(previousStats, stats), at: input.at
    });
    const frames = prepareSseFanout({ ...input, previousStats, stats, hasDeltaClients: true });
    assert.equal(frames.delta, Buffer.byteLength(delta) < Buffer.byteLength(frames.stats) ? delta : undefined);
    return Buffer.byteLength(delta) - Buffer.byteLength(frames.stats);
  };
  for (const text of ['x', '中', '😀', '\ud800', '\udc00', 'a中😀\ud800']) {
    for (const stableLength of [0, 16, 64, 128, 512]) {
      for (const changedLength of [1, 16, 128]) {
        const stable = text.repeat(stableLength);
        check({ stable, value: '' }, { stable, value: text.repeat(changedLength) });
      }
    }
  }
  const padding = check({ stable: '', n: 1 }, { stable: '', n: 2 });
  assert.ok(padding > 0);
  for (const offset of [-1, 0, 1]) {
    const stable = 'x'.repeat(padding + offset);
    assert.equal(check({ stable, n: 1 }, { stable, n: 2 }), offset === 0 ? 0 : -offset);
  }
});

test('seeded stream replay preserves full snapshot equivalence over membership, reorder and deletion', () => {
  let seed=123;const rand=()=>{seed=(seed*16807)%2147483647;return seed;};
  const receiver=createStatsStreamReceiver(); let before=stats();receiver.receive('snapshot',{stats:wire(before),revision:0});
  for(let i=1;i<=200;i++){
    const after=wire(before);const key=`s${rand()%12}`;const sessions=after.periods.today.sessions;
    if(rand()%3===0)delete sessions[key];else sessions[key]={totalTokens:rand()%100,extra:rand()%2?null:{state:'waiting'}};
    if(i%9===0)after.devices.reverse();
    if(i%13===0)after.devices.push({deviceId:`d${i}`,periods:{}});
    if(i%17===0)after.devices.splice(0,1);
    assert.deepEqual(receiver.receive('delta',wire({baseRevision:i-1,revision:i,patch:statsPatch(before,after)})),after);
    before=after;
  }
});
