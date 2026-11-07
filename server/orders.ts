import { code, type checkoutInput } from './domain';
import { createRemote, list, ProviderError, retrieve, secrets, type RemoteOrder } from './provider';
import { conflict, get, put, replace, transact, type Event, type Order, type Refund } from './store';
import type { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const open = (event: Event) => event.state === 'published' && Date.parse(event.startsAt) > Date.now();
export const orderKey = (id: string) => 'order#' + id;

export async function checkout(input: z.infer<typeof checkoutInput>, origin: string) {
  const pk = orderKey(input.retryKey);
  const existing = await get<Order>(pk);
  if (existing) {
    if (existing.email !== input.email || existing.eventId !== input.eventId || existing.quantity !== input.quantity)
      throw new HttpError(409, 'Start a new checkout for a different purchase.');
    return existing;
  }
  const event = await get<Event>('event#' + input.eventId);
  if (!event || !open(event)) throw new HttpError(404, 'Sales are closed for this event.');
  if (event.capacity - event.reserved - event.sold < input.quantity) throw new HttpError(409, 'That quantity is no longer available.');
  try { await secrets(); } catch {
    throw new HttpError(503, 'Checkout is temporarily unavailable.');
  }
  const order: Order = {
    pk, kind: 'order', id: input.retryKey, eventId: event.id, quantity: input.quantity, email: input.email,
    amount: event.price * input.quantity, statusToken: code(), state: 'creating', created: Date.now(),
    checked: 0, refunded: 0, rev: 0,
  };
  try {
    await transact(put(order), replace({ ...event, reserved: event.reserved + order.quantity }),
      put({ pk: 'status#' + order.statusToken, orderId: order.id }));
  } catch (error) {
    if (conflict(error)) throw new HttpError(409, 'Availability changed. Please try again.');
    throw error;
  }
  let remote: RemoteOrder;
  try {
    remote = await createRemote({
      amount: order.amount, currency: 'EUR', description: event.title, customer: { email: order.email },
      capture_mode: 'automatic', expire_pending_after: 'PT15M', merchant_order_data: { reference: order.id },
      redirect_url: origin + '/?order=' + order.statusToken,
    });
  } catch (error) {
    if (error instanceof ProviderError && [400, 401, 403, 422].includes(error.status)) {
      await finish(order, 'expired');
      throw new HttpError(502, 'Checkout is temporarily unavailable.');
    }
    return order;
  }
  try {
    await syncRemote({ ...remote, merchant_order_data: { reference: order.id } });
  } catch (error) {
    if (!conflict(error)) throw error;
  }
  return (await get<Order>(pk)) ?? order;
}

async function finish(order: Order, state: 'paid' | 'expired', remote?: RemoteOrder) {
  const event = await get<Event>('event#' + order.eventId);
  if (!event) throw new Error('Missing event for reservation');
  const paid = state === 'paid';
  const tickets = paid ? Array.from({ length: order.quantity }, code) : [];
  await transact(
    replace({ ...order, state, providerId: remote?.id, url: undefined, tickets,
      paidAt: paid ? remote?.completed_at ?? remote?.updated_at ?? new Date().toISOString() : undefined }),
    replace({ ...event, reserved: event.reserved - order.quantity, sold: event.sold + (paid ? order.quantity : 0) }),
    ...tickets.map(ticket => put({ pk: 'ticket#' + ticket, kind: 'ticket', orderId: order.id, eventId: event.id })),
    ...(paid ? [put({ pk: 'mail#' + order.id, kind: 'mail', orderId: order.id, created: Date.now() })] : []),
  );
}

export async function syncRemote(remote: RemoteOrder) {
  if (remote.type === 'refund') {
    if (remote.state === 'completed' && remote.related_order_id) await syncRefund(remote, await retrieve(remote.related_order_id));
    return;
  }
  if (remote.type !== 'payment') return;
  const id = remote.merchant_order_data?.reference;
  if (!id) return;
  const order = await get<Order>(orderKey(id));
  if (!order || !['creating', 'pending'].includes(order.state)) return;
  if (remote.currency !== 'EUR' || remote.amount !== order.amount || (order.providerId && order.providerId !== remote.id))
    throw new Error('Revolut order does not match local order');
  if (remote.state === 'completed') return finish(order, 'paid', remote);
  if (['failed', 'cancelled'].includes(remote.state)) return finish(order, 'expired', remote);
  const url = remote.checkout_url;
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['checkout.revolut.com', 'sandbox-checkout.revolut.com'].includes(parsed.hostname))
      throw new Error('Unexpected checkout host');
  }
  if (order.state === 'creating' || (!order.url && url))
    await transact(replace({ ...order, state: 'pending', providerId: remote.id, url }));
}

async function syncRefund(remote: RemoteOrder, original: RemoteOrder) {
  const id = original.merchant_order_data?.reference;
  if (!id) return;
  const order = await get<Order>(orderKey(id));
  if (!order) return;
  if (order.state === 'creating' || order.state === 'pending') {
    if (original.state !== 'completed') throw new Error('Original payment has not reached its completed state');
    await syncRemote(original);
    return syncRefund(remote, original);
  }
  if (order.providerId !== original.id || !['paid', 'refunded'].includes(order.state)) return;
  const key = 'refund#' + remote.id;
  if (await get<Refund>(key)) return;
  if (remote.currency !== 'EUR' || remote.amount <= 0 || order.refunded + remote.amount > order.amount)
    throw new Error('Unexpected refund amount or currency');
  const refunded = order.refunded + remote.amount;
  const full = refunded === order.amount;
  const refund: Refund = { pk: key, kind: 'refund', orderId: id, eventId: order.eventId, providerId: remote.id,
    amount: remote.amount, completedAt: remote.completed_at ?? remote.updated_at ?? new Date().toISOString() };
  const event = await get<Event>('event#' + order.eventId);
  await transact(put(refund), replace({ ...order, refunded, review: remote.amount !== order.amount,
    state: full ? 'refunded' : 'paid' }),
    ...(full && event && open(event) ? [replace({ ...event, sold: event.sold - (order.quantity - order.checked) })] : []),
  );
}

export async function reconcileOrder(order: Order) {
  if (order.providerId) return syncRemote(await retrieve(order.providerId));
  if (Date.now() - order.created < 60_000) return;
  const { orders } = await list(new URLSearchParams({ merchant_order_data_reference: order.id }));
  if (orders.length > 1) throw new Error('Multiple Revolut orders for one reference');
  if (orders[0]) await syncRemote(await retrieve(orders[0].id));
  // An empty lookup after an ambiguous POST does not prove that Revolut rejected it.
  // Keep the reservation and alert staff rather than creating another payable order.
}
