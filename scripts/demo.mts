import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import QRCode from 'qrcode';
import { checkoutInput, code, csv, eventInput } from '../server/domain';

const events = new Map([
  ['After Hours', 'Studio 21, Bucharest', 1800],
  ['Rooftop Sessions', 'The Terrace, Bucharest', 2500],
].map(([title, venue, price], index) => {
  const id = randomUUID();
  return [id, { id, title, venue, price, description: 'An evening of electronic music and dancing.',
    startsAt: new Date(Date.now() + (14 + 7 * index) * 86400_000).toISOString(),
    timezone: 'Europe/Bucharest', capacity: 60, sold: 0, reserved: 0, state: 'published' }];
}));
const orders = new Map();
const tickets = new Map();
const authCodes = new Map();
const sessions = new Map();
const port = 5187;
const origin = `http://127.0.0.1:${port}`;
const config = { seller: 'Tixy demo seller', organizer: 'Tixy demo organizer', policies: '/demo/policies', checkoutEnabled: true };
const money = cents => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const listing = event => ({ ...event, available: event.state === 'published' ? event.capacity - event.sold - event.reserved : 0 });
const encode = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const page = (title, content) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tixy demo</title><link rel="stylesheet" href="/web/style.css"><header><a class="brand" href="/">tixy<span>.</span></a><strong>Local demo</strong></header>
<main><section class="panel"><h1>${title}</h1>${content}</section></main></html>`;

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Request is too large.');
  }
  return raw;
}

async function handle(request, response, next) {
  const { pathname, searchParams } = new URL(request.url, origin);
  const method = request.method;
  const json = (value, status = 200) => reply(status, 'application/json', JSON.stringify(value));
  const html = (title, content) => reply(200, 'text/html', page(title, content));
  const fail = (status, error) => json({ error }, status);
  const redirect = path => { response.writeHead(303, { Location: path }); response.end(); };
  const parse = async () => JSON.parse(await body(request));
  function reply(status, type, value) {
    response.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(value);
  }

  if (pathname === '/config.json') return json({ cognito: origin, clientId: 'tixy-local-demo' });
  if (pathname === '/oauth2/authorize') {
    const state = searchParams.get('state');
    const challenge = searchParams.get('code_challenge');
    if (searchParams.get('redirect_uri') !== origin + '/' || !state || !challenge) return fail(400, 'Invalid demo sign-in.');
    const authorize = role => {
      const authCode = code();
      authCodes.set(authCode, { challenge, role, expires: Date.now() + 120_000 });
      return '/?' + new URLSearchParams({ code: authCode, state });
    };
    return html('Demo staff sign-in', `<p>Choose a role. This account only exists on this computer.</p>
      <p><a class="button" href="${encode(authorize('admin'))}">Continue as admin</a></p>
      <p><a class="button secondary" href="${encode(authorize('door'))}">Continue as door staff</a></p>`);
  }
  if (pathname === '/oauth2/token' && method === 'POST') {
    const input = new URLSearchParams(await body(request));
    const authCode = input.get('code');
    const record = authCodes.get(authCode);
    const challenge = createHash('sha256').update(input.get('code_verifier') || '').digest('base64url');
    if (!record || record.expires < Date.now() || record.challenge !== challenge) return fail(400, 'Demo sign-in expired.');
    authCodes.delete(authCode);
    const session = code();
    sessions.set(session, record.role);
    return json({ access_token: session });
  }
  if (pathname === '/logout') return redirect('/');
  if (pathname === '/demo/policies') return html('Preview policies', '<p>All transactions here are simulated. Use a sample email address. No money is collected and no email is sent.</p>');

  const parts = pathname.split('/');
  if (pathname === '/api/events') return json({ ...config, events: [...events.values()].filter(e => e.state === 'published').map(listing) });
  if (pathname.startsWith('/api/events/')) {
    const event = events.get(parts[3]);
    return event && event.state !== 'draft' ? json({ ...config, event: listing(event) }) : fail(404, 'Event not found.');
  }
  if (pathname === '/api/checkout' && method === 'POST') {
    const input = checkoutInput.parse(await parse());
    const existing = orders.get(input.retryKey);
    if (existing) {
      if (existing.eventId !== input.eventId || existing.quantity !== input.quantity || existing.email !== input.email)
        return fail(409, 'Start a new checkout for a different purchase.');
      return json({ token: existing.token, checkoutUrl: existing.state === 'pending' ? '/demo/pay/' + existing.token : undefined });
    }
    const event = events.get(input.eventId);
    if (!event || listing(event).available < input.quantity) return fail(409, 'That quantity is no longer available.');
    const order = { ...input, token: code(), amount: event.price * input.quantity, state: 'pending', tickets: [] };
    event.reserved += order.quantity;
    orders.set(input.retryKey, order);
    return json({ token: order.token, checkoutUrl: '/demo/pay/' + order.token });
  }
  if (pathname.startsWith('/api/orders/') || pathname.startsWith('/demo/pay/')) {
    const order = [...orders.values()].find(o => o.token === parts[3]);
    if (!order) return fail(404, 'Demo order not found.');
    if (pathname.startsWith('/api/')) return json({ state: order.state, quantity: order.quantity,
      checkoutUrl: order.state === 'pending' ? '/demo/pay/' + order.token : undefined,
      emailPreviewUrl: order.state === 'paid' ? '/demo/pay/' + order.token : undefined });
    const event = events.get(order.eventId);
    if (method === 'POST' && order.state === 'pending') {
      const action = new URLSearchParams(await body(request)).get('action');
      // Recheck after consuming the body so two requests cannot settle the same order.
      if (order.state !== 'pending') return redirect(pathname);
      event.reserved -= order.quantity;
      if (action === 'cancel') order.state = 'expired';
      else {
        order.state = 'paid';
        order.paidAt = new Date().toISOString();
        event.sold += order.quantity;
        order.tickets = Array.from({ length: order.quantity }, () => code());
        for (const ticket of order.tickets) tickets.set(ticket, { eventId: event.id });
      }
      return redirect(pathname);
    }
    if (order.state === 'paid') {
      const cards = await Promise.all(order.tickets.map(async (ticket, index) =>
        `<p><img alt="Ticket ${index + 1} QR code" width="200" height="200" src="${await QRCode.toDataURL(ticket)}"><br><code>${ticket}</code></p>`));
      return html('Ticket email preview', `<p>${encode(event.title)} · To ${encode(order.email)}</p>
        <p>Order <code>${order.retryKey}</code></p>${cards.join('')}
        <p><a href="/?order=${order.token}">View order status</a> · <a href="/?staff">Try staff check-in</a></p>`);
    }
    if (order.state === 'expired') return redirect('/?order=' + order.token);
    return html('Simulated checkout', `<p>${encode(event.title)} · ${order.quantity} ticket(s) · ${money(order.amount)}</p>
      <p>No payment is collected.</p><form method="post"><button name="action" value="pay">Simulate payment</button>
      <button class="secondary" name="action" value="cancel">Cancel checkout</button></form>`);
  }

  if (pathname.startsWith('/api/staff/')) {
    const role = sessions.get((request.headers.authorization || '').replace(/^Bearer /, ''));
    if (!role) return fail(401, 'Sign in to the local demo.');
    const admin = role === 'admin';
    if (pathname === '/api/staff/events' && method === 'GET')
      return json({ admin, events: [...events.values()].filter(e => admin || e.state !== 'draft').map(listing) });
    if (pathname === '/api/staff/check-in' && method === 'POST') {
      const input = await parse();
      const ticket = tickets.get(input.code);
      if (!ticket || ticket.eventId !== input.eventId) return fail(404, 'Ticket is invalid for this event.');
      if (ticket.checkedAt) return fail(409, 'Already admitted at ' + ticket.checkedAt);
      ticket.checkedAt = new Date().toISOString();
      return json({ checkedAt: ticket.checkedAt });
    }
    if (!admin) return fail(403, 'Admin access required.');
    if (pathname === '/api/staff/events' && method === 'POST') {
      const event = eventInput.parse(await parse());
      const id = randomUUID();
      events.set(id, { ...event, id, reserved: 0, sold: 0 });
      return json({ id }, 201);
    }
    if (pathname.startsWith('/api/staff/events/') && method === 'PUT') {
      const input = eventInput.parse(await parse());
      const event = events.get(parts[4]);
      if (!event) return fail(404, 'Event not found.');
      if (input.capacity < event.sold + event.reserved) return fail(409, 'Capacity is below committed inventory.');
      Object.assign(event, input);
      return json({ id: event.id });
    }
    if (pathname === '/api/staff/resend' && method === 'POST') {
      const order = orders.get((await parse()).orderId);
      return order?.state === 'paid' ? json({ queued: true }, 202) : fail(404, 'Paid order not found.');
    }
    if (pathname === '/api/staff/sales.csv') {
      const rows = [...orders.values()].filter(order => {
        const date = order.paidAt?.slice(0, 10);
        return order.eventId === searchParams.get('eventId') && date && date >= searchParams.get('from') && date <= searchParams.get('to');
      }).map(order => [order.paidAt, 'sale', order.quantity, order.amount / 100, order.retryKey, 'demo', 'EUR']);
      return reply(200, 'text/csv', csv([['timestamp', 'type', 'tickets', 'amount_eur', 'tixy_order', 'revolut_order', 'currency'], ...rows]));
    }
    return fail(404, 'Demo route not found.');
  }
  next();
}

const server = await createServer({
  server: { host: '127.0.0.1', port, strictPort: true },
  plugins: [{
    name: 'tixy-local-demo',
    transformIndexHtml: () => [{ tag: 'p', attrs: { role: 'status', style: 'margin:0;padding:.5rem;text-align:center;background:#d5ff6d;color:#111014' }, children: 'Local demo · Simulated payments · Use a sample email', injectTo: 'body-prepend' }],
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handle(request, response, next).catch(() => {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'The demo could not process this request.' }));
        });
      });
    },
  }],
});
await server.listen();
server.printUrls();
