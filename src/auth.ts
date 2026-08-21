import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase.js'

export type Role = 'admin' | 'user'
export type Profile = { id: string; email: string; full_name: string; role: Role; active: boolean; created_at: string }

/**
 * Session et profil du compte connecté.
 *
 * Le rôle lu ici sert uniquement à afficher ou masquer l'administration :
 * chaque appel à l'API de mission est revérifié côté serveur avec le jeton.
 */

export type SessionUser = { id: string; email?: string }

/**
 * Jeton conservé en mémoire à la connexion.
 *
 * Certains navigateurs ne restituent pas la session stockée (navigation privée,
 * blocage du stockage, extension de confidentialité). Le client Supabase repart
 * alors sur la clé anonyme, et la lecture du profil ne renvoie plus rien à cause
 * de la RLS. On garde donc le jeton ici pour authentifier explicitement les
 * requêtes, et l'application reste utilisable pour la durée de l'onglet.
 */
let fallbackToken: string | null = null

let scoped: { token: string; client: SupabaseClient } | null = null

/** Client authentifié explicitement avec le jeton gardé en mémoire. */
function scopedClient(): SupabaseClient {
  const token = fallbackToken
  if (!token) return supabase
  if (scoped?.token !== token) {
    scoped = {
      token,
      client: createClient(supabaseUrl, supabaseAnonKey, {
        // Clé de stockage distincte : ce client ne partage pas la session du client principal.
        auth: { autoRefreshToken: false, persistSession: false, storageKey: 'nira-audit-scoped' },
        global: { headers: { Authorization: `Bearer ${token}` } },
      }),
    }
  }
  return scoped.client
}

/**
 * Profil du compte connecté.
 *
 * `known` permet d'enchaîner directement sur la session que vient de renvoyer
 * la connexion, sans repasser par le stockage du navigateur : certaines
 * configurations (navigation privée, blocage du stockage, extension) relisent
 * une session vide juste après une authentification pourtant réussie.
 */
export async function currentProfile(known?: SessionUser): Promise<Profile | null> {
  let user: SessionUser | undefined = known
  if (!user) {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw new Error(`Session illisible : ${sessionError.message}`)
    user = sessionData.session?.user
  }
  if (!user) return null

  // Chemin normal : le client à session persistée. S'il ne rend rien alors qu'une
  // session vient d'être obtenue, c'est que le navigateur ne la conserve pas ;
  // on relit alors le profil avec le jeton gardé en mémoire.
  let { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle()
  if ((error || !data) && fallbackToken) {
    ({ data, error } = await scopedClient().from('profiles').select('*').eq('id', user.id).maybeSingle())
  }
  if (error) throw new Error(`Profil illisible (${error.code ?? 'erreur'}) : ${error.message}`)
  if (!data) {
    throw new Error(`Aucun profil n’est associé à ${user.email}. Exécute supabase/relay-auth.sql dans Supabase.`)
  }
  if (!data.active) throw new Error('Ce compte est désactivé. Contacte un administrateur.')
  return data as Profile
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
  if (error) throw new Error(error.message === 'Invalid login credentials' ? 'Email ou mot de passe incorrect.' : error.message)
  if (!data.user) throw new Error('Connexion refusée par Supabase.')
  fallbackToken = data.session?.access_token ?? null
  return data.user
}

/** Purge une session locale corrompue, pour qu'un rechargement reparte proprement. */
export function clearStoredSession() {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) window.localStorage.removeItem(key)
    }
  } catch { /* stockage indisponible : il n'y a alors rien à purger */ }
}

export async function signOut(): Promise<void> {
  fallbackToken = null
  scoped = null
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
  const token = data.session?.access_token ?? fallbackToken
  if (!token) throw new Error('Session expirée, reconnecte-toi.')
  return token
}

export function onAuthChange(listener: () => void): void {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') listener()
  })
}
