'use strict';

// Credits↔tokens regression calibration (design spec §3.4/§7). WorkBuddy's
// local DB carries the credit track (`credit_json` per request) and the session
// transcripts carry the billed-token track, so an ordinary least-squares fit per
// model yields the actual conversion coefficient without trusting any published
// pricing. Gates (default 12 sessions and R² ≥ 0.9) keep an under-sampled or
// noisy fit out of the conversion profiles; those show up as `pending` instead.
//
// The x-axis must be billed tokens, never `session_usage.used`: `used` is the
// context-window fill. Measured against this machine's data, fitting on `used`
// drops balanced-model to R² 0.675 while the transcript axis reaches 0.979 —
// i.e. the wrong axis alone is enough to fail the R² gate forever.
//
// 12 rather than 50: a single user's ledger grows by a few sessions per model
// per month (16 at the time of writing), so a 50-sample gate is unreachable in
// practice and the conversion page would stay empty forever.

const MIN_SAMPLES = 12;
const MIN_R2 = 0.9;
const CREDITS_PER_MTOK_SCALE = 1e6;

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Ordinary least squares of credits on tokens for one model's sessions.
function fitCreditsPerToken(pairs) {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const { tokens, credits } of pairs) {
    n += 1;
    sumX += tokens;
    sumY += credits;
    sumXX += tokens * tokens;
    sumXY += tokens * credits;
  }
  if (n < 2) return { samples: n, slope: null, intercept: null, r2: null };
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { samples: n, slope: null, intercept: null, r2: null };
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (const { tokens, credits } of pairs) {
    ssTot += (credits - meanY) * (credits - meanY);
    const residual = credits - (slope * tokens + intercept);
    ssRes += residual * residual;
  }
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : 1 - ssRes / ssTot;
  return { samples: n, slope, intercept, r2: Math.round(r2 * 1e6) / 1e6 };
}

function passesGates(fit, { minSamples = MIN_SAMPLES, minR2 = MIN_R2 } = {}) {
  return fit.samples >= minSamples
    && Number.isFinite(fit.slope) && fit.slope > 0
    && Number.isFinite(fit.r2) && fit.r2 >= minR2;
}

// sessions come from collectCredits(): { sessionId, model, tokens, credits }.
// A session joins the fit only when both tracks are positive — a zero or null on
// either side is missing data, not a free request.
function buildConversionProfiles(sessions, { tool = 'workbuddy', gates } = {}) {
  const byModel = new Map();
  let untracked = 0;
  for (const session of sessions || []) {
    const tokens = finitePositive(session?.tokens);
    const credits = finitePositive(session?.credits);
    if (tokens === null || credits === null) {
      if (finitePositive(session?.credits) !== null) untracked += 1;
      continue;
    }
    const model = String(session?.model || 'unknown');
    if (!byModel.has(model)) byModel.set(model, []);
    byModel.get(model).push({ tokens, credits });
  }
  const profiles = [];
  const pending = [];
  for (const [model, pairs] of byModel) {
    const fit = fitCreditsPerToken(pairs);
    if (passesGates(fit, gates || {})) {
      profiles.push({
        tool,
        model,
        unit: 'credits-per-mtok',
        creditsPerMTok: Math.round(fit.slope * CREDITS_PER_MTOK_SCALE * 1e4) / 1e4,
        intercept: Math.round(fit.intercept * 1e4) / 1e4,
        samples: fit.samples,
        r2: fit.r2,
        source: 'regression'
      });
    } else {
      pending.push({
        tool,
        model,
        samples: fit.samples,
        slope: Number.isFinite(fit.slope) ? Math.round(fit.slope * 1e6) : null,
        r2: fit.r2,
        reason: fit.samples < (gates?.minSamples ?? MIN_SAMPLES) ? 'insufficient_samples' : 'below_r2_gate'
      });
    }
  }
  profiles.sort((a, b) => b.samples - a.samples);
  pending.sort((a, b) => b.samples - a.samples);
  return { profiles, pending, untrackedSessions: untracked };
}

module.exports = {
  MIN_SAMPLES,
  MIN_R2,
  fitCreditsPerToken,
  passesGates,
  buildConversionProfiles
};
