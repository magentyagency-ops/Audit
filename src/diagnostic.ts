import { createClient } from '@supabase/supabase-js'
import { supabase, supabaseAnonKey, supabaseUrl } from './supabase.js'

/**
 * Page de diagnostic de la connexion.
 *
 * Chaque étape du parcours réel est rejouée et affichée : configuration lue,
 * authentification, session relue, lecture du profil avec et sans jeton
 * explicite, appel de l'API et disponibilité du stockage local. L'objectif est
 * de rendre visible, sans outils de développement, l'étape exacte qui échoue.
 */

const steps = document.querySelector<HTMLElement>('#steps')!
const report: string[] = []

function log(title: string, detail: string, state: 'ok' | 'ko' | 'wait') {
  const mark = state === 'ok' ? '✓' : state === 'ko' ? '✕' : '…'
  const element = document.createElement('article')
  element.className = `step${state === 'ko' ? ' fail' : ''}`
  element.innerHTML = `<div class="mark ${state}">${mark}</div><div><b>${title}</b><span></span></div>`
  element.querySelector('span')!.textContent = detail
  steps.append(element)
  report.push(`${mark} ${title} — ${detail}`)
}

async function run(event: SubmitEvent) {
  event.preventDefault()
  const button = document.querySelector<HTMLButtonElement>('#run')!
  button.disabled = true
  steps.innerHTML = ''
  report.length = 0
  const email = document.querySelector<HTMLInputElement>('#email')!.value.trim()
  const password = document.querySelector<HTMLInputElement>('#password')!.value

  try {
    log('Navigateur', navigator.userAgent, 'ok')
    log('Configuration Supabase', `${supabaseUrl} · clé ${supabaseAnonKey.slice(0, 12)}…`, supabaseUrl ? 'ok' : 'ko')

    try {
      window.localStorage.setItem('nira-test', '1')
      const readBack = window.localStorage.getItem('nira-test')
      window.localStorage.removeItem('nira-test')
      log('Stockage local', readBack === '1' ? 'écriture et relecture correctes' : 'écriture acceptée mais relecture vide', readBack === '1' ? 'ok' : 'ko')
    } catch (error) {
      log('Stockage local', `indisponible : ${(error as Error).message}`, 'ko')
    }

    const signIn = await supabase.auth.signInWithPassword({ email, password })
    if (signIn.error) { log('Authentification', signIn.error.message, 'ko'); return }
    const token = signIn.data.session?.access_token ?? ''
    log('Authentification', `acceptée pour ${signIn.data.user?.email} · jeton ${token ? 'reçu' : 'ABSENT'}`, token ? 'ok' : 'ko')

    const session = await supabase.auth.getSession()
    log('Session relue par le client', session.data.session ? 'présente' : 'ABSENTE (le navigateur ne la conserve pas)', session.data.session ? 'ok' : 'ko')

    const direct = await supabase.from('profiles').select('id,email,role,active').eq('id', signIn.data.user!.id).maybeSingle()
    log('Profil via le client normal', direct.error ? `erreur ${direct.error.code ?? ''} : ${direct.error.message}` : direct.data ? `${direct.data.email} · rôle ${direct.data.role} · actif ${direct.data.active}` : 'aucune ligne renvoyée', direct.data ? 'ok' : 'ko')

    const scoped = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { autoRefreshToken: false, persistSession: false, storageKey: 'nira-diagnostic' },
      global: { headers: { Authorization: `Bearer ${token}` } },
    })
    const withToken = await scoped.from('profiles').select('id,email,role,active').eq('id', signIn.data.user!.id).maybeSingle()
    log('Profil via le jeton explicite', withToken.error ? `erreur ${withToken.error.code ?? ''} : ${withToken.error.message}` : withToken.data ? `${withToken.data.email} · rôle ${withToken.data.role} · actif ${withToken.data.active}` : 'aucune ligne renvoyée', withToken.data ? 'ok' : 'ko')

    const response = await fetch('/api/projects', { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.text()
    log('API des projets', `${response.status} · ${body.slice(0, 160)}`, response.ok ? 'ok' : 'ko')

    const health = await fetch('/api/health')
    log('API santé', `${health.status} · ${(await health.text()).slice(0, 160)}`, health.ok ? 'ok' : 'ko')

    log('Verdict', direct.data || withToken.data ? 'La chaîne complète fonctionne : l’application doit s’ouvrir.' : 'La lecture du profil échoue — c’est là que l’application s’arrête.', direct.data || withToken.data ? 'ok' : 'ko')
  } catch (error) {
    log('Erreur inattendue', error instanceof Error ? `${error.name} : ${error.message}` : String(error), 'ko')
  } finally {
    button.disabled = false
  }
}

document.querySelector<HTMLFormElement>('#form')!.addEventListener('submit', (event) => void run(event))
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(report.join('\n')); alert('Rapport copié.') }
  catch { alert(report.join('\n')) }
})
