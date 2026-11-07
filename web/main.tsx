import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, completeLogin, euro, message, send, when, type Listing } from './client';
import { Staff } from './staff';
import './style.css';

type Config = { seller: string; organizer: string; policies: string; checkoutEnabled: boolean };
const params = new URLSearchParams(location.search);
const detail = params.get('event');
const orderToken = params.get('order');
function Shop() {
  const [data, setData] = useState<(Config & { events?: Listing[]; event?: Listing })>();
  const [error, setError] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<NonNullable<typeof data>>(detail ? '/api/events/' + encodeURIComponent(detail) : '/api/events').then(setData).catch(error => setError(message(error))); }, []);
  async function buy(event: FormEvent) {
    event.preventDefault();
    if (busy || !detail) return;
    setBusy(true); setError('');
    const key = 'tixy.checkout';
    try {
      const fingerprint = JSON.stringify([detail, quantity, email.trim().toLowerCase()]);
      const prior = JSON.parse(sessionStorage.getItem(key) || 'null');
      const retryKey = prior?.fingerprint === fingerprint ? prior.retryKey : crypto.randomUUID();
      sessionStorage.setItem(key, JSON.stringify({ fingerprint, retryKey }));
      const result = await api<{ checkoutUrl?: string; token: string }>('/api/checkout', send({ eventId: detail, quantity, email: email.trim(), retryKey }));
      location.assign(result.checkoutUrl || '/?order=' + encodeURIComponent(result.token));
    } catch (error) { setError(message(error)); setBusy(false); }
  }
  if (!data) return <p role="status">{error || 'Loading events…'}</p>;
  if (data.event) {
    const event = data.event;
    return <><a className="back" href="/">← All events</a><article className="panel">
      <span className="eyebrow">General admission</span><h1>{event.title}</h1>
      <p className="meta">{when(event)} · {event.venue}</p><p className="description">{event.description}</p>
      {data.organizer && <p>Organized by {data.organizer}</p>}
      <p className="price">{euro(event.price)} <small>per ticket</small></p>
      {data.checkoutEnabled && event.available > 0 ? <form onSubmit={buy}>
        <label>Tickets<select value={quantity} onChange={e => setQuantity(Number(e.target.value))}>
          {Array.from({ length: Math.min(event.available, 10) }, (_, i) => <option key={i}>{i + 1}</option>)}
        </select></label>
        <label>Email for your tickets<input type="email" value={email} onChange={e => setEmail(e.target.value)} required maxLength={254} autoComplete="email"/></label>
        <p><strong>Total {euro(quantity * event.price)}</strong></p>
        <p className="meta">Sold by {data.seller}. <a href={data.policies}>Purchase policies</a></p>
        <button disabled={busy}>{busy ? 'Preparing checkout…' : 'Continue to Revolut'}</button>
      </form> : <p role="status">{event.available > 0 ? 'Checkout is currently closed.' : 'Tickets are unavailable.'}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </article></>;
  }
  return <><section className="hero"><span className="eyebrow">Your next night out</span><h1>Find your next event.</h1><p>Get tickets for upcoming events and receive them straight to your inbox.</p></section>
    <h2>Upcoming events</h2><div className="grid">{data.events?.map(event => <article className="panel card" key={event.id}>
      <span className="eyebrow">{event.available ? 'General admission' : 'Sold out'}</span><h3>{event.title}</h3>
      <p>{when(event)}</p><p className="meta">{event.venue}</p><strong>{euro(event.price)}</strong>
      <a className="button" href={'/?event=' + event.id}>View event</a>
    </article>)}</div>{!data.events?.length && <p className="panel">There are no upcoming events on sale right now.</p>}</>;
}

function OrderStatus({ token }: { token: string }) {
  const [result, setResult] = useState<{ state: string; checkoutUrl?: string; quantity: number }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<NonNullable<typeof result>>('/api/orders/' + encodeURIComponent(token));
        if (stopped) return;
        setResult(next); setError('');
        if (['creating', 'pending'].includes(next.state)) timer = setTimeout(poll, 5000);
      } catch (error) { if (!stopped) setError(message(error)); }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [token]);
  useEffect(() => {
    if (result && ['paid', 'expired', 'refunded'].includes(result.state)) sessionStorage.removeItem('tixy.checkout');
  }, [result?.state]);
  return <section className="panel"><h1>Order status</h1><div aria-live="polite">
    {error ? <p className="error">{error} <button onClick={() => location.reload()}>Retry</button></p>
      : result?.state === 'paid' ? <p>Payment confirmed. Your {result.quantity === 1 ? 'ticket is' : 'tickets are'} being sent to your email.</p>
      : result?.state === 'refunded' ? <p>Your order was refunded. The tickets are void.</p>
      : result?.state === 'expired' ? <p>This checkout expired. You can start a new purchase from the event page.</p>
      : <p>Waiting for payment confirmation. You can bookmark this private status link.</p>}
  </div>{result?.checkoutUrl && <a className="button" href={result.checkoutUrl}>Resume checkout</a>}</section>;
}

function App() {
  const [staff, setStaff] = useState(params.has('staff'));
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    if (params.has('code') || params.has('error')) {
      history.replaceState({}, '', '/?staff');
      completeLogin(params).catch(error => setAuthError(message(error))).finally(() => setStaff(true));
    }
  }, []);
  return <><header><a className="brand" href="/">tixy<span>.</span></a><a href="/?staff">Staff access</a></header>
    <main>{authError && <p role="alert" className="error">{authError}</p>}
      {staff ? <Staff/> : orderToken ? <OrderStatus token={orderToken}/> : <Shop/>}</main>
    <footer>Tixy · Event tickets</footer></>;
}

createRoot(document.getElementById('root')!).render(<App/>);
