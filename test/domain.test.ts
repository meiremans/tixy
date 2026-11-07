import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';
import { checkoutInput, code, csv, eventInput, token, validSignature } from '../server/domain';

test('validates webhook signature on exact body and rejects stale or forged requests', () => {
  const now = 1794052800000;
  const raw = '{"event":"ORDER_COMPLETED"}';
  const signature = 'v1=' + createHmac('sha256', 'secret').update(`v1.${now}.${raw}`).digest('hex');
  assert.equal(validSignature(raw, String(now), 'v1=bad, ' + signature, 'secret', now), true);
  assert.equal(validSignature(raw + ' ', String(now), signature, 'secret', now), false);
  assert.equal(validSignature(raw, String(now), signature, 'wrong', now), false);
  assert.equal(validSignature(raw, String(now), signature, 'secret', now + 300_001), false);
});
test('normalizes checkout email and rejects quantities outside inventory API bounds', () => {
  const input = { eventId: randomUUID(), email: 'Buyer@example.com', quantity: 10, retryKey: randomUUID() };
  assert.equal(checkoutInput.parse(input).email, 'buyer@example.com');
  for (const quantity of [0, 11, 1.5]) assert.equal(checkoutInput.safeParse({ ...input, quantity }).success, false);
  assert.ok(token.safeParse(code()).success);
});
test('validates time-zone and price before publishing', () => {
  const event = { title: 'Tixy event', description: 'Live music', venue: 'Hall', startsAt: '2027-03-01T20:00:00+02:00',
    timezone: 'Europe/Bucharest', price: 1000, capacity: 100, state: 'published' };
  assert.ok(eventInput.safeParse(event).success);
  assert.equal(eventInput.safeParse({ ...event, timezone: 'GMT+Unknown' }).success, false);
});
test('CSV escapes formulas and preserves signed numerical values', () => {
  assert.equal(csv([['=FORMULA()', 'Text "quoted"', -12.5]]), "\"'=FORMULA()\",\"Text \"\"quoted\"\"\",\"-12.5\"\r\n");
});
