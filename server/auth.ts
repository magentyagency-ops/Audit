import { createClient } from '@supabase/supabase-js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { NextFunction, Request, Response } from 'express'

/**
 * Vérification des sessions Supabase pour l'API de mission.
 *
 * Le navigateur envoie le jeton d'accès du compte connecté ; on le revalide
 * auprès de Supabase, puis on relit le profil pour connaître le rôle et
 * l'activation. Sans cette vérification, l'écran de connexion ne serait qu'un
 * décor : l'API resterait ouverte à qui l'appelle directement.
 */

export type AuthenticatedUser = { id: string; email: string; fullName: string; role: 'admin' | 'user'; active: boolean }

// Mêmes valeurs publiques que le client navigateur (src/supabase.ts) : les
// variables d'environnement priment dès qu'elles sont renseignées.
const defaultSupabaseUrl = 'https://bmguarnqwgqhzhcigdmj.supabase.co'
const defaultSupabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZ3Vhcm5xd2dxaHpoY2lnZG1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMDc0MTIsImV4cCI6MjEwMjU4MzQxMn0.GPxGdpr_Q1rH2OG3GUuQBoQkcPbid81ZNzUElEa9_ow'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || defaultSupabaseUrl
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || defaultSupabaseAnonKey

const store = new AsyncLocalStorage<{ user: AuthenticatedUser }>()
const cache = new Map<string, { user: AuthenticatedUser; expiresAt: number }>()
const cacheTtl = 60_000

/** Routes appelées hors de l'application (redirection OAuth, ouverture d'un document dans le navigateur). */
const publicPaths = [/^\/api\/health$/, /^\/api\/outlook\/callback/, /^\/api\/documents\//]

export function authConfigured() { return Boolean(supabaseUrl && supabaseAnonKey) }

export function currentUser(): AuthenticatedUser {
  const context = store.getStore()
  if (!context) throw Object.assign(new Error('Session requise.'), { status: 401 })
  return context.user
}

export function optionalUser(): AuthenticatedUser | null {
  return store.getStore()?.user ?? null
}

export async function verifyToken(token: string): Promise<AuthenticatedUser> {
  const cached = cache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.user

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw Object.assign(new Error('Session expirée, reconnecte-toi.'), { status: 401 })

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('id, email, full_name, role, active')
    .eq('id', data.user.id)
    .maybeSingle()
  if (profileError) throw Object.assign(new Error(`Profil illisible : ${profileError.message}`), { status: 403 })
  if (!profile) throw Object.assign(new Error('Aucun profil n’est associé à ce compte.'), { status: 403 })
  if (!profile.active) throw Object.assign(new Error('Ce compte est désactivé.'), { status: 403 })

  const user: AuthenticatedUser = {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name || '',
    role: profile.role === 'admin' ? 'admin' : 'user',
    active: Boolean(profile.active),
  }
  cache.set(token, { user, expiresAt: Date.now() + cacheTtl })
  return user
}

export function requireSession(request: Request, response: Response, next: NextFunction) {
  // Monté sur /api : request.path est relatif au point de montage, on compare l'URL complète.
  const path = request.originalUrl.split('?')[0]
  if (publicPaths.some((pattern) => pattern.test(path))) return next()
  if (!authConfigured()) {
    return response.status(503).json({ error: 'Authentification non configurée : renseigne VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY dans .env.local.' })
  }
  const header = request.header('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) return response.status(401).json({ error: 'Session requise. Reconnecte-toi.' })

  void verifyToken(token)
    .then((user) => { store.run({ user }, next) })
    .catch((error: Error & { status?: number }) => response.status(error.status ?? 401).json({ error: error.message }))
}

export function requireAdmin() {
  const user = currentUser()
  if (user.role !== 'admin') throw Object.assign(new Error('Réservé aux administrateurs.'), { status: 403 })
  return user
}
