'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  fitCreditsPerToken,
  passesGates,
  buildConversionProfiles
} = require('../../src/shared/credits/calibration');

function linearPairs(count, slope, intercept = 0) {
  return Array.from({ length: count }, (_, i) => ({
    tokens: 100_000 + i * 10_000,
    credits: slope * (100_000 + i * 10_000) + intercept
  }));
}

test('fitCreditsPerToken recovers an exact linear relationship', () => {
  const fit = fitCreditsPerToken(linearPairs(60, 0.0000009)); // 0.9 credits per Mtok
  assert.equal(fit.samples, 60);
  assert.ok(Math.abs(fit.slope - 0.0000009) < 1e-12);
  assert.equal(fit.r2, 1);
});

test('fitCreditsPerToken degrades R² with noise and refuses degenerate input', () => {
  const noisy = linearPairs(60, 0.000001).map((p, i) => ({ ...p, credits: p.credits + (i % 2 ? 0.4 : -0.4) }));
  const fit = fitCreditsPerToken(noisy);
  assert.ok(fit.r2 < 1 && fit.r2 >= 0);
  assert.equal(fitCreditsPerToken([]).slope, null);
  assert.equal(fitCreditsPerToken([{ tokens: 1, credits: 1 }]).slope, null);
  assert.equal(fitCreditsPerToken(Array.from({ length: 10 }, () => ({ tokens: 5, credits: 2 }))).slope, null);
});

test('buildConversionProfiles gates on samples and R² per model', () => {
  const sessions = [
    ...linearPairs(60, 0.0000012).map((p) => ({ model: 'hy4-preview', tokens: p.tokens, credits: p.credits })),
    ...linearPairs(10, 0.0000008).map((p) => ({ model: 'ds-v4.1-flash', tokens: p.tokens, credits: p.credits }))
  ];
  const { profiles, pending } = buildConversionProfiles(sessions);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].model, 'hy4-preview');
  assert.equal(profiles[0].source, 'regression');
  assert.equal(profiles[0].creditsPerMTok, 1.2);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].model, 'ds-v4.1-flash');
  assert.equal(pending[0].reason, 'insufficient_samples');
});

test('the sample gate is reachable for a single user (12 sessions)', () => {
  const enough = linearPairs(12, 0.000001).map((p) => ({ model: 'm', tokens: p.tokens, credits: p.credits }));
  const short = linearPairs(11, 0.000001).map((p) => ({ model: 'm', tokens: p.tokens, credits: p.credits }));
  assert.equal(buildConversionProfiles(enough).profiles.length, 1);
  const { profiles, pending } = buildConversionProfiles(short);
  assert.equal(profiles.length, 0);
  assert.equal(pending[0].reason, 'insufficient_samples');
});

test('billed tokens are the x-axis, not the context-window counter', () => {
  // Same credits, same shape, but the only token field present is `usedTokens`:
  // fitting on the context counter is what kept every model pending before.
  const contextOnly = linearPairs(20, 0.000001).map((p) => ({
    model: 'm',
    usedTokens: p.tokens,
    credits: p.credits
  }));
  const { profiles, pending, untrackedSessions } = buildConversionProfiles(contextOnly);
  assert.equal(profiles.length, 0);
  assert.equal(pending.length, 0);
  assert.equal(untrackedSessions, 20);
});

test('buildConversionProfiles drops sessions missing either track and maps unknown models', () => {
  const sessions = [
    ...linearPairs(55, 0.000001).map((p) => ({ model: null, tokens: p.tokens, credits: p.credits })),
    { model: 'x', tokens: 0, credits: 5 },
    { model: 'x', tokens: 5, credits: 0 },
    { model: 'x', tokens: null, credits: null }
  ];
  const { profiles, pending } = buildConversionProfiles(sessions);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].model, 'unknown');
  assert.equal(profiles[0].samples, 55);
  assert.equal(pending.length, 0);
});

test('gates are configurable and a noisy fit stays pending', () => {
  const noisy = linearPairs(60, 0.000001).map((p, i) => ({ ...p, credits: p.credits + (i % 3) * 0.8 }));
  const { profiles, pending } = buildConversionProfiles(
    noisy.map((p) => ({ model: 'm', tokens: p.tokens, credits: p.credits }))
  );
  if (profiles.length === 1) {
    assert.ok(profiles[0].r2 < 0.9, 'noisy fit that passed must have blocked r2 recorded');
  } else {
    assert.equal(pending[0].reason, 'below_r2_gate');
  }
  assert.equal(passesGates({ samples: 10, slope: 1, r2: 1 }, { minSamples: 10 }), true);
  assert.equal(passesGates({ samples: 10, slope: -1, r2: 1 }), false);
});
