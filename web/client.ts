const staffToken = 'tixy.staff';
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const session = sessionStorage.getItem(staffToken);
  if (path.startsWith('/api/staff/') && session) headers.set('authorization', 'Bearer ' + session);
  const result = await fetch(path, { ...init, headers, cache: 'no-store' });
  if (!result.ok) {
    if (result.status === 401 && path.startsWith('/api/staff/')) {
      sessionStorage.removeItem(staffToken);
      throw new Error('Your staff session expired. Sign in again.');
    }
    const error = await result.json().catch(() => ({}));
    throw new Error(error.error || 'The request could not be completed.');
  }
  return result.headers.get('content-type')?.startsWith('text/csv') ? await result.text() as T : await result.json();
}
export const send = (body: object, method = 'POST') => ({ method, body: JSON.stringify(body) });
export const hasSession = () => !!sessionStorage.getItem(staffToken);
const config = () => api<{ cognito: string; clientId: string }>('/config.json');
const callback = () => location.origin + '/';
function random() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
export async function login() {
  const { cognito, clientId } = await config();
  const verifier = random();
  const state = random();
  sessionStorage.setItem('tixy.pkce', JSON.stringify({ verifier, state }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  location.assign(cognito + '/oauth2/authorize?' + new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: callback(), scope: 'openid',
    state, code_challenge: challenge, code_challenge_method: 'S256',
  }));
}
export async function completeLogin(params: URLSearchParams) {
  const flow = JSON.parse(sessionStorage.getItem('tixy.pkce') || 'null');
  sessionStorage.removeItem('tixy.pkce');
  if (!flow || flow.state !== params.get('state') || !params.get('code')) throw new Error('Sign-in could not be verified.');
  const { cognito, clientId } = await config();
  const response = await fetch(cognito + '/oauth2/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback(),
    code: params.get('code')!, code_verifier: flow.verifier,
  }) });
  if (!response.ok) throw new Error('Sign-in could not be completed.');
  const { access_token } = await response.json();
  sessionStorage.setItem(staffToken, access_token);
}
export async function logout() {
  sessionStorage.removeItem(staffToken);
  const { cognito, clientId } = await config();
  location.assign(cognito + '/logout?' + new URLSearchParams({ client_id: clientId, logout_uri: callback() }));
}
export type Listing = { id: string; title: string; description: string; venue: string; startsAt: string; timezone: string; price: number; available: number };
export const euro = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const when = (event: Listing) => new Intl.DateTimeFormat('en', {
  dateStyle: 'full', timeStyle: 'short', timeZone: event.timezone,
}).format(new Date(event.startsAt));
export const message = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
