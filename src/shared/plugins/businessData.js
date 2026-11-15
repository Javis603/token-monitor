'use strict';

// Pure DTO boundary. Never spread host records into plugin-visible objects.
const { canonicalProjectKey } = require('../projectKey');
const { sessionWithActivity } = require('../sessionLive');
const subscriptionDisplay = require('../subscriptionDisplay');
const balanceDisplay = require('../limits/balanceDisplay');
const { LIMIT_PROVIDER_CATALOG } = require('../limits/providers');
const { limitWindowLabel } = require('../limits/windowLabels');
const LIMIT_TOOL_LABELS = new Map(LIMIT_PROVIDER_CATALOG.map(({ id, label, settingsLabel }) => [id, settingsLabel || label]));
const { CURRENCY_CODES } = require('../currency');
const VERSION = 1;
const RESOURCES = Object.freeze({ usage: 'usage', models: 'usage', tools: 'usage', devices: 'devices', sessions: 'sessions', projects: 'projects', history: 'history', limits: 'limits', subscriptions: 'subscriptions', status: 'status', liveRate: 'liveRate' });
const MAX_ROWS = 100000;
const text = value => typeof value === 'string' ? value.slice(0, 512) : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
function pick(value, strings = '', numbers = '', booleans = '') {
  const result = {};
  for (const key of strings.split(' ').filter(Boolean)) result[key] = text(value?.[key]);
  for (const key of numbers.split(' ').filter(Boolean)) result[key] = number(value?.[key]);
  for (const key of booleans.split(' ').filter(Boolean)) result[key] = typeof value?.[key] === 'boolean' ? value[key] : null;
  return result;
}
function failure(code) { const error = new Error(code); error.code = code; throw error; }
function entries(value) {
  const result = Object.entries(value || {});
  if (result.length > MAX_ROWS) failure('budgetExceeded');
  return result;
}
function usage(value, normalized = true) {
  const knownUsd = number(value?.costUsd ?? value?.cost ?? value?.totalCost);
  const unpricedTokens = number(value?.unpricedTokens) ?? (normalized && knownUsd !== null ? 0 : null);
  return { ...pick(value, '', 'inputTokens outputTokens cacheReadTokens cacheWriteTokens reasoningTokens unclassifiedTokens messageCount timedTokens timedOutputTokens timedDurationMs contextTokens contextWindow activeTimeMs', 'tokenComponentsAvailable'), capabilities: pick(value?.capabilities, '', '', 'tokenComponents throughput'), totalTokens: number(value?.totalTokens ?? value?.tokens), cost: { knownUsd, unpricedTokens, currency: 'USD', completeness: knownUsd === null || unpricedTokens === null ? 'unknown' : unpricedTokens > 0 ? 'partial' : 'complete' } };
}
// Relations retain the accounting identity, including cross-client links. Do
// not truncate an identity before hashing it or fabricate a parent row.
function sessionParent(session, key, scopeKey, id) {
  const valid = value => typeof value === 'string' && value.length > 0
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
  const parent = session.parentSessionId;
  const client = session.parentClient ?? session.client;
  if (!valid(parent) || !valid(client) || client.length > 512
    || (parent === (session.sessionId || key) && client === session.client)) return { parentId: null, parentClient: null };
  return { parentId: id('session', `${scopeKey}:${client}:${parent}`), parentClient: client };
}
const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && subscriptionDisplay.daysBetween(value, value) === 0;
const currencyCode = value => typeof value === 'string' && CURRENCY_CODES.includes(value) ? value : null;
function capturedCurrency(context) {
  const rate = code => currencyCode(code) && Object.hasOwn(context?.rates || {}, code)
    && number(context.rates[code]) > 0 ? context.rates[code] : null;
  // An injected, immutable view of the host's USD conversion contract. Never
  // invoke currency.convertUsd(), whose configured rates are process-global.
  return { rate, api: { normalizeCurrency: code => code,
    convertUsd: (value, code) => rate(code) === null ? NaN : Number((value * rate(code)).toFixed(6)) } };
}
function validSubscription(record) {
  const minor = value => Number.isSafeInteger(value) && value >= 0;
  if (!['subscription', 'topup'].includes(record.kind) || !minor(record.amountMinor)
    || !Array.isArray(record.topUps)) return false;
  // Shared top-up normalization generates IDs for malformed entries. Validate
  // normalized host input first so this pure boundary never reads Date.now().
  if (!record.topUps.every(t => typeof t?.id === 'string' && !!t.id.trim()
    && calendarDate(t.date) && minor(t.amountMinor))) return false;
  if (record.kind === 'topup') return record.topUps.length > 0;
  return calendarDate(record.startDate) && ['month', 'year'].includes(record.interval)
    && Number.isInteger(record.intervalCount) && record.intervalCount >= 1 && record.intervalCount <= 24
    && (record.endDate == null || calendarDate(record.endDate))
    && (record.nextRenewalOverride == null || calendarDate(record.nextRenewalOverride));
}
function subscriptionDerivation(record, context, forecast) {
  const date = calendarDate(context?.date) ? context.date : null;
  const valid = validSubscription(record);
  const result = { status: date && valid ? 'available' : 'unavailable',
    reason: !date ? 'missingContext' : !valid ? 'invalidRecord' : null,
    asOfDate: date, active: null, nextRenewalDate: null, coverageEndDate: null,
    daysUntilRenewal: null, paidToDateMinor: null, monthlyAmountUsd: null,
    monthlyAmountUsdReason: null, topUpTotalMinor: null, topUpMonthMinor: null, forecast };
  if (!date || !valid) { result.monthlyAmountUsdReason = result.reason; return result; }
  const api = subscriptionDisplay;
  result.active = api.activeSubscriptions([record], date).length > 0;
  result.nextRenewalDate = api.nextRenewalDate(record, date) || null;
  result.coverageEndDate = api.coverageEndDate(record, date) || null;
  result.daysUntilRenewal = number(api.daysUntilRenewal(record, date));
  result.paidToDateMinor = number(api.paidToDateMinor(record, date));
  result.topUpTotalMinor = number(api.topUpTotalMinor(record));
  result.topUpMonthMinor = number(api.topUpMonthMinor(record, date));
  const currency = capturedCurrency(context);
  if (!currencyCode(record.currency)) result.monthlyAmountUsdReason = 'unsupportedCurrency';
  else if (currency.rate(record.currency) === null) result.monthlyAmountUsdReason = 'missingRate';
  else {
    result.monthlyAmountUsd = number(api.monthlyAmountUsd(record, currency.api, date));
    if (result.monthlyAmountUsd === null) result.monthlyAmountUsdReason = 'invalidAmount';
  }
  return result;
}
function subscriptionForecast(record, context, stats, id, visit) {
  const result = { status: 'unavailable', reason: null, accountId: null,
    balanceUpdatedAt: null, currency: null, balanceAmount: null,
    dailyBurn: null, daysRemaining: null, exhaustDate: null };
  const finish = (status, reason) => ({ ...result, status, reason });
  if (record.kind !== 'topup') return finish('notApplicable', 'notTopUp');
  if (!calendarDate(context?.date)) return finish('unavailable', 'missingContext');
  if (!validSubscription(record)) return finish('unavailable', 'invalidRecord');
  const providers = stats?.limits?.providers;
  if (!Array.isArray(providers)) return finish('unavailable', 'missingLimits');
  // Charge both full matching passes to the projector's cumulative work bound.
  const candidates = visit(providers).map(([, provider]) => provider);
  // Matching builds identity sets from aliases on each pass, so repeated
  // subscription matches must also pay for this nested source traversal.
  for (const candidate of candidates) if (Array.isArray(candidate?.accountKeyAliases)) visit(candidate.accountKeyAliases);
  const account = subscriptionDisplay.matchProviderAccount(record, candidates);
  if (!account) return finish(subscriptionDisplay.needsRebinding(record, candidates) ? 'ambiguous' : 'unmatched', 'accountMatch');
  // The shared helper picks the first exact key/email match. A different answer
  // in reverse order proves that match is ambiguous; do not guess a balance.
  const reversed = visit(providers).map(([, provider]) => provider).reverse();
  if (subscriptionDisplay.matchProviderAccount(record, reversed) !== account) return finish('ambiguous', 'accountMatch');
  result.accountId = account.accountKey ? id('account', `${account.provider}:${account.accountKey}`) : null;
  result.balanceUpdatedAt = text(account.updatedAt);
  if (stats?.stale === true || stats?.limits?.stale === true || account.stale === true || account.status === 'stale') return finish('stale', 'markedStale');
  if (account.status !== 'ok') return finish('unavailable', 'providerStatus');
  const window = visit(account.windows).map(([, value]) => value).find(balanceDisplay.isCreditsWindow) || null;
  const amount = balanceDisplay.creditsAmount(account, window);
  if (amount === null) return finish('unavailable', 'missingBalance');
  // creditsCurrency has a USD fallback for absent/invalid currency. Guard the
  // actual source unit before using it: CREDITS is points, never USD.
  const rawCurrency = window?.currency || account.balance?.currency;
  const currency = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : null;
  if (!currencyCode(currency) || !currencyCode(record.currency)) return finish('unavailable', 'unsupportedCurrency');
  const captured = capturedCurrency(context);
  if (captured.rate(record.currency) === null || captured.rate(currency) === null) return finish('unavailable', 'missingRate');
  const code = balanceDisplay.creditsCurrency(account, window);
  const projection = subscriptionDisplay.topUpProjection(record, amount, context.date, { balanceCurrency: code, currencyApi: captured.api });
  if (!projection || number(projection.dailyBurn) === null
    || (projection.daysRemaining !== null && number(projection.daysRemaining) === null)
    || (projection.exhaustDate && !calendarDate(projection.exhaustDate))) return finish('unavailable', 'insufficientHistory');
  return { ...result, status: 'available', currency: code, balanceAmount: amount,
    dailyBurn: projection.dailyBurn, daysRemaining: projection.daysRemaining, exhaustDate: projection.exhaustDate || null };
}
function normalizeQuery(raw) {
  if (!raw || raw.version !== VERSION) failure('unsupportedVersion');
  if (!Object.hasOwn(RESOURCES, raw.resource)) failure('unsupportedResource');
  for (const key of Object.keys(raw)) if (!['version', 'resource', 'period', 'filter', 'sort', 'page', 'resolution', 'groupBy'].includes(key)) failure('invalidQuery');
  const period = raw.period ?? 'today';
  if (!['today', 'month', 'allTime'].includes(period)) failure('invalidPeriod');
  if (raw.resource === 'liveRate' && period !== 'today') failure('invalidPeriod');
  const filter = {};
  for (const [key, value] of Object.entries(raw.filter || {})) {
    if (!['id', 'deviceId', 'accountId', 'projectId', 'client', 'model', 'provider', 'from', 'to', 'search'].includes(key) || typeof value !== 'string' || value.length > 256) failure('invalidFilter');
    filter[key] = value;
  }
  const filters = {
    usage: ['id', 'deviceId'], models: ['id', 'deviceId', 'model', 'search'],
    tools: ['id', 'deviceId', 'client', 'model', 'search'],
    devices: ['id', 'deviceId', 'search'], sessions: ['id', 'deviceId', 'projectId', 'client', 'model', 'search'],
    projects: ['id', 'deviceId', 'client', 'model', 'search'],
    history: ['id', 'deviceId', 'from', 'to', 'client', 'model'],
    limits: ['id', 'deviceId', 'accountId', 'provider', 'search'],
    subscriptions: ['id', 'accountId', 'provider', 'search'], status: ['id', 'deviceId'], liveRate: ['id', 'deviceId']
  };
  if (Object.keys(filter).some(key => !filters[raw.resource].includes(key))) failure('invalidFilter');
  const sort = { field: raw.sort?.field ?? 'id', direction: raw.sort?.direction ?? 'asc' };
  if (!['id', 'totalTokens', 'knownUsd', 'updatedAt', 'lastUsedAt', 'date', 'label'].includes(sort.field) || !['asc', 'desc'].includes(sort.direction)) failure('invalidSort');
  const limit = raw.page?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (raw.page?.cursor != null && (typeof raw.page.cursor !== 'string' || raw.page.cursor.length > 256))) failure('invalidPage');
  const resolution = raw.resolution ?? 'daily';
  const groupBy = raw.groupBy ?? 'none';
  if (!['daily', 'monthly', 'summary'].includes(resolution) || !['none', 'model', 'client'].includes(groupBy) || (raw.resource !== 'history' && (resolution !== 'daily' || groupBy !== 'none'))) failure('invalidQuery');
  return { version: VERSION, resource: raw.resource, period, filter, sort, resolution, groupBy, page: { limit, cursor: raw.page?.cursor ?? null } };
}
// One source/coverage and allowlist authority for eager and lazy sessions.
function sessionSources(stats, extras, query, opaque) {
  const id = (kind, key) => opaque(kind, String(key));
  const restricted = !!query.filter.deviceId;
  const allowed = d => !query.filter.deviceId || query.filter.deviceId === id('device', d.deviceId);
  const lifetime = query.period === 'allTime';
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const candidates = lifetime && extras.allTime?.sessionSources
    ? extras.allTime.sessionSources : restricted ? devices : [{ ...stats, deviceId: null }];
  if (candidates.length > MAX_ROWS) failure('budgetExceeded');
  const sources = candidates.filter(allowed);
  let incomplete = false, detailed = 0, periods = 0;
  const contexts = sources.map(source => {
    let period = source.periods?.[query.period];
    if (!source.deviceId && !restricted && lifetime && extras.allTime) {
      const accounting = ['totalTokens', 'tokens', 'models', 'clients', 'sessions', 'projects'].some(key => Object.hasOwn(extras.allTime, key));
      period = period || accounting ? { ...period, ...extras.allTime } : undefined;
    }
    if (period) periods++;
    const detail = !!period && (!lifetime || (source.sessionDetailAvailable !== false && !!period.sessions));
    if (detail) detailed++;
    if (detail) incomplete ||= !!source.sessionDetailsOmitted?.[query.period];
    const sourceDeviceId = lifetime && !restricted ? null : source.deviceId;
    return { sessions: detail ? period.sessions : undefined, sessionActivity: detail ? period.sessionActivity : undefined, scopeKey: sourceDeviceId || 'aggregate',
      base: { period: query.period, deviceId: sourceDeviceId ? id('device', sourceDeviceId) : null,
        collectedAt: text(source.updatedAt), stale: typeof source.stale === 'boolean' ? source.stale : null } };
  });
  const available = lifetime ? detailed > 0 : sources.length > 0 && periods === sources.length;
  incomplete ||= lifetime && available && detailed < sources.length;
  return { contexts, titles: extras.preferences?.sessionTitlesEnabled !== false,
    availability: available ? 'available' : 'notCollected', redacted: false, incomplete };
}
function* sessionEntries(plan) {
  for (const context of plan.contexts) for (const key in context.sessions) {
    if (Object.hasOwn(context.sessions, key)) yield { session: context.sessions[key], key, context };
  }
}
function sessionFields({ session, key, context }, plan, id) {
  const scopeKey = context.scopeKey;
  return { id: id('session', `${scopeKey}:${session.client}:${session.sessionId || key}`),
    client: text(session.client), lastUsedAt: text(session.lastUsedAt),
    title: plan.titles ? text(session.title) : null,
    projectId: session.projectLabel ? id('project', `${scopeKey}:${canonicalProjectKey(session.projectLabel)}`) : null,
    totalTokens: number(session.totalTokens ?? session.tokens),
    cost: { knownUsd: number(session.costUsd ?? session.cost ?? session.totalCost) } };
}
function projectSessionActivity({ session, key, context }) {
  return pick(sessionWithActivity(context, key, session)?.liveActivity, 'state observedAt');
}
function projectSessionRow(locator, plan, id, visit = entries) {
  const { session, key, context } = locator;
  return { ...sessionFields(locator, plan, id), ...context.base, ...usage(session),
    ...pick(session, 'startedAt sessionKind', '', 'turnEnded'), ...sessionParent(session, key, context.scopeKey, id),
    projectPath: text(session.projectId),
    promptCache: pick(session.promptCache, 'observedAt', 'ttlSeconds'), liveActivity: locator.liveActivity ?? projectSessionActivity(locator),
    waitingForInput: typeof session.waitingForInput === 'boolean' ? session.waitingForInput : null,
    models: visit(session.models).map(([model, tokens]) => ({ model: text(model), totalTokens: number(tokens), knownUsd: number(session.modelCosts?.[model]),
      tokenComponents: session.modelTokenComponents?.[model]
        ? pick(session.modelTokenComponents[model], '', 'totalTokens inputTokens cacheReadTokens cacheWriteTokens outputTokens') : null })),
    providers: visit(session.providers).map(([provider, tokens]) => ({ provider: text(provider), totalTokens: number(tokens) })) };
}
function sessionModelMatches(session, model) {
  for (const key in session.models) if (Object.hasOwn(session.models, key) && text(key) === model) return true;
  return false;
}
function matchesRow(row, query, modelMatches) {
  return Object.entries(query.filter).every(([field, value]) => {
    if (field === 'deviceId') return true; // Applied by source selection.
    if (field === 'from' || field === 'to') return typeof row.date === 'string' && (field === 'from' ? row.date >= value : row.date <= value);
    if (field === 'search') return [row.title, row.label, row.accountName, row.accountEmail, row.planName].some(v => typeof v === 'string' && v.toLowerCase().includes(value.toLowerCase()));
    if (field === 'model') return modelMatches ?? (row.model === value || !!row.models?.some(m => m.model === value));
    if (field === 'client') return row.client === value || !!row.clients?.some(c => c.client === value);
    return row[field] === value;
  });
}
const compare = (x, y) => x === y ? 0 : x == null ? 1 : y == null ? -1 : x < y ? -1 : 1;
function compareRows(x, y, query) {
  const field = query.sort.field;
  const order = compare(field === 'knownUsd' ? x.cost?.knownUsd : x[field], field === 'knownUsd' ? y.cost?.knownUsd : y[field]);
  return (query.sort.direction === 'desc' ? -order : order) || compare(x.id, y.id);
}
function projectResource(stats, extras, query, auth, opaque) {
  let work = 0;
  const boundedEntries = entries;
  function visit(value) { const items = boundedEntries(value); work += items.length; if (work > MAX_ROWS * 4) failure('budgetExceeded'); return items; }
  if (auth.active !== true) failure('denied');
  if (query.resource === 'liveRate') {
    const rate = extras.liveRate;
    return { rows: stats && rate ? [{ ...rate, id: opaque('liveRate', rate.deviceId ?? 'aggregate'),
      deviceId: rate.deviceId === null ? null : opaque('device', rate.deviceId), period: 'today' }] : [],
    availability: stats ? 'available' : 'notCollected', redacted: false, incomplete: false };
  }
  if (query.resource === 'sessions') {
    const plan = sessionSources(stats, extras, query, opaque), rows = [];
    for (const locator of sessionEntries(plan)) {
      if (++work > MAX_ROWS * 4 || rows.length >= MAX_ROWS) failure('budgetExceeded');
      rows.push(projectSessionRow(locator, plan, opaque, visit));
    }
    return { rows, availability: plan.availability, redacted: plan.redacted, incomplete: plan.incomplete };
  }
  const rows = [];
  const id = (kind, key) => opaque(kind, String(key));
  const add = row => { if (rows.length >= MAX_ROWS) failure('budgetExceeded'); rows.push(row); };
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  if (devices.length > MAX_ROWS) failure('budgetExceeded');
  const selected = devices.filter(d => !query.filter.deviceId || query.filter.deviceId === id('device', d.deviceId));
  const restricted = !!query.filter.deviceId;
  let sources = restricted ? selected : [{ ...stats, deviceId: null }];
  const periodFor = source => {
    const period = source.periods?.[query.period];
    if (source.deviceId || restricted || query.period !== 'allTime' || !extras.allTime) return period;
    // Provenance metadata alone is not evidence of collected accounting data.
    const hasAccounting = ['totalTokens', 'tokens', 'models', 'clients', 'sessions', 'projects'].some(key => Object.hasOwn(extras.allTime, key));
    return period || hasAccounting ? { ...period, ...extras.allTime } : undefined;
  };
  let available = !!stats;
  let incomplete = false;
  if (['usage', 'models', 'tools', 'sessions', 'projects'].includes(query.resource)) {
    available = sources.length > 0 && sources.every(s => !!periodFor(s));
    for (const source of sources) {
      const period = periodFor(source);
      if (!period) continue;
      // Keep aggregate IDs aligned with other periods and project relations;
      // provenance sources are internal, not a change to the requested scope.
      const sourceDeviceId = source.deviceId;
      const deviceId = sourceDeviceId ? id('device', sourceDeviceId) : null;
      const scopeKey = sourceDeviceId || 'aggregate';
      const base = { period: query.period, deviceId, collectedAt: text(source.updatedAt), stale: typeof source.stale === 'boolean' ? source.stale : null };
      if (query.resource === 'usage') add({ id: id('usage', `${scopeKey}:${query.period}`), ...base, ...usage(period), window: { ...pick(source.periodWindows?.[query.period], 'key endsAt'), timeZone: text(source.periodWindows?.timeZone), calendar: 'gregory' } });
      if (query.resource === 'models' || query.resource === 'tools') {
        const model = query.resource === 'models', prefix = model ? 'model' : 'client';
        const parentUnpriced = usage(period).cost.unpricedTokens;
        for (const [key, tokens] of visit(model ? period.models : period.clients)) {
          const dto = usage({ totalTokens: tokens, costUsd: period[`${prefix}Costs`]?.[key], unpricedTokens: period[`${prefix}UnpricedTokens`]?.[key], cacheReadTokens: period[`${prefix}CacheReads`]?.[key], cacheWriteTokens: period[`${prefix}CacheWrites`]?.[key], outputTokens: period[`${prefix}Outputs`]?.[key], unclassifiedTokens: period[`${prefix}UnclassifiedTokens`]?.[key] }, false);
          // Sparse normalized unknown maps mean zero only if the parent has no unknown cost.
          if (dto.cost.unpricedTokens === null && parentUnpriced === 0 && dto.cost.knownUsd !== null) dto.cost = { ...dto.cost, unpricedTokens: 0, completeness: 'complete' };
          // Model attribution cannot prove a client's timing, even if their names match.
          add({ id: id(prefix, `${scopeKey}:${key}`), ...base, [model ? 'model' : 'client']: text(key), label: text(key), ...dto, throughput: pick(model ? period.modelThroughput?.[key] : null, '', 'timedOutputTokens timedDurationMs timedTokens'), ...(model ? {} : { models: visit(period.clientModels?.[key]).map(([name, totalTokens]) => ({ model: text(name), totalTokens: number(totalTokens), knownUsd: number(period.clientModelCosts?.[key]?.[name]) })) }) });
        }
      }
      if (query.resource === 'projects') {
        incomplete ||= !!source.projectsIncomplete || !!source.periodProjectsOmitted?.[query.period] || source.projectsEnabled === false || (query.period === 'allTime' && (!!source.allTimeProjectsOmitted || !!source.allTimeProjectsIncomplete));
        for (const [key, project] of visit(period.projects)) add({ id: id('project', `${scopeKey}:${key}`), ...base, ...usage(project), label: text(project.label), models: visit(project.models).map(([model, tokens]) => ({ model: text(model), totalTokens: number(tokens) })), clients: visit(project.clients).map(([client, tokens]) => ({ client: text(client), totalTokens: number(tokens) })) });
      }
    }
  } else if (query.resource === 'devices') {
    available = Array.isArray(stats?.devices);
    for (const d of selected) add({ id: id('device', d.deviceId), ...pick(d, 'platform osName osVersion agentVersion agentRuntime updatedAt receivedAt', 'ageMs syncUploadIntervalMs', 'stale historyAvailable projectsEnabled'), hostname: text(d.hostname), displayName: text(d.displayName), trackedClients: visit(d.trackedClients).map(([, value]) => text(value)), clientStatus: visit(d.clientStatus).map(([client, state]) => ({ client: text(client), state: text(state) })), wslStatus: { state: text(d.wslStatus?.state), detected: visit(d.wslStatus?.detected).map(([, value]) => text(value)), withData: visit(d.wslStatus?.withData).map(([, value]) => text(value)) } });
  } else if (query.resource === 'history') {
    const history = extras.history ?? stats?.history;
    if (restricted) failure('scopeUnavailable');
    available = !!history;
    const buckets = query.resolution === 'summary' ? [history?.summary].filter(Boolean) : history?.[query.resolution] || [];
    for (const [index, bucket] of visit(buckets)) {
      const date = bucket.date || bucket.month || (query.resolution === 'summary' ? 'allTime' : index);
      if (query.groupBy === 'none') add({ id: id('history', `${query.resolution}:${date}`), date: text(date), ...usage(bucket), ...pick(bucket, 'favoriteModel', 'messages activeDays currentStreak longestStreak peakDayTokens intensity') });
      else for (const [key, value] of visit(bucket[query.groupBy === 'client' ? 'perClient' : 'perModel'])) add({ id: id('history', `${query.resolution}:${date}:${query.groupBy}:${key}`), date: text(date), [query.groupBy]: text(key), ...usage(value) });
    }
  } else if (query.resource === 'limits') {
    const records = restricted ? selected.flatMap(d => d.limits?.providers || []) : stats?.limits?.providers;
    available = Array.isArray(records);
    for (const [, p] of visit(records)) {
      const accountKey = p.accountKey || `${p.provider}:unidentified:${p.source || ''}:${p.adapterId || ''}`;
      const accountId = p.accountKey ? id('account', `${p.provider}:${accountKey}`) : null;
      add({ id: accountId, accountId, identityAvailable: !!p.accountKey, providerLabel: text(LIMIT_TOOL_LABELS.get(p.provider) || p.provider), ...pick(p, 'provider planLabel status workspaceKind updatedAt region source sourceDetail actionRequired', 'balanceUsd'), ...pick(p, 'accountLabel accountName accountEmail'), windows: visit(p.windows).map(([, w]) => ({ ...pick(w, 'kind metric source boundaryKind label resetsAt resetDescription detail currency', 'used limit remaining usedPercent remainingPercent windowMinutes', 'showMeter additional'), displayLabel: text(limitWindowLabel(p.provider, w, 'Quota')) })), balance: pick(p.balance, 'currency expiresAt trackingSince planStatus todayUsageDate latestModelUsageDate todayUsageBasis snapshotDate', 'amount todaySpend weekSpend monthSpend allTimeSpend requestCount giftBalance cashBalance planUsed planLimit planPercent todayTokenTotal', 'monthSinceTracking'), balanceTranches: visit(p.balance?.tranches).map(([, t]) => pick(t, 'currency expiresAt', 'amount')), usageSummary: pick(p.usageSummary, 'period', 'requests todayTokens weekTokens inputTokens outputTokens cacheReadTokens cacheCreationTokens totalTokens standardCost actualCost averageDurationMs'), resetCredits: { ...pick(p.resetCredits, 'nextExpiresAt', 'availableCount'), expirations: visit(p.resetCredits?.expirations).map(([, value]) => text(value)), grants: visit(p.resetCredits?.grants).map(([, g]) => ({ ...pick(g, 'label startsAt endsAt', 'resetsLeft resetsTotal', 'usableNow useRequiresLimit paused'), clears: visit(g.clears).map(([, value]) => text(value)) })) } });
    }
  } else if (query.resource === 'subscriptions') {
    if (restricted) failure('scopeUnavailable');
    const document = extras.subscriptions ?? stats?.subscriptions;
    const list = Array.isArray(document) ? document : document?.subscriptions;
    available = Array.isArray(list);
    for (const [, s] of visit(list)) {
      add({ id: id('subscription', s.id), accountId: s.binding?.accountKey ? id('account', `${s.provider}:${s.binding.accountKey}`) : null, ...pick(s, 'provider kind planName currency interval startDate nextRenewalOverride endDate updatedAt', 'amountMinor intervalCount', 'autoRenew'), note: text(s.note), derived: subscriptionDerivation(s, extras.subscriptionContext, subscriptionForecast(s, extras.subscriptionContext, stats, id, visit)), topUps: visit(s.topUps).map(([, t]) => ({ id: id('topup', `${s.id}:${t.id}`), ...pick(t, 'date', 'amountMinor') })) });
    }
  } else if (query.resource === 'status') {
    for (const d of selected) {
      add({ id: id('status', d.deviceId), deviceId: id('device', d.deviceId), ...pick(d, 'updatedAt receivedAt agentVersion agentRuntime', 'ageMs', 'stale historyAvailable projectsEnabled allTimeProjectsIncomplete allTimeProjectsOmitted'), clients: visit(d.clientHealth?.clients || d.clientHealth).map(([client, h]) => ({ client: text(client), ...pick(h, 'overall'), source: { ...pick(h.source, 'state', 'detectedCount checkedCount'), checks: visit(h.source?.checks).map(([, c]) => pick(c, 'id', '', 'exists')) }, collection: pick(h.collection, 'state lastAttemptAt lastSuccessAt syncFailureStage syncDetailCode', 'syncExitCode'), data: pick(h.data, 'lastActivityDay', 'liveTokens') })) });
    }
    if (!restricted) add({ id: id('status', 'host'), ...pick(stats, 'updatedAt', '', 'projectsIncomplete'), ...pick(extras.status, 'collection sync availability'), preferences: pick(extras.preferences, 'currency timeZone locale', '', 'sessionTitlesEnabled historyEnabled projectsEnabled') });
  }
  return { rows, availability: available ? 'available' : 'notCollected', redacted: false, incomplete };
}
module.exports = { VERSION, RESOURCES, MAX_ROWS, normalizeQuery, projectResource, sessionSources, sessionEntries, sessionFields, projectSessionRow, projectSessionActivity, sessionModelMatches, matchesRow, compareRows };
