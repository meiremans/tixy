import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { SQSEvent } from 'aws-lambda';
import QRCode from 'qrcode';
import { orderKey, reconcileOrder, syncRemote } from './orders';
import { list, retrieve } from './provider';
import { conflict, get, records, transact, update, type Event, type Mail, type Order } from './store';

const sqs = new SQSClient({});
const ses = new SESv2Client({});
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export async function payment(event: SQSEvent) {
  for (const message of event.Records) await syncRemote(await retrieve(message.body));
}

export async function email(event: SQSEvent) {
  for (const message of event.Records) {
    const mail = await get<Mail>(message.body);
    if (!mail || mail.sent) continue;
    const now = Date.now();
    const lease = now + 120_000;
    try {
      await transact(update(mail.pk, 'SET lease = :lease', 'attribute_not_exists(sent) AND (attribute_not_exists(lease) OR lease < :now)',
        { ':lease': lease, ':now': now }));
    } catch (error) { if (conflict(error)) continue; throw error; }
    try {
      const order = await get<Order>(orderKey(mail.orderId));
      if (order?.state === 'paid' && order.tickets?.length) {
        const entry = await get<Event>('event#' + order.eventId);
        if (!entry) throw new Error('Event not found for ticket email');
        const date = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', timeZone: entry.timezone }).format(new Date(entry.startsAt));
        const attachments = await Promise.all(order.tickets.map(async (ticket, index) => ({
          FileName: `ticket-${index + 1}.png`, ContentType: 'image/png', RawContent: await QRCode.toBuffer(ticket, { width: 260 }),
          ContentDisposition: 'INLINE' as const, ContentId: `ticket-${index + 1}`, TransferEncoding: 'BASE64' as const,
        })));
        await ses.send(new SendEmailCommand({
          FromEmailAddress: process.env.FROM_EMAIL, Destination: { ToAddresses: [order.email] },
          Content: { Simple: {
            Subject: { Data: 'Your Tixy tickets for ' + entry.title, Charset: 'UTF-8' },
            Body: {
              Text: { Data: `${entry.title}\n${entry.venue}\n${date}\nOrder ${order.id}\n\nAdmission codes:\n${order.tickets.join('\n')}`, Charset: 'UTF-8' },
              Html: { Data: `<h1>${escape(entry.title)}</h1><p>${escape(entry.venue)} · ${escape(date)}</p><p>Order ${order.id}</p>` +
                order.tickets.map((ticket, index) => `<p><img src="cid:ticket-${index + 1}" alt="Ticket ${index + 1} QR code"><br><code>${ticket}</code></p>`).join(''), Charset: 'UTF-8' },
            }, Attachments: attachments,
          } },
        }));
      }
      await transact(update(mail.pk, 'SET sent = :sent REMOVE lease', 'lease = :lease', { ':sent': true, ':lease': lease }));
    } catch (error) {
      await transact(update(mail.pk, 'REMOVE lease', 'lease = :lease', { ':lease': lease }));
      throw error;
    }
  }
}

export async function reconcile() {
  let failures = 0;
  let stuck = 0;
  for await (const order of records<Order>('order')) {
    if (order.state !== 'pending' && order.state !== 'creating') continue;
    try { await reconcileOrder(order); } catch { failures++; }
    if (Date.now() - order.created > 30 * 60_000) stuck++;
  }
  // Sweep newly created refund orders, including provider-side dashboard refunds.
  // Overlap across runs so delayed status transitions and failed invocations can recover.
  if (process.env.CHECKOUT_ENABLED === 'true' || process.env.RECONCILE_ENABLED === 'true') {
    try {
      const end = Date.now();
      const windows = [[end - 7 * 86_400_000, end]];
      while (windows.length) {
        const [from, to] = windows.pop()!;
        const page = await list(new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: '100' }));
        if (page.orders.length === 100) {
          if (to - from < 2) throw new Error('Revolut order window reached the page limit');
          const midpoint = Math.floor((from + to) / 2);
          windows.push([from, midpoint], [midpoint, to]);
          continue;
        }
        for (const remote of page.orders)
          if (remote.type === 'refund' && remote.state === 'completed') {
            try { await syncRemote(await retrieve(remote.id)); } catch { failures++; }
          }
      }
    } catch { failures++; }
  }
  for await (const mail of records<Mail>('mail')) {
    if (!mail.sent && (mail.lease ?? 0) < Date.now()) {
      try { await sqs.send(new SendMessageCommand({ QueueUrl: process.env.EMAIL_QUEUE, MessageBody: mail.pk })); }
      catch { failures++; }
    }
  }
  if (stuck) console.warn('STUCK_ORDERS', stuck);
  if (failures) throw new Error(`Reconciliation encountered ${failures} errors`);
}
