import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Administration des comptes.
 *
 * Seul endroit qui manipule la clé `service_role` : elle ne doit jamais être
 * exposée au navigateur. Chaque appel est authentifié avec le jeton du compte
 * appelant, puis autorisé en relisant son rôle en base.
 *
 * Ce module est partagé par le serveur Express local et la fonction serverless
 * Vercel, pour que les deux environnements appliquent exactement les mêmes règles.
 */

export type AdminResult = { status: number; body: unknown }

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const admin = (): SupabaseClient =>
  createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

type Caller = { id: string; email: string }

async function authorize(token: string): Promise<Caller> {
  if (!token) throw new HttpError(401, 'Jeton manquant.')
  const client = admin()
  const { data, error } = await client.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Session invalide.')

  const { data: profile } = await client.from('profiles').select('role, active').eq('id', data.user.id).single()
  if (!profile?.active) throw new HttpError(403, 'Compte désactivé.')
  if (profile.role !== 'admin') throw new HttpError(403, 'Réservé aux administrateurs.')
  return { id: data.user.id, email: data.user.email ?? '' }
}

async function listMembers() {
  const { data, error } = await admin().from('profiles').select('*').order('created_at', { ascending: true })
  if (error) throw new HttpError(500, error.message)
  return { members: data ?? [] }
}

async function createMember(body: Record<string, unknown>) {
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const fullName = String(body.full_name ?? '').trim()
  const role = body.role === 'admin' ? 'admin' : 'user'

  if (!email.includes('@')) throw new HttpError(400, 'Email invalide.')
  if (password.length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères.')

  const client = admin()
  const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } })
  if (error || !data.user) throw new HttpError(400, error?.message ?? 'Création impossible.')

  // Le déclencheur a créé le profil ; on applique ensuite le rôle voulu par l'admin.
  const { data: profile, error: profileError } = await client
    .from('profiles')
    .upsert({ id: data.user.id, email, full_name: fullName, role, active: true })
    .select()
    .single()
  if (profileError) throw new HttpError(500, profileError.message)
  return { member: profile }
}

async function updateMember(body: Record<string, unknown>, caller: Caller) {
  const id = String(body.id ?? '')
  if (!id) throw new HttpError(400, 'Compte manquant.')

  const client = admin()
  const patch: Record<string, unknown> = {}
  if (typeof body.full_name === 'string') patch.full_name = body.full_name.trim()
  if (body.role === 'admin' || body.role === 'user') patch.role = body.role
  if (typeof body.active === 'boolean') patch.active = body.active

  if (id === caller.id && (patch.role === 'user' || patch.active === false)) {
    throw new HttpError(400, 'Tu ne peux pas retirer tes propres droits administrateur.')
  }

  if (typeof body.password === 'string' && body.password) {
    if (body.password.length < 8) throw new HttpError(400, 'Le mot de passe doit faire au moins 8 caractères.')
    const { error } = await client.auth.admin.updateUserById(id, { password: body.password })
    if (error) throw new HttpError(400, error.message)
  }

  if (Object.keys(patch).length === 0) return { member: null }

  const { data, error } = await client.from('profiles').update(patch).eq('id', id).select().single()
  if (error) throw new HttpError(500, error.message)
  return { member: data }
}

async function deleteMember(body: Record<string, unknown>, caller: Caller) {
  const id = String(body.id ?? '')
  if (!id) throw new HttpError(400, 'Compte manquant.')
  if (id === caller.id) throw new HttpError(400, 'Tu ne peux pas supprimer ton propre compte.')

  const { error } = await admin().auth.admin.deleteUser(id)
  if (error) throw new HttpError(400, error.message)
  return { deleted: id }
}

/** Point d'entrée commun : le transport (Express ou Vercel) ne fait que passer la méthode, le jeton et le corps. */
export async function handleAdminUsers(method: string, token: string, body: Record<string, unknown>): Promise<AdminResult> {
  if (!supabaseUrl || !serviceRoleKey) {
    return { status: 503, body: { error: 'Administration indisponible : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY doivent être définis (Vercel, ou .env.local en développement).' } }
  }
  try {
    const caller = await authorize(token)
    switch (method) {
      case 'GET': return { status: 200, body: await listMembers() }
      case 'POST': return { status: 201, body: await createMember(body) }
      case 'PATCH': return { status: 200, body: await updateMember(body, caller) }
      case 'DELETE': return { status: 200, body: await deleteMember(body, caller) }
      default: return { status: 405, body: { error: 'Méthode non autorisée.' } }
    }
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { error: error.message } }
    console.error('[admin/users]', error)
    return { status: 500, body: { error: 'Erreur serveur.' } }
  }
}
