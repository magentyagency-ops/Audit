import { accessToken } from './auth.js'
import type { Profile, Role } from './auth.js'

/**
 * Client de la fonction d'administration `/api/admin/users`.
 * Chaque opération est refusée côté serveur si l'appelant n'est pas admin.
 */

async function request<T>(method: string, body?: unknown): Promise<T> {
  const token = await accessToken()
  const response = await fetch('/api/admin/users', {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => null) as { error?: string } | null
  if (!response.ok) throw new Error(payload?.error ?? `Requête refusée (${response.status}).`)
  return payload as T
}

export const adminApi = {
  list: () => request<{ members: Profile[] }>('GET'),
  create: (input: { email: string; password: string; full_name: string; role: Role }) => request<{ member: Profile }>('POST', input),
  update: (input: { id: string; full_name?: string; role?: Role; active?: boolean; password?: string }) => request<{ member: Profile | null }>('PATCH', input),
  remove: (input: { id: string }) => request<{ deleted: string }>('DELETE', input),
}
