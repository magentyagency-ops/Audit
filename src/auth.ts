import { supabase } from './supabase.js'

export type Role = 'admin' | 'user'
export type Profile = { id: string; email: string; full_name: string; role: Role; active: boolean; created_at: string }

/**
 * Session et profil du compte connecté.
 *
 * Le rôle lu ici sert uniquement à afficher ou masquer l'administration :
 * chaque appel à l'API de mission est revérifié côté serveur avec le jeton.
 */

export async function currentProfile(): Promise<Profile | null> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) throw new Error(`Session illisible : ${sessionError.message}`)
  const user = sessionData.session?.user
  if (!user) return null

  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if (error) throw new Error(`Profil illisible (${error.code ?? 'erreur'}) : ${error.message}`)
  if (!data) {
    throw new Error(`Aucun profil n’est associé à ${user.email}. Exécute supabase/relay-auth.sql dans Supabase.`)
  }
  if (!data.active) throw new Error('Ce compte est désactivé. Contacte un administrateur.')
  return data as Profile
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.' : error.message)
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut()
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin })
  if (error) throw new Error(error.message)
}

export async function updateOwnPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw new Error(error.message)
}

/** Jeton d'accès transmis à l'API de mission et aux fonctions d'administration. */
export async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Session expirée, reconnecte-toi.')
  return token
}

export function onAuthChange(listener: () => void): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') listener()
  })
}
