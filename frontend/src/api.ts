/**
 * api.ts  -  Firebase-backend edition
 *
 * All requests go to relative  /api/...  URLs which Firebase Hosting rewrites
 * to the Cloud Function.  No Supabase client, no VITE_BACKEND_URL, no port 8000.
 *
 * Protected endpoints automatically include the Firebase Auth ID token in the
 * Authorization header so the backend can verify operator permissions.
 */
import type { Action, Device, Reading } from './types';
import { getIdToken } from './firebase';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const BASE = '/api';

async function _fetch<T>(
  path: string,
  options: RequestInit = {},
  signal?: AbortSignal,
  authenticated = false,
): Promise<T> {
  const url = BASE + path;

  // Inject the Firebase ID token for authenticated (protected) endpoints.
  if (authenticated) {
    const token = await getIdToken();
    if (token) {
      const headers = new Headers(options.headers as HeadersInit | undefined);
      headers.set('Authorization', `Bearer ${token}`);
      options = { ...options, headers };
    }
  }

  const res = await fetch(url, { ...options, signal });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

// ── Generic API helper (called by App.tsx) ────────────────────────────────────
export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: string,
): Promise<T> {
  const cleanPath = path.startsWith('/api') ? path.substring(4) : path;
  const verb = (method || (body === undefined ? 'GET' : 'POST')).toUpperCase();
  const options: RequestInit = { method: verb };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  // All API calls that mutate state or read protected data include the auth token.
  const isProtected = verb !== 'GET' || cleanPath.startsWith('/devices') || cleanPath.startsWith('/config');
  return _fetch<T>(cleanPath, options, signal, isProtected);
}

// ── Submit a reading for a given action ──────────────────────────────────────
export async function submit(
  action: Action,
  reading: Reading,
  target?: string,
): Promise<Device> {
  const serial = reading.serial_number;
  if (target && target !== serial) {
    throw new ApiError('Serial mismatch. Capture the selected device.', 409);
  }
  // reading already has capture_token set by the Scanner/App
  return _fetch<Device>(`/readings/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reading),
  }, undefined, true);
}
