import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, hasSession, login, logout, message, send, when, type Listing } from './client';

type StaffEvent = Listing & { state: 'draft' | 'published' | 'closed'; capacity: number; sold: number; reserved: number };
const blank = { title: '', description: '', venue: '', startsAt: '', timezone: 'Europe/Bucharest', price: 1000, capacity: 100, state: 'draft' };

export function Staff() {
  const [data, setData] = useState<{ events: StaffEvent[]; admin: boolean }>();
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState('');
  const [ticket, setTicket] = useState('');
  const [scan, setScan] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef(false);
  const current = data?.events.find(event => event.id === editing);
  const refresh = () => api<NonNullable<typeof data>>('/api/staff/events').then(setData);
  useEffect(() => { if (hasSession()) refresh().catch(error => setError(message(error))); }, []);

  async function run(action: () => Promise<void>) {
    setError(''); setResult(''); setBusy(true);
    try { await action(); } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function admit(code: string) {
    if (pending.current) return;
    pending.current = true;
    setScan(false);
    await run(async () => {
      await api('/api/staff/check-in', send({ eventId: selected, code: code.trim() }));
      setTicket(''); setResult('Admitted.');
    });
    pending.current = false;
  }

  useEffect(() => {
    if (!scan || !video.current) return;
    const element = video.current;
    let stop: (() => void) | undefined;
    let cancelled = false;
    import('@zxing/browser').then(async ({ BrowserQRCodeReader }) => {
      if (cancelled) return;
      const controls = await new BrowserQRCodeReader().decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' } } },
        element, result => { if (!cancelled && result) void admit(result.getText()); });
      if (cancelled) controls.stop(); else stop = () => controls.stop();
    }).catch(error => { if (!cancelled) { setError(message(error)); setScan(false); } });
    return () => { cancelled = true; stop?.(); };
  }, [scan, selected]);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    void run(async () => {
      const result = await api<{ id: string }>('/api/staff/events' + (editing ? '/' + editing : ''), send({
        ...values, price: Math.round(Number(values.price) * 100), capacity: Number(values.capacity),
        startsAt: new Date(String(values.startsAt)).toISOString(),
      }, editing ? 'PUT' : 'POST'));
      await refresh(); setEditing(result.id); setResult('Event saved.');
    });
  }

  function exportSales(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new URLSearchParams();
    new FormData(event.currentTarget).forEach((value, name) => query.set(name, String(value)));
    void run(async () => {
      const text = await api<string>('/api/staff/sales.csv?' + query);
      const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'tixy-sales.csv'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  return <><div className="heading"><h1>Staff access</h1>{hasSession() && <button className="secondary" onClick={() => void run(logout)}>Sign out</button>}</div>
    {!hasSession() && <button disabled={busy} onClick={() => void run(login)}>Staff sign-in</button>}
    {error && <p role="alert" className="notice error">{error}</p>}{result && <p role="status" className="notice">{result}</p>}
    {data && <div className="grid staff">
      <section className="panel"><h2>Door check-in</h2>
        <label>Event<select value={selected} onChange={event => { setSelected(event.target.value); setScan(false); setResult(''); setError(''); }}>
          <option value="">Select an event</option>{data.events.filter(event => event.state !== 'draft').map(event =>
            <option key={event.id} value={event.id}>{event.title} · {when(event)}</option>)}
        </select></label>
        <button disabled={!selected || busy} onClick={() => setScan(!scan)}>{scan ? 'Stop camera' : 'Scan QR code'}</button>
        {scan && <video ref={video} muted playsInline />}
        <form onSubmit={event => { event.preventDefault(); void admit(ticket); }}>
          <label>Printed ticket code<input value={ticket} onChange={event => setTicket(event.target.value)} required maxLength={40}/></label>
          <button disabled={!selected || busy}>Check in</button>
        </form>
      </section>
      {data.admin && <>
        <section className="panel"><h2>Manage events</h2>
          <label>Edit or create<select value={editing} onChange={event => setEditing(event.target.value)}>
            <option value="">New event</option>{data.events.map(event => <option value={event.id} key={event.id}>{event.title} ({event.state})</option>)}
          </select></label>
          {current && <p>{current.sold} sold · {current.reserved} reserved</p>}
          <EventForm key={editing + ':' + (current as (StaffEvent & { rev?: number }) | undefined)?.rev} event={current} busy={busy} save={save}/>
        </section>
        <section className="panel"><h2>Sales export</h2><form onSubmit={exportSales}>
          <label>Event<select required name="eventId"><option value="">Select an event</option>{data.events.map(event =>
            <option value={event.id} key={event.id}>{event.title}</option>)}</select></label>
          <label>From (UTC)<input type="date" required name="from"/></label><label>To (UTC)<input type="date" required name="to"/></label>
          <button disabled={busy}>Download CSV</button>
        </form></section>
        <section className="panel"><h2>Resend tickets</h2><form onSubmit={event => {
          event.preventDefault(); const orderId = String(new FormData(event.currentTarget).get('orderId')).trim();
          void run(async () => { await api('/api/staff/resend', send({ orderId })); setResult('Ticket email queued.'); });
        }}><label>Tixy order reference<input name="orderId" required/></label><button disabled={busy}>Resend email</button></form></section>
      </>}
    </div>}
  </>;
}

function EventForm({ event, busy, save }: { event?: StaffEvent; busy: boolean; save: (event: FormEvent<HTMLFormElement>) => void }) {
  const fields = event || blank;
  return <form onSubmit={save}>
    <label>Title<input name="title" defaultValue={fields.title} required maxLength={120}/></label>
    <label>Description<textarea name="description" defaultValue={fields.description} required maxLength={4000}/></label>
    <label>Venue<input name="venue" defaultValue={fields.venue} required maxLength={200}/></label>
    <label>Start time (include offset)<input name="startsAt" defaultValue={fields.startsAt} placeholder="2026-12-05T22:00:00+02:00" required/></label>
    <label>Venue time zone<input name="timezone" defaultValue={fields.timezone} required/></label>
    <label>Price (EUR)<input name="price" type="number" step="0.01" min="1" max="10000" defaultValue={fields.price / 100} required/></label>
    <label>Capacity<input name="capacity" type="number" min="1" max="100000" defaultValue={fields.capacity} required/></label>
    <label>Sales status<select name="state" defaultValue={fields.state}><option value="draft" disabled={!!event && event.state !== 'draft'}>Draft</option>
      <option value="published">Published</option><option value="closed">Closed</option></select></label>
    <button disabled={busy}>Save event</button>
  </form>;
}
