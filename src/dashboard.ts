import { accessToken, type Profile, type Role } from './auth.js'
import { activeProfile, bootAuth, isAdmin } from './authGate.js'
import { adminApi } from './adminApi.js'

type ProjectBrief = {
  name: string; client: string; sector: string; missionType: string; objective: string
  scope: string[]; stakeholders: string[]; keyQuestions: string[]; deliverables: string[]; firstSteps: string[]
}
type ProjectStats = { interviews: number; summaries: number; mapNodes: number; documents: number; collaborators: number; openActions: number; lastActivityAt: string | null }
type Project = {
  id: string; name: string; client: string; sector: string; missionType: string; description: string
  brief: ProjectBrief | null; accent: string; archived: boolean; createdBy: string; createdByEmail: string; createdAt: string; updatedAt: string; stats: ProjectStats
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character))

let projects: Project[] = []
let toastTimer: number | undefined

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${await accessToken()}`)
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Une erreur est survenue.' })) as { error?: string }
    throw new Error(payload.error || 'Une erreur est survenue.')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function toast(message: string, error = false) {
  const element = $('#toast')!
  element.textContent = message
  element.classList.toggle('error', error)
  element.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => element.classList.remove('show'), 5000)
}

function confirmDeletion(message: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#confirmDialog')!
  $('#confirmDialogMessage')!.textContent = message
  return new Promise((resolve) => {
    const finish = (confirmed: boolean) => {
      dialog.close()
      $('#confirmDialogButton')!.removeEventListener('click', accept)
      $('#cancelConfirmDialog')!.removeEventListener('click', decline)
      dialog.removeEventListener('cancel', decline)
      resolve(confirmed)
    }
    const accept = () => finish(true)
    const decline = () => finish(false)
    $('#confirmDialogButton')!.addEventListener('click', accept)
    $('#cancelConfirmDialog')!.addEventListener('click', decline)
    dialog.addEventListener('cancel', decline)
    dialog.showModal()
  })
}

const initials = (value: string) => value.split(/[\s—–-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || 'P'

function relativeDate(value: string | null) {
  if (!value) return 'Jamais ouvert'
  const elapsed = Date.now() - new Date(value).getTime()
  const days = Math.floor(elapsed / 86_400_000)
  if (days <= 0) return 'Activité aujourd’hui'
  if (days === 1) return 'Activité hier'
  if (days < 30) return `Activité il y a ${days} jours`
  return `Activité le ${new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value))}`
}

function openProject(id: string) {
  window.location.href = `/workspace.html?project=${encodeURIComponent(id)}`
}

function renderProjects() {
  const grid = $('#projectGrid')!
  const totals = projects.reduce((accumulator, project) => ({
    interviews: accumulator.interviews + project.stats.interviews,
    summaries: accumulator.summaries + project.stats.summaries,
    openActions: accumulator.openActions + project.stats.openActions,
  }), { interviews: 0, summaries: 0, openActions: 0 })
  $('#metricProjects')!.textContent = String(projects.length)
  $('#metricInterviews')!.textContent = String(totals.interviews)
  $('#metricSummaries')!.textContent = String(totals.summaries)
  $('#metricActions')!.textContent = String(totals.openActions)

  const cards = projects.map((project) => {
    const owner = project.createdByEmail ? `par ${project.createdByEmail.split('@')[0]}` : ''
    const chips = [project.missionType, project.sector, owner].filter(Boolean).map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')
    const description = project.brief?.objective || project.description || 'Aucun contexte enregistré pour le moment.'
    return `<article class="project-card glass" style="--accent:${escapeHtml(project.accent)}" data-open="${escapeHtml(project.id)}" role="button" tabindex="0">
      <div class="project-top">
        <div class="project-mark">${escapeHtml(initials(project.name))}</div>
        <div><h2>${escapeHtml(project.name)}</h2><span>${escapeHtml(project.client || 'Client à préciser')}</span></div>
        <button class="project-menu" type="button" data-delete="${escapeHtml(project.id)}" title="Supprimer le projet"><i class="ri-delete-bin-line"></i></button>
      </div>
      <p>${escapeHtml(description)}</p>
      <div class="chips">${chips || '<span class="chip">Nouvelle mission</span>'}</div>
      <div class="project-foot"><span><b>${project.stats.interviews}</b> entretiens · <b>${project.stats.summaries}</b> synthèses · <b>${project.stats.openActions}</b> actions</span><span>${escapeHtml(relativeDate(project.stats.lastActivityAt || project.updatedAt))}</span></div>
    </article>`
  }).join('')

  grid.innerHTML = `${cards}<button class="new-card" type="button" id="newProjectCard"><span><i class="ri-add-circle-line"></i><b>Créer un projet</b><span>Décris la mission en quelques phrases et l’assistant prépare le contexte de départ.</span></span></button>`
  if (!projects.length) {
    grid.insertAdjacentHTML('afterbegin', '<div class="empty glass" style="grid-column:1/-1"><div><i class="ri-compass-3-line"></i><b>Aucun projet pour le moment</b><span>Ton premier espace de mission est à un paragraphe d’ici.</span></div></div>')
  }
  $('#newProjectCard')!.addEventListener('click', () => $<HTMLDialogElement>('#projectDialog')!.showModal())
}

async function loadProjects() {
  const result = await api<{ projects: Project[] }>('/api/projects')
  projects = result.projects
  renderProjects()
  renderProjectSources()
}

/** Liste des audits dont on peut reprendre les collaborateurs (même entreprise, autre mission). */
function renderProjectSources() {
  const select = $<HTMLSelectElement>('#projectSource')
  if (!select) return
  const sources = projects.filter((project) => project.stats.collaborators > 0).sort((a, b) => (a.client || a.name).localeCompare(b.client || b.name, 'fr'))
  select.innerHTML = `<option value="">Nouvelle entreprise</option>${sources.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.client || project.name)} — ${escapeHtml(project.name)} (${project.stats.collaborators} collaborateur${project.stats.collaborators > 1 ? 's' : ''})</option>`).join('')}`
}

async function createProject(event: SubmitEvent) {
  event.preventDefault()
  const button = $<HTMLButtonElement>('#createProjectButton')!
  const description = $<HTMLTextAreaElement>('#projectDescription')!.value.trim()
  const name = $<HTMLInputElement>('#projectName')!.value.trim()
  const sourceProjectId = $<HTMLSelectElement>('#projectSource')?.value || ''
  const label = button.innerHTML
  button.disabled = true
  button.innerHTML = '<span class="spinner"></span>Préparation du contexte…'
  try {
    const result = await api<{ project: Project; briefGenerated: boolean; importedCollaborators: number }>('/api/projects', { method: 'POST', body: JSON.stringify({ description, name, sourceProjectId }) })
    if (!result.briefGenerated) toast('Projet créé sans contexte IA : la clé OpenAI n’est pas configurée.')
    if (result.importedCollaborators) toast(`${result.importedCollaborators} collaborateur${result.importedCollaborators > 1 ? 's' : ''} repris de l’audit précédent.`)
    openProject(result.project.id)
  } catch (error) {
    button.disabled = false
    button.innerHTML = label
    toast(error instanceof Error ? error.message : 'Impossible de créer le projet.', true)
  }
}

async function deleteProject(id: string) {
  const project = projects.find((item) => item.id === id)
  if (!project) return
  const confirmed = await confirmDeletion(`Supprimer « ${project.name} » et toutes ses données (entretiens, synthèses, cartographie) ? Cette action est définitive.`)
  if (!confirmed) return
  await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
  projects = projects.filter((item) => item.id !== id)
  renderProjects()
  toast('Projet supprimé.')
}

let members: Profile[] = []

function renderMembers() {
  const list = $('#memberList')!
  const me = activeProfile()
  list.innerHTML = members.map((member) => {
    const name = member.full_name || member.email
    const self = member.id === me?.id
    return `<article class="member-row${member.active ? '' : ' inactive'}" data-member="${escapeHtml(member.id)}">
      <div class="member-avatar">${escapeHtml(name.slice(0, 2).toUpperCase())}</div>
      <div><b>${escapeHtml(name)}${self ? ' <span class="member-tag">toi</span>' : ''}</b><span>${escapeHtml(member.email)}</span></div>
      <div class="member-actions">
        <select data-role="${escapeHtml(member.id)}"${self ? ' disabled' : ''}><option value="user"${member.role === 'user' ? ' selected' : ''}>Consultant</option><option value="admin"${member.role === 'admin' ? ' selected' : ''}>Administrateur</option></select>
        <button class="btn" type="button" data-toggle-active="${escapeHtml(member.id)}"${self ? ' disabled' : ''}>${member.active ? 'Désactiver' : 'Réactiver'}</button>
        <button class="btn danger" type="button" data-remove-member="${escapeHtml(member.id)}"${self ? ' disabled' : ''}><i class="ri-delete-bin-line"></i></button>
      </div>
    </article>`
  }).join('') || '<div class="empty">Aucun compte pour le moment.</div>'
}

async function loadMembers() {
  const result = await adminApi.list()
  members = result.members
  renderMembers()
}

function showMemberForm(visible: boolean) {
  $('#memberForm')!.hidden = !visible
  $('#memberListActions')!.hidden = visible
}

async function createMember(event: SubmitEvent) {
  event.preventDefault()
  const result = await adminApi.create({
    email: $<HTMLInputElement>('#memberEmail')!.value.trim(),
    password: $<HTMLInputElement>('#memberPassword')!.value,
    full_name: $<HTMLInputElement>('#memberName')!.value.trim(),
    role: $<HTMLSelectElement>('#memberRole')!.value as Role,
  })
  members = [...members, result.member]
  $<HTMLFormElement>('#memberForm')!.reset()
  showMemberForm(false)
  renderMembers()
  toast('Compte créé.')
}

function attachMemberEvents() {
  $('#openMembers')!.addEventListener('click', () => {
    $<HTMLDialogElement>('#membersDialog')!.showModal()
    showMemberForm(false)
    void loadMembers().catch((error) => toast(error.message, true))
  })
  $('#refreshMembers')!.addEventListener('click', () => void loadMembers().catch((error) => toast(error.message, true)))
  $('#addMember')!.addEventListener('click', () => showMemberForm(true))
  $('#cancelMember')!.addEventListener('click', () => showMemberForm(false))
  $<HTMLFormElement>('#memberForm')!.addEventListener('submit', (event) => void createMember(event).catch((error) => toast(error.message, true)))
  $('#memberList')!.addEventListener('change', (event) => {
    const select = (event.target as HTMLElement).closest<HTMLSelectElement>('[data-role]')
    if (!select) return
    void adminApi.update({ id: select.dataset.role!, role: select.value as Role })
      .then(() => { void loadMembers(); toast('Rôle mis à jour.') })
      .catch((error) => toast(error.message, true))
  })
  $('#memberList')!.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const toggle = target.closest<HTMLElement>('[data-toggle-active]')
    if (toggle) {
      const member = members.find((item) => item.id === toggle.dataset.toggleActive)
      if (!member) return
      void adminApi.update({ id: member.id, active: !member.active })
        .then(() => { void loadMembers(); toast(member.active ? 'Compte désactivé.' : 'Compte réactivé.') })
        .catch((error) => toast(error.message, true))
      return
    }
    const remove = target.closest<HTMLElement>('[data-remove-member]')
    if (!remove) return
    const member = members.find((item) => item.id === remove.dataset.removeMember)
    if (!member) return
    void confirmDeletion(`Supprimer définitivement le compte de ${member.full_name || member.email} ?`).then(async (confirmed) => {
      if (!confirmed) return
      await adminApi.remove({ id: member.id })
      members = members.filter((item) => item.id !== member.id)
      renderMembers()
      toast('Compte supprimé.')
    }).catch((error) => toast(error.message, true))
  })
}

function attachEvents() {
  $('#newProjectTop')!.addEventListener('click', () => $<HTMLDialogElement>('#projectDialog')!.showModal())
  $<HTMLFormElement>('#projectForm')!.addEventListener('submit', (event) => void createProject(event))
  document.querySelectorAll<HTMLElement>('[data-close]').forEach((button) => button.addEventListener('click', () => $<HTMLDialogElement>(`#${button.dataset.close}`)!.close()))
  $('#projectGrid')!.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const remove = target.closest<HTMLElement>('[data-delete]')
    if (remove) { event.stopPropagation(); void deleteProject(remove.dataset.delete!).catch((error) => toast(error.message, true)); return }
    const card = target.closest<HTMLElement>('[data-open]')
    if (card) openProject(card.dataset.open!)
  })
  $('#projectGrid')!.addEventListener('keydown', (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-open]')
    if (card && (event as KeyboardEvent).key === 'Enter') openProject(card.dataset.open!)
  })
}

async function start() {
  attachEvents()
  attachMemberEvents()
  await bootAuth({
    notify: (message, error) => toast(message, error),
    onReady: async () => {
      document.querySelectorAll<HTMLElement>('.admin-only').forEach((node) => { node.hidden = !isAdmin() })
      try { await loadProjects() }
      catch (error) { toast(error instanceof Error ? error.message : 'Impossible de charger les projets.', true) }
    },
  })
}

void start()
