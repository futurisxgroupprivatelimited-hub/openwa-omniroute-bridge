import { test } from 'node:test';
import assert from 'node:assert/strict';
import { num } from '../src/routes/admin.js';

test('num: returns the default for missing/NaN/zero/negative input', () => {
  assert.equal(num(undefined, 25, 100), 25);
  assert.equal(num(null, 25, 100), 25);
  assert.equal(num('abc', 25, 100), 25);
  assert.equal(num('0', 25, 100), 25);
  assert.equal(num('-5', 25, 100), 25);
  assert.equal(num('', 25, 100), 25);
});

test('num: parses positive numeric strings', () => {
  assert.equal(num('10', 25, 100), 10);
  assert.equal(num(42, 25, 100), 42);
});

test('num: clamps to the max', () => {
  assert.equal(num('500', 25, 100), 100);
  assert.equal(num(99999, 10, 100000), 99999); // within max, allowed
  assert.equal(num(99999, 10, 1000), 1000); // clamped
});
