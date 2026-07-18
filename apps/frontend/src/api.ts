// The single seam between the browser and the backend read API. Two shapes, because the
// callers need two different failure contracts:
//
//   apiGet  — throws on any non-2xx or network failure. For reads whose caller treats an
//             error as a hard failure (order history, admin lists).
//   apiTry  — NEVER throws. Returns { ok:false } on any failure, { ok:true, data } on 200.
//             This is the "could not ask" vs "the answer is empty" distinction that
//             lookupProducts / lookupMerchantVoucher depend on. `fetch` REJECTS on a network
//             or CORS failure (unlike supabase-js, which resolved { data:null, error }), so the
//             try/catch here is what turns a rejection back into a sentinel the caller expects.
import { supabase } from './supabase'

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

interface Opts { auth?: boolean }

async function headers(opts?: Opts): Promise<Record<string, string>> {
  if (!opts?.auth) return {}
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}
}

export async function apiGet<T>(path: string, opts?: Opts): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: await headers(opts) })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error || `Request failed: ${res.status}`)
  }
  return (await res.json()) as T
}

export async function apiTry<T>(
  path: string,
  opts?: Opts,
): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: await headers(opts) })
    if (!res.ok) return { ok: false }
    return { ok: true, data: (await res.json()) as T }
  } catch {
    return { ok: false }
  }
}

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE'

// Throwing mutation helper — mirrors apiGet's contract for writes. Callers that must
// stay best-effort (saveCustomerDetails) wrap this in their own try/catch.
export async function apiSend<T>(path: string, method: Method, body?: unknown, opts?: Opts): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(await headers(opts)) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(b.error || `Request failed: ${res.status}`)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}
