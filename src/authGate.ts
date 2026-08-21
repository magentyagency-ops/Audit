import { currentProfile, onAuthChange, sendPasswordReset, signIn, signOut, updateOwnPassword, type Profile } from './auth.js'

/**
 * Écran de connexion partagé par le tableau de bord et l'espace de mission.
 *
 * L'application n'est révélée qu'une fois la session lue et le profil actif :
 * l'API de mission revérifie de toute façon le jeton à chaque appel.
 */

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)

let profile: Profile | null = null
let starting = false

export function activeProfile() { return profile }
export function isAdmin() { return profile?.role === 'admin' }

function showAuthScreen(message?: string) {
  $('#authScreen')!.hidden = false
  $('#app')!.hidden = true
  $('#launchScreen')?.classList.add('done')
  const error = $('#authError')!
  if (message === undefined) return
  error.hidden = !message
  error.textContent = message ?? ''
}

function showApp() {
  $('#authScreen')!.hidden = true
  $('#app')!.hidden = false
}

function renderAccount() {
  if (!profile) return
  const name = profile.full_name || profile.email
  $('#accountAvatar')!.textContent = name.slice(0, 2).toUpperCase()
  $('#accountName')!.textContent = name
  $('#accountRole')!.textContent = profile.role === 'admin' ? 'Administrateur' : 'Consultant'
  $('#accountEmail')!.textContent = profile.email
  document.querySelectorAll<HTMLElement>('.admin-only').forEach((node) => { node.hidden = profile!.role !== 'admin' })
}

function initLogin(onError: (message: string) => void) {
  const form = $<HTMLFormElement>('#loginForm')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
    const data = new FormData(form)
    if (submit) submit.disabled = true
    try {
      await signIn(String(data.get('email') ?? ''), String(data.get('password') ?? ''))
      $('#authError')!.hidden = true
      await start()
    } catch (error) {
      showAuthScreen((error as Error).message)
    } finally {
      if (submit) submit.disabled = false
    }
  })

  $('#resetPassword')!.addEventListener('click', async () => {
    const email = $<HTMLInputElement>('#loginEmail')!.value.trim()
    if (!email) return showAuthScreen('Saisis d’abord ton email, le lien de réinitialisation y sera envoyé.')
    try { await sendPasswordReset(email); onError('Email de réinitialisation envoyé.') }
    catch (error) { showAuthScreen((error as Error).message) }
  })
}

function initAccountMenu(notify: (message: string, error?: boolean) => void) {
  const wrap = $('#accountWrap')!
  $('#accountToggle')!.addEventListener('click', (event) => { event.stopPropagation(); wrap.classList.toggle('open') })
  document.addEventListener('click', (event) => { if (!wrap.contains(event.target as Node)) wrap.classList.remove('open') })

  $('#signOut')!.addEventListener('click', async () => { await signOut(); window.location.reload() })

  $('#changePassword')!.addEventListener('click', () => {
    wrap.classList.remove('open')
    $<HTMLInputElement>('#newPassword')!.value = ''
    $<HTMLDialogElement>('#passwordDialog')!.showModal()
  })

  $<HTMLFormElement>('#passwordForm')!.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await updateOwnPassword($<HTMLInputElement>('#newPassword')!.value)
      $<HTMLDialogElement>('#passwordDialog')!.close()
      notify('Mot de passe mis à jour.')
    } catch (error) { notify((error as Error).message, true) }
  })
}

type GateOptions = {
  /** Chargement de l'application une fois le compte authentifié et actif. */
  onReady: (profile: Profile) => Promise<void> | void
  notify: (message: string, error?: boolean) => void
}

let options: GateOptions

async function start() {
  if (starting) return
  starting = true
  try {
    let loaded: Profile | null
    try { loaded = await currentProfile() }
    catch (error) { showAuthScreen((error as Error).message); return }

    if (!loaded) { showAuthScreen(''); return }

    profile = loaded
    showApp()
    renderAccount()
    await options.onReady(loaded)
  } finally { starting = false }
}

export async function bootAuth(gateOptions: GateOptions) {
  options = gateOptions
  initLogin((message) => gateOptions.notify(message))
  initAccountMenu(gateOptions.notify)
  onAuthChange(() => void start())
  await start()
}
