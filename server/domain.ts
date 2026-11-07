import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const code = () => randomBytes(24).toString('base64url');
export const token = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const checkoutInput = z.object({
  eventId: z.uuid(), quantity: z.number().int().min(1).max(10),
  email: z.email().max(254).transform(value => value.toLowerCase()), retryKey: z.uuid(),
});
export const eventInput = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(4000),
  venue: z.string().trim().min(1).max(200), startsAt: z.iso.datetime({ offset: true }),
  timezone: z.string().refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }),
  price: z.number().int().min(100).max(1_000_000), capacity: z.number().int().min(1).max(100_000),
  state: z.enum(['draft', 'published', 'closed']),
});

export function validSignature(raw: string, timestamp: string, signatures: string, secret: string, now = Date.now()) {
  if (!/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 300_000) return false;
  const expected = createHmac('sha256', secret).update(`v1.${timestamp}.${raw}`).digest();
  return signatures.split(',').some(signature => {
    const match = /^v1=([0-9a-f]{64})$/i.exec(signature.trim());
    return !!match && timingSafeEqual(expected, Buffer.from(match[1], 'hex'));
  });
}

export function csv(rows: (string | number)[][]) {
  return rows.map(row => row.map(value => {
    const safe = typeof value === 'string' && /^[\s]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : String(value);
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}
