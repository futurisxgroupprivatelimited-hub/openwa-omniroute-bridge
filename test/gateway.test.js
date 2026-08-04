import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret } from '../src/services/gateway.js';

test('maskSecret: empty input -> empty string', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret(undefined), '');
  assert.equal(maskSecret(null), '');
});

test('maskSecret: short secrets are fully masked', () => {
  assert.equal(maskSecret('abc'), '••••••••');
  assert.equal(maskSecret('12345678'), '••••••••');
});

test('maskSecret: longer secrets keep first 4 and last 4 chars', () => {
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd••••••mnop');
});

test('maskSecret: does not leak the middle of the secret', () => {
  const secret = 'sk-proj-very-secret-key-value-1234567890';
  const masked = maskSecret(secret);
  assert.ok(!masked.includes(secret.slice(5, -5)));
  assert.equal(masked.length, 4 + 6 + 4);
});
