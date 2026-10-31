import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { accountSummary, accountUsage, errorCode, resetOutcome } from '../../../ui/account-model.js';

const usage = { usage: { state: 'fresh', value: { availableCount: 1 } }, resetCredits: { state: 'fresh', value: {
  availableCount: 1,
  credits: [{ id: 'safe-credit', status: 'available', resetType: 'daily', grantedAt: 1700000000000,
    title: 'Daily reset', description: 'A bounded description', expiresAt: 1700003600000 }],
} } };

test('old accounts default automation off; pending automatic reset is bounded and redacted', () => {
  const base = { id: 'simulation-account', label: 'Simulation', status: 'active', available: true };
  const defaults = accountSummary(base);
  assert.equal(defaults.autoResetCredits, false);
  assert.equal(defaults.autoResetLeadMinutes, 30);
  assert.equal(defaults.autoResetOnLowBalance, false);
  assert.equal(defaults.autoResetRemainingPercent, 10);
  const pending = { creditId: 'simulation-credit', redeemRequestId: '123e4567-e89b-42d3-a456-426614174000', expiresAt: 1900000000000, completed: false };
  const parsed = accountSummary({ ...base, autoResetCredits: true, pendingAutoReset: { ...pending, accessToken: 'never-expose' } });
  assert.equal(parsed.autoResetCredits, true);
  assert.deepEqual(parsed.pendingAutoReset, { creditId: pending.creditId, redeemRequestId: pending.redeemRequestId, expiresAt: pending.expiresAt });
  for (const autoResetCredits of ['true', 1, null]) assert.throws(() => accountSummary({ ...base, autoResetCredits }), /invalid_response/);
  for (const [field, invalid] of [['autoResetLeadMinutes', 0], ['autoResetLeadMinutes', 10081], ['autoResetLeadMinutes', null],
    ['autoResetOnLowBalance', 1], ['autoResetOnLowBalance', null], ['autoResetRemainingPercent', -1],
    ['autoResetRemainingPercent', 101], ['autoResetRemainingPercent', null]] as const) {
    assert.throws(() => accountSummary({ ...base, [field]: invalid }), /invalid_response/);
  }
  const boundaries = accountSummary({ ...base, autoResetCredits: true, autoResetLeadMinutes: 10080, autoResetOnLowBalance: true, autoResetRemainingPercent: 0 });
  assert.equal(boundaries.autoResetLeadMinutes, 10080);
  assert.equal(boundaries.autoResetOnLowBalance, true);
  assert.equal(boundaries.autoResetRemainingPercent, 0);
  for (const override of [{ creditId: '' }, { redeemRequestId: 'bad' }, { expiresAt: NaN }, { completed: true }]) {
    assert.throws(() => accountSummary({ ...base, pendingAutoReset: { ...pending, ...override } }), /invalid_response/);
  }
});

test('account quota cycle follows only recognized free and paid plan names', () => {
  const base = { id: 'simulation-account', label: 'Simulation', status: 'active', available: true };
  for (const [planType, quotaCycle] of [
    ['free', 'month'], ['Free', 'month'], ['plus', 'week'], ['Plus', 'week'], ['pro', 'week'],
    ['future-plan', 'weekOrMonth'], [undefined, 'weekOrMonth'],
  ] as const) {
    assert.equal(accountSummary({ ...base, identity: planType === undefined ? {} : { planType } }).quotaCycle, quotaCycle);
  }
});

test('projects bounded credit metadata without exposing unsafe fields', () => {
  const result = accountUsage(usage);
  assert.deepEqual(result.resetCredits.value?.credits[0], {
    creditId: 'safe-credit', status: 'available', resetType: 'daily', grantedAt: 1700000000000,
    title: 'Daily reset', description: 'A bounded description', expiresAt: 1700003600000,
  });
  for (const status of ['redeeming', 'redeemed', 'unknown']) assert.equal(accountUsage({
    ...usage, resetCredits: { ...usage.resetCredits, value: { ...usage.resetCredits.value, credits: [{ id: 'x', status }] } },
  }).resetCredits.value?.credits[0].status, status);
});

test('rejects invalid credit statuses, types and control characters', () => {
  for (const status of ['consumed', 'available\n', 1, null]) assert.throws(() => accountUsage({
    ...usage, resetCredits: { ...usage.resetCredits, value: { ...usage.resetCredits.value, credits: [{ id: 'x', status }] } },
  }), /invalid_response/);
  for (const field of ['title', 'description', 'resetType']) assert.throws(() => accountUsage({
    ...usage, resetCredits: { ...usage.resetCredits, value: { ...usage.resetCredits.value, credits: [{ id: 'x', status: 'available', [field]: 'bad\u0000text' }] } },
  }), /invalid_response/);
});

test('keeps usage availableCount authoritative and rejects invalid counts', () => {
  assert.equal(accountUsage(usage).usage.value?.availableCount, 1);
  for (const availableCount of [-1, 1.5, '1', null]) assert.throws(() => accountUsage({
    ...usage, usage: { state: 'fresh', value: { availableCount } },
  }), /invalid_response/);
});

test('treats a null secondary window as absent, not malformed', () => {
  const parsed = accountUsage({ usage: { state: 'fresh', value: { primary: { usedPercent: 25 }, secondary: null } }, resetCredits: { state: 'fresh', value: { availableCount: 1, credits: [] } } });
  assert.equal((parsed.usage.value?.primary as {usedPercent:number})?.usedPercent, 25);
  assert.equal(parsed.usage.value?.secondary, undefined);
});

test('accepts only definite outcomes and non-negative integer windowsReset', () => {
  for (const outcome of ['reset', 'already_redeemed', 'nothing_to_reset', 'no_credit']) assert.equal(resetOutcome({ outcome, windowsReset: 0 }).outcome, outcome);
  assert.throws(() => resetOutcome({ outcome: 'reset' }), /invalid_response/);
  for (const value of ['nothing', 'reset_outcome_unknown', 'unexpected', 1]) assert.throws(() => resetOutcome({ outcome: value }), /invalid_response|reset_outcome_unknown/);
  for (const windowsReset of [-1, 1.5, '1', null]) assert.throws(() => resetOutcome({ outcome: 'reset', windowsReset }), /invalid_response/);
});

test('keeps unknown reset errors on the explicit API error path', () => {
  assert.equal(errorCode({ body: { error: 'reset_outcome_unknown' } }), 'reset_outcome_unknown');
  assert.equal(errorCode({ body: { error: 'reset_in_progress' } }), 'reset_in_progress');
  assert.equal(errorCode({ body: { error: 'reset' } }), 'unknown');
  for (const code of ['credits_unavailable', 'credit_unavailable', 'upstream_unavailable', 'request_cancelled']) assert.equal(errorCode({ body: { error: code } }), code);
});
