import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusedMs, formatClock, formatCountdown, formatDuration } from '../shared/timer.ts';

test('focused time excludes every pause, including an open one', () => {
  const s = { startedAt: 0, endedAt: null, pauses: [{ pausedAt: 10_000, resumedAt: 25_000 }, { pausedAt: 40_000, resumedAt: null }] };
  assert.equal(focusedMs(s, 60_000), 10_000 + 15_000);
});

test('finished sessions ignore "now"', () => {
  const s = { startedAt: 0, endedAt: 30_000, pauses: [{ pausedAt: 5_000, resumedAt: 10_000 }] };
  assert.equal(focusedMs(s, 999_999), 25_000);
});

test('formatting', () => {
  assert.equal(formatClock(32 * 60_000 + 18_000), '00:32:18');
  assert.equal(formatCountdown(0, 45), '45:00');
  assert.equal(formatCountdown(46 * 60_000, 45), '+01:00');
  assert.equal(formatDuration(155 * 60_000), '2h 35m');
  assert.equal(formatDuration(20_000), '<1m');
  assert.equal(formatDuration(0), '0m');
});
