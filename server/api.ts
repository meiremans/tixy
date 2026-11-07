import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { checkoutInput, csv, eventInput, token, validSignature } from './domain';
import { checkout, HttpError, open, orderKey } from './orders';
import { secrets } from './provider';
import { conflict, get, put, records, replace, transact, update, type Event, type Order, type Refund, type Ticket } from './store';

const sqs = new SQSClient({});
const json = (statusCode: number, value: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(value),
});
const uuid = z.uuid();
const cfg = () => ({
  seller: process.env.SELLER ?? '', organizer: process.env.ORGANIZER ?? '', policies: process.env.POLICIES ?? '',
  checkoutEnabled: process.env.CHECKOUT_ENABLED === 'true',
});
const publicEvent = (event: Event) => ({
  id: event.id, title: event.title, description: event.description, venue: event.venue, startsAt: event.startsAt,
  timezone: event.timezone, price: event.price, available: open(event) ? Math.max(0, event.capacity - event.sold - event.reserved) : 0,
});
async function eventById(id: string) {
  const event = await get<Event>('event#' + uuid.parse(id));
  if (!event) throw new HttpError(404, 'Event not found.');
  return event;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const { rawPath: path, requestContext, headers } = event;
  const method = requestContext.http.method;
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
  const body = () => {
    try { return JSON.parse(raw) as unknown; } catch { throw new HttpError(400, 'Invalid request body.'); }
  };
  try {
    if (path === '/api/webhooks/revolut' && method === 'POST') {
      if (!validSignature(raw, headers['revolut-request-timestamp'] ?? '', headers['revolut-signature'] ?? '', (await secrets()).webhookSecret))
        return json(401, { error: 'Invalid signature.' });
      const notice = z.object({ order_id: uuid }).parse(body());
      await sqs.send(new SendMessageCommand({ QueueUrl: process.env.PAYMENT_QUEUE, MessageBody: notice.order_id }));
      return { statusCode: 204 };
    }
    if (path === '/api/events' && method === 'GET') {
      const events = [];
      for await (const entry of records<Event>('event')) if (open(entry)) events.push(publicEvent(entry));
      return json(200, { events: events.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)), ...cfg() });
    }
    if (path.startsWith('/api/events/') && method === 'GET') {
      const entry = await eventById(path.split('/').at(-1)!);
      if (entry.state === 'draft') throw new HttpError(404, 'Event not found.');
      return json(200, { event: publicEvent(entry), ...cfg() });
    }
    if (path === '/api/checkout' && method === 'POST') {
      if (!cfg().checkoutEnabled) throw new HttpError(503, 'Checkout is currently closed.');
      const origin = process.env.PUBLIC_ORIGIN;
      if (!origin) throw new HttpError(503, 'Checkout is currently closed.');
      const input = checkoutInput.parse(body());
      if (process.env.SMOKE_BUYER && input.email !== process.env.SMOKE_BUYER)
        throw new HttpError(503, 'Checkout is currently available for launch testing only.');
      const order = await checkout(input, origin);
      return json(200, { token: order.statusToken, checkoutUrl: order.state === 'pending' ? order.url : undefined });
    }
    if (path.startsWith('/api/orders/') && method === 'GET') {
      const statusToken = token.parse(path.split('/').at(-1));
      const link = await get<{ orderId: string }>('status#' + statusToken);
      const order = link && await get<Order>(orderKey(link.orderId));
      if (!order) throw new HttpError(404, 'Order not found.');
      return json(200, { state: order.state, checkoutUrl: order.state === 'pending' ? order.url : undefined, quantity: order.quantity });
    }
    if (path.startsWith('/api/staff/')) {
      const claims = requestContext.authorizer?.jwt.claims;
      const groups = String(claims?.['cognito:groups'] ?? '').replace(/[\[\]"]/g, '').split(/[ ,]+/);
      const admin = groups.includes('admins');
      if (claims?.token_use !== 'access' || (!admin && !groups.includes('door'))) throw new HttpError(403, 'Staff access required.');
      if (path === '/api/staff/events' && method === 'GET') {
        const events = [];
        for await (const entry of records<Event>('event')) {
          if (admin) events.push(entry);
          else if (entry.state !== 'draft') events.push(publicEvent(entry));
        }
        return json(200, { events, admin });
      }
      if (path === '/api/staff/check-in' && method === 'POST') {
        const input = z.object({ eventId: uuid, code: token }).parse(body());
        const ticket = await get<Ticket>('ticket#' + input.code);
        if (!ticket || ticket.eventId !== input.eventId) throw new HttpError(404, 'Ticket is invalid for this event.');
        for (let attempt = 0; attempt < 4; attempt++) {
          const order = await get<Order>(orderKey(ticket.orderId));
          if (order?.state !== 'paid') throw new HttpError(409, 'Ticket is void.');
          const current = await get<Ticket>(ticket.pk);
          if (current?.checkedAt) throw new HttpError(409, 'Already admitted at ' + current.checkedAt);
          const time = new Date().toISOString();
          try {
            await transact(replace({ ...order, checked: order.checked + 1 }),
              update(ticket.pk, 'SET checkedAt = :time', 'attribute_exists(pk) AND attribute_not_exists(checkedAt)', { ':time': time }));
            return json(200, { checkedAt: time });
          } catch (error) { if (!conflict(error)) throw error; }
        }
        throw new HttpError(409, 'Check-in changed. Scan again.');
      }
      if (!admin) throw new HttpError(403, 'Admin access required.');
      if (path === '/api/staff/events' && method === 'POST') {
        const data = eventInput.parse(body());
        const id = randomUUID();
        await transact(put({ ...data, pk: 'event#' + id, id, kind: 'event', reserved: 0, sold: 0, rev: 0 }));
        return json(201, { id });
      }
      if (path.startsWith('/api/staff/events/') && method === 'PUT') {
        const entry = await eventById(path.split('/').at(-1)!);
        const data = eventInput.parse(body());
        if (data.capacity < entry.sold + entry.reserved) throw new HttpError(409, 'Capacity is below committed inventory.');
        if (entry.state !== 'draft' && data.state === 'draft') throw new HttpError(409, 'Close published events instead.');
        await transact(replace({ ...entry, ...data }));
        return json(200, { id: entry.id });
      }
      if (path === '/api/staff/resend' && method === 'POST') {
        const { orderId } = z.object({ orderId: uuid }).parse(body());
        const order = await get<Order>(orderKey(orderId));
        if (order?.state !== 'paid') throw new HttpError(404, 'Paid order not found.');
        await transact(put({ pk: 'mail#' + randomUUID(), kind: 'mail', orderId, created: Date.now() }));
        return json(202, { queued: true });
      }
      if (path === '/api/staff/sales.csv' && method === 'GET') {
        const { eventId, from, to } = z.object({ eventId: uuid, from: z.iso.date(), to: z.iso.date() }).parse(event.queryStringParameters);
        if (from > to) throw new HttpError(400, 'Invalid date range.');
        const rows: (string | number)[][] = [];
        const inside = (value: string) => value.slice(0, 10) >= from && value.slice(0, 10) <= to;
        for await (const order of records<Order>('order'))
          if (order.eventId === eventId && order.paidAt && inside(order.paidAt))
            rows.push([order.paidAt, 'sale', order.quantity, order.amount / 100, order.id, order.providerId!, 'EUR', order.review ? 'review' : '']);
        for await (const refund of records<Refund>('refund'))
          if (refund.eventId === eventId && inside(refund.completedAt))
            rows.push([refund.completedAt, 'refund', '', -refund.amount / 100, refund.orderId, refund.providerId, 'EUR', '']);
        rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        return { statusCode: 200, headers: { 'content-type': 'text/csv', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="tixy-sales.csv"' },
          body: csv([['timestamp', 'type', 'tickets', 'amount_eur', 'tixy_order', 'revolut_order', 'currency', 'review'], ...rows]) };
      }
    }
    return json(404, { error: 'Not found.' });
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    if (error instanceof ZodError) return json(400, { error: 'Check the submitted fields and try again.' });
    if (conflict(error)) return json(409, { error: 'The record changed. Please try again.' });
    console.error('API failure', requestContext.requestId, error instanceof Error ? error.name : 'unknown');
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
}
