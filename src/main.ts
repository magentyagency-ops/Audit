import { accessToken } from './auth.js'
import { bootAuth, isAdmin } from './authGate.js'

type Theme = 'light' | 'midnight' | 'ocean' | 'sunset'
type InterviewStatus = 'draft' | 'processing' | 'complete' | 'error'
type MapStatus = 'confirmed' | 'verify' | 'friction'

type ActionItem = { task: string; owner: string; deadline: string; priority: 'high' | 'medium' | 'low' }
type InterviewSummary = {
  executiveSummary: string
  keyPoints: string[]
  decisions: string[]
  painPoints: string[]
  processes: string[]
  systems: string[]
  risks: string[]
  openQuestions: string[]
  actionItems: ActionItem[]
  notableQuotes: string[]
  followUpQuestions: string[]
}
type ProjectSummary = {
  overview: string
  progress: string[]
  confirmedFindings: string[]
  contradictions: string[]
  priorities: string[]
  nextSteps: string[]
  risks: string[]
}
type InterviewParticipant = { name: string; role: string }
type Interview = {
  id: string; title: string; participant: string; role: string; participants: InterviewParticipant[]; date: string; transcript: string; sourceFile?: string
  status: InterviewStatus; summary?: InterviewSummary; error?: string; createdAt: string; updatedAt: string
}
type MapLane = { id: string; name: string; description: string; order: number }
type MapNode = { id: string; laneId: string; label: string; description: string; owner: string; status: MapStatus; systems: string[]; evidence: string; order: number }
type MapSuggestionNode = { label: string; description: string; owner: string; status: MapStatus; systems: string[]; evidence: string }
type MapSuggestionLane = { name: string; description: string; nodes: MapSuggestionNode[] }
type MapSuggestion = { overview: string; lanes: MapSuggestionLane[] }
type AssistantAction = { type: string; label: string; downloadUrl?: string; viewUrl?: string; openUrl?: string; filename?: string }
type AssistantMessage = { id: string; role: 'user' | 'assistant'; content: string; actions?: AssistantAction[]; attachmentName?: string; createdAt: string }
type AssistantConversation = { id: string; title: string; messages: AssistantMessage[]; createdAt: string; updatedAt: string }
type AssistantConversationListItem = { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }
type MissionAction = { id: string; text: string; done: boolean; source: 'ai' | 'manual'; createdAt: string; updatedAt: string }
type State = { notes: string; theme: Theme; interviews: Interview[]; projectSummary: ProjectSummary | null; projectSummaryUpdatedAt: string | null; mapLanes: MapLane[]; mapNodes: MapNode[]; assistantConversations: AssistantConversation[]; missionActions: MissionAction[]; contextDocuments: ContextDocument[]; collaborators: DirectoryPerson[]; updatedAt: string; project: Project }
type SlackStatus = { configured: boolean; connected: boolean; team?: string; user?: string; botId?: string; error?: string }
type SlackChannel = { id: string; name: string; isPrivate: boolean; purpose: string }
type SlackMessage = { ts: string; text: string; user: string; threadTs: string | null }
type DirectoryPerson = { id: string; name: string; title: string; email: string; sector: string; photo: string }
type OutlookStatus = { configured: boolean; connected: boolean; account?: string; name?: string; redirectUri: string }
type CalendarEvent = { id: string; subject: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName?: string }; bodyPreview?: string; participant?: string; role?: string; isAllDay?: boolean }
type ContextDocument = { id: string; name: string; mimeType: string; size: number; extractedText?: string; createdAt: string }

import { exportTranscripts } from './exportTranscripts.js'

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => Array.from(document.querySelectorAll<T>(selector))
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] ?? character))
// Les liens sont relatifs depuis le port au port ; les anciennes actions enregistrées portent encore l'URL absolue du serveur local.
const documentUrl = (value: string) => value.replace('http://127.0.0.1:3001', '')
const documentOpenUrl = (action: AssistantAction) => documentUrl(action.openUrl || (action.viewUrl || action.downloadUrl || '').replace(/\/view$/, '/open'))
const formatDate = (value: string) => value ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`)) : 'Date non renseignée'
const launchStartedAt = performance.now()

function finishLaunch() {
  const screen = $('#launchScreen')
  const status = $('#launchStatus')
  if (!screen) return
  if (status) status.textContent = 'Espace prêt'
  window.setTimeout(() => screen.classList.add('done'), Math.max(0, 1200 - (performance.now() - launchStartedAt)))
}

type ProjectBrief = { name: string; client: string; sector: string; missionType: string; objective: string; scope: string[]; stakeholders: string[]; keyQuestions: string[]; deliverables: string[]; firstSteps: string[] }
type Project = { id: string; name: string; client: string; sector: string; missionType: string; description: string; brief: ProjectBrief | null; accent: string; archived: boolean; createdAt: string; updatedAt: string }

const projectStorageKey = 'relay-last-project'
const projectId = new URLSearchParams(window.location.search).get('project') || window.localStorage.getItem(projectStorageKey) || ''
if (!projectId) window.location.replace('/')
window.localStorage.setItem(projectStorageKey, projectId)

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${await accessToken()}`)
  headers.set('X-Project-Id', projectId)
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Une erreur est survenue.' })) as { error?: string }
    throw new Error(payload.error || 'Une erreur est survenue.')
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

let state: State
let activeInterviewId: string | null = null
let notesTimer: number | undefined
let toastTimer: number | undefined
let slackStatus: SlackStatus | null = null
let slackChannels: SlackChannel[] = []
let slackMessages: SlackMessage[] = []
let activeSlackChannelId: string | null = null
let peopleDirectory: DirectoryPerson[] = []
let currentMapSuggestion: MapSuggestion | null = null
let activeAssistantConversationId: string | null = null
let assistantTypingTimer: number | undefined
let interviewEditorOpen = false
let outlookStatus: OutlookStatus | null = null
let calendarEvents: CalendarEvent[] = []
let upcomingCalendarEvents: CalendarEvent[] = []
let calendarAnchor = new Date()
let calendarViewMode: 'month' | 'week' | 'day' = 'month'

function toast(message: string, error = false, undo?: () => Promise<void> | void) {
  const element = $('#toast')!
  element.textContent = ''; element.classList.toggle('error', error)
  const label = document.createElement('span'); label.textContent = message; element.append(label)
  if (undo) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Annuler'; button.addEventListener('click', () => { void Promise.resolve(undo()).then(() => { element.classList.remove('show'); toast('Suppression annulée.') }).catch((reason) => toast(reason instanceof Error ? reason.message : 'Impossible d’annuler.', true)) }); element.append(button)
  }
  element.classList.add('show'); window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => element.classList.remove('show'), 7000)
}

function confirmDeletion(message: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>('#confirmDialog')
  const messageElement = $('#confirmDialogMessage')
  const proceed = $('#confirmDialogButton')
  const cancel = $('#cancelConfirmDialogButton')
  const close = $('#cancelConfirmDialog')
  if (!dialog || !messageElement || !proceed || !cancel || !close) return Promise.resolve(false)
  messageElement.textContent = message
  return new Promise((resolve) => {
    const finish = (confirmed: boolean) => {
      dialog.close()
      proceed.removeEventListener('click', onProceed); cancel.removeEventListener('click', onCancel); close.removeEventListener('click', onCancel); dialog.removeEventListener('cancel', onCancel)
      resolve(confirmed)
    }
    const onProceed = () => finish(true)
    const onCancel = () => finish(false)
    proceed.addEventListener('click', onProceed); cancel.addEventListener('click', onCancel); close.addEventListener('click', onCancel); dialog.addEventListener('cancel', onCancel)
    dialog.showModal()
  })
}

function setButtonLoading(button: HTMLButtonElement, loading: boolean, label?: string) {
  if (loading) { button.dataset.label = button.innerHTML; button.disabled = true; button.innerHTML = `<span class="spinner"></span>${label || 'Traitement…'}` }
  else { button.disabled = false; if (button.dataset.label) button.innerHTML = button.dataset.label }
}

function showView(id: string) {
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === id))
  $$('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.view === id))
  window.scrollTo({ top: 0, behavior: 'smooth' })
  if (id === 'slack') void refreshSlack().catch((error) => toast(error.message, true))
  if (id === 'calendar') void refreshCalendar().catch((error) => toast(error.message, true))
}

function emptyHtml(icon: string, title: string, detail: string, compact = false) {
  return `<div class="empty${compact ? ' compact' : ''}"><div><i class="${icon}"></i><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div></div>`
}

function statusLabel(status: InterviewStatus) {
  return status === 'complete' ? 'Synthétisé' : status === 'processing' ? 'Analyse en cours' : status === 'error' ? 'Erreur' : 'Brouillon'
}

function participantAvatar(name: string, compact = false) {
  const person = peopleDirectory.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase())
  if (!person?.photo) return `<i class="ri-mic-fill"></i>`
  return `<img class="participant-avatar${compact ? ' compact' : ''}" src="${escapeHtml(person.photo)}" alt="${escapeHtml(person.name)}" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'ri-mic-fill'}))">`
}

function projectLists(summary: ProjectSummary) { return [...summary.nextSteps, ...summary.priorities].filter((value, index, array) => array.indexOf(value) === index).slice(0, 10) }

function contextDocumentIcon(mimeType: string) { return mimeType.startsWith('image/') ? 'ri-image-2-line' : mimeType === 'application/pdf' ? 'ri-file-pdf-2-line' : mimeType.includes('sheet') || mimeType.includes('csv') ? 'ri-table-2' : 'ri-file-text-line' }
function formatBytes(size: number) { if (size < 1024) return `${size} B`; if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`; return `${(size / (1024 * 1024)).toFixed(1)} MB` }
function renderDocuments() {
  const target = $('#contextDocumentsList'); if (!target) return
  const documents = state.contextDocuments || []
  target.innerHTML = documents.length ? documents.map((document) => `<article class="context-document-card"><span class="doc-icon"><i class="${contextDocumentIcon(document.mimeType)}"></i></span><h3 title="${escapeHtml(document.name)}">${escapeHtml(document.name)}</h3><p>${escapeHtml(document.mimeType || 'Document')} · ${formatBytes(document.size)}<br>Ajouté le ${new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(document.createdAt))}</p><div class="doc-actions"><span class="status-pill complete"><i class="ri-sparkling-2-line"></i>Contexte IA</span><button class="mini-btn delete-cross" type="button" data-delete-context-document="${escapeHtml(document.id)}" title="Supprimer"><i class="ri-close-line"></i></button></div></article>`).join('') : '<div class="documents-empty"><i class="ri-folder-open-line"></i><b>Aucun document ajouté</b><br>Ajoute un support pour enrichir les réponses et les rapports de l’assistant.</div>'
}
async function uploadContextDocument(file: File) {
  const form = new FormData(); form.append('file', file)
  const document = await api<ContextDocument>('/api/context-documents', { method: 'POST', body: form })
  state.contextDocuments = [document, ...(state.contextDocuments || [])]; renderDocuments(); toast('Document ajouté au contexte de l’IA.')
}
async function deleteContextDocument(id: string) {
  const document = state.contextDocuments.find((item) => item.id === id); if (!document || !await confirmDeletion(`Supprimer « ${document.name} » du contexte IA ?`)) return
  await api(`/api/context-documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); state.contextDocuments = state.contextDocuments.filter((item) => item.id !== id); renderDocuments(); toast('Document retiré du contexte IA.')
}

function renderProjectIdentity() {
  const project = state.project
  if (!project) return
  document.title = `${project.name} — Relay`
  $('#brandProjectName')!.textContent = project.name
  $('#brandProjectClient')!.textContent = project.client || project.missionType || 'Mission'
  $('#missionEyebrow')!.textContent = [project.missionType, project.client].filter(Boolean).join(' · ') || 'Mission'
}

function renderDashboard() {
  const completed = state.interviews.filter((item) => item.status === 'complete').length
  $('#metricInterviews')!.textContent = String(state.interviews.length)
  $('#metricSummaries')!.textContent = String(completed)
  const orderedMeetings = [...upcomingCalendarEvents].sort((a, b) => new Date(a.start.dateTime).getTime() - new Date(b.start.dateTime).getTime())
  const nextMeeting = orderedMeetings.find((item) => new Date(item.end.dateTime).getTime() >= Date.now())
  const nextMeetingTarget = $('#nextMeeting')!
  if (nextMeeting) {
    const start = new Date(nextMeeting.start.dateTime), end = new Date(nextMeeting.end.dateTime), duration = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000))
    const date = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(start).replace(/^./, (letter) => letter.toUpperCase())
    const day = new Intl.DateTimeFormat('fr-FR', { day: '2-digit' }).format(start)
    const month = new Intl.DateTimeFormat('fr-FR', { month: 'short' }).format(start).replace('.', '')
    const time = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(start)
    nextMeetingTarget.innerHTML = `<div class="next-meeting-stack"><button class="next-meeting-card" type="button" data-open-next-meeting="${escapeHtml(nextMeeting.id)}"><span class="next-meeting-avatar">${nextMeeting.participant ? participantAvatar(nextMeeting.participant, true) : '<i class="ri-calendar-event-line"></i>'}</span><span class="next-meeting-copy"><small>Prochain rendez-vous · ${escapeHtml(date)}</small><b>${escapeHtml(nextMeeting.subject || nextMeeting.participant || 'Rendez-vous')}</b><span class="next-meeting-detail"><i class="ri-time-line"></i> ${escapeHtml(time)} · ${duration} min</span></span><time class="next-meeting-date"><strong>${escapeHtml(day)}</strong><span>${escapeHtml(month)}</span></time></button><button class="next-meeting-guide" type="button" data-generate-guide="${escapeHtml(nextMeeting.id)}"><i class="ri-sparkling-2-line"></i>Préparer l’entretien</button></div>`
  } else nextMeetingTarget.innerHTML = '<div class="next-meeting-empty"><i class="ri-calendar-schedule-line"></i><div><b>Aucun rendez-vous à venir</b><span>Planifie le prochain temps fort de ta mission.</span></div></div>'
  $('#dashboardSummary')!.textContent = state.projectSummary?.overview || 'Aucune transcription analysée pour le moment. Le résumé se construira automatiquement après le premier import.'
  const recent = $('#recentInterviews')!
  recent.innerHTML = state.interviews.length ? `<div class="recent-list">${state.interviews.slice(0, 5).map((item) => `<button class="recent-item" data-open-interview="${item.id}" type="button" style="width:100%;border:0;color:inherit;text-align:left;cursor:pointer"><span class="recent-icon">${participantAvatar(item.participant, true)}</span><span><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.participant || 'Participant non renseigné')} · ${formatDate(item.date)}</span></span><em class="status-pill ${item.status}">${statusLabel(item.status)}</em></button>`).join('')}</div>` : emptyHtml('ri-mic-fill', 'Aucun entretien', 'Importe ta première transcription pour démarrer.', true)
  const actions = $('#dashboardActions')!
  const next = state.missionActions || []
  actions.innerHTML = `<div class="action-toolbar"><span>${next.length} action${next.length > 1 ? 's' : ''}</span><button class="btn" id="addAction" type="button"><i class="ri-add-line"></i>Ajouter</button></div>${next.length ? `<div class="recent-list">${next.map((item) => `<div class="recent-item action-item${item.done ? ' done' : ''}" data-action-id="${item.id}"><button class="recent-icon action-toggle" data-action-toggle="${item.id}" type="button" title="${item.done ? 'Marquer à faire' : 'Marquer comme faite'}"><i class="${item.done ? 'ri-checkbox-circle-fill' : 'ri-checkbox-blank-circle-line'}"></i></button><button class="action-text" data-action-toggle="${item.id}" type="button"><b>${escapeHtml(item.text)}</b></button><span class="action-controls"><button class="mini-btn" data-edit-action="${item.id}" type="button" title="Modifier"><i class="ri-edit-line"></i></button><button class="mini-btn delete-cross" data-delete-action="${item.id}" type="button" title="Supprimer"><i class="ri-close-line"></i></button></span></div>`).join('')}</div>` : emptyHtml('ri-compass-3-line', 'Aucune action', 'Ajoute une action ou analyse un entretien pour en générer.', true)}`
}

type AuditReportResult = { title: string; filename: string; openUrl: string; downloadUrl: string; model: string }
type AuditReportJob = { jobId: string; status: 'processing' }
type AuditReportJobStatus = { status: 'processing' | 'complete' | 'error'; result?: AuditReportResult; error?: string }
const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
async function generateAuditReport() {
  const button = $<HTMLButtonElement>('#generateAuditReport')
  if (!button) return
  try {
    setButtonLoading(button, true, 'Préparation du rapport…')
    const job = await api<AuditReportJob>('/api/audit-report', { method: 'POST' })
    let reportStatus: AuditReportJobStatus
    do {
      await wait(1_500)
      reportStatus = await api<AuditReportJobStatus>(`/api/audit-report/${encodeURIComponent(job.jobId)}`)
      if (reportStatus.status === 'processing') button.innerHTML = '<span class="spinner"></span>Génération du rapport…'
    } while (reportStatus.status === 'processing')
    if (reportStatus.status === 'error' || !reportStatus.result) throw new Error(reportStatus.error || 'La génération du rapport a échoué.')
    const result = reportStatus.result
    const target = $('#auditReportResult')
    if (target) target.innerHTML = `<a class="btn" href="${escapeHtml(result.openUrl)}"><i class="ri-external-link-line"></i>Ouvrir le rapport</a>`
    toast('Rapport d’audit généré avec Terra.')
  } catch (error) { toast(error instanceof Error ? error.message : 'Impossible de générer le rapport.', true) }
  finally { if (document.body.contains(button)) setButtonLoading(button, false) }
}

type InterviewGuideResult = { title: string; filename: string; openUrl: string; downloadUrl: string; eventId: string }
async function generateInterviewGuide(eventId: string, button?: HTMLButtonElement) {
  try {
    if (button) setButtonLoading(button, true, 'Génération…')
    const result = await api<InterviewGuideResult>(`/api/calendar/events/${encodeURIComponent(eventId)}/interview-guide`, { method: 'POST' })
    const link = `<a class="btn primary" href="${escapeHtml(result.openUrl)}"><i class="ri-external-link-line"></i>Ouvrir le guide</a>`
    const guideResult = $('#guideResult')
    if (guideResult && $<HTMLInputElement>('#calendarEventId')!.value === eventId) { guideResult.innerHTML = `<i class="ri-check-line"></i><span>Guide prêt</span>${link}`; guideResult.hidden = false }
    const dashboardButton = document.querySelector<HTMLButtonElement>(`[data-generate-guide="${CSS.escape(eventId)}"]`)
    if (dashboardButton) dashboardButton.outerHTML = `<a class="next-meeting-guide" href="${escapeHtml(result.openUrl)}"><i class="ri-external-link-line"></i>Ouvrir le guide</a>`
    toast('Guide d’entretien généré.')
  } catch (error) { toast(error instanceof Error ? error.message : 'Impossible de générer le guide.', true) }
  finally { if (button && document.body.contains(button)) setButtonLoading(button, false) }
}

async function syncGeneratedActions() { const texts = state.projectSummary ? projectLists(state.projectSummary) : []; if (!texts.length) return; const result = await api<{ actions: MissionAction[] }>('/api/actions/sync', { method: 'POST', body: JSON.stringify({ texts }) }); state.missionActions = result.actions; renderDashboard() }
async function toggleAction(id: string) { const action = state.missionActions.find((item) => item.id === id); if (!action) return; const updated = await api<MissionAction>(`/api/actions/${id}`, { method: 'PUT', body: JSON.stringify({ done: !action.done }) }); state.missionActions = state.missionActions.map((item) => item.id === id ? updated : item); renderDashboard() }
function openActionDialog(action?: MissionAction) { $<HTMLInputElement>('#actionId')!.value = action?.id ?? ''; $<HTMLInputElement>('#actionText')!.value = action?.text ?? ''; $('#actionDialogTitle')!.textContent = action ? 'Modifier l’action' : 'Ajouter une action'; $<HTMLDialogElement>('#actionDialog')!.showModal(); $<HTMLInputElement>('#actionText')!.focus() }
async function saveAction(event: SubmitEvent) { event.preventDefault(); const id = $<HTMLInputElement>('#actionId')!.value; const text = $<HTMLInputElement>('#actionText')!.value; const action = await api<MissionAction>(id ? `/api/actions/${id}` : '/api/actions', { method: id ? 'PUT' : 'POST', body: JSON.stringify({ text }) }); state.missionActions = id ? state.missionActions.map((item) => item.id === id ? action : item) : [action, ...state.missionActions]; $<HTMLDialogElement>('#actionDialog')!.close(); renderDashboard(); toast('Action enregistrée.') }
async function deleteAction(id: string) { const action = state.missionActions.find((item) => item.id === id); if (!action || !await confirmDeletion(`Supprimer l’action « ${action.text} » ?`)) return; const result = await api<{ deleted: MissionAction }>(`/api/actions/${id}`, { method: 'DELETE' }); state.missionActions = state.missionActions.filter((item) => item.id !== id); renderDashboard(); toast('Action supprimée.', false, async () => { await api('/api/actions/restore', { method: 'POST', body: JSON.stringify({ action: result.deleted }) }); state = await api<State>('/api/state'); renderAll() }) }

function interviewParticipants(item: Interview): InterviewParticipant[] {
  return item.participants?.length ? item.participants : item.participant || item.role ? [{ name: item.participant, role: item.role }] : []
}

function participantsShortLabel(item: Interview) {
  const people = interviewParticipants(item)
  if (!people.length) return 'Participant non renseigné'
  const first = people[0].name || 'Participant non renseigné'
  return people.length > 1 ? `${first} +${people.length - 1}` : first
}

function participantsLongLabel(item: Interview) {
  const people = interviewParticipants(item)
  if (!people.length) return 'Participant non renseigné'
  return people.map((person) => person.role ? `${person.name} · ${person.role}` : person.name).join(' — ')
}

function renderInterviewList() {
  $('#interviewCount')!.textContent = `${state.interviews.length} élément${state.interviews.length > 1 ? 's' : ''}`
  const list = $('#interviewList')!
  list.innerHTML = state.interviews.length ? state.interviews.map((item) => `<button class="interview-row${item.id === activeInterviewId ? ' active' : ''}" data-interview-id="${item.id}" type="button"><span class="interview-avatar">${participantAvatar(item.participant)}</span><span><b>${escapeHtml(item.title)}</b><span>${escapeHtml(participantsShortLabel(item))} · ${statusLabel(item.status)}</span></span></button>`).join('') : emptyHtml('ri-inbox-line', 'Aucun entretien', 'Importe une transcription ou crée un entretien.', true)
}

function listBlock(title: string, icon: string, items: string[], field: Exclude<keyof InterviewSummary, 'executiveSummary' | 'actionItems'>, tone = 'blue', wide = false) {
  if (!items.length) return ''
  const payload = encodeURIComponent(JSON.stringify({ title, icon, items, tone }))
  return `<article class="summary-block ${tone}${wide ? ' wide' : ''}" data-summary-section="${payload}" tabindex="0" role="button" aria-label="Ouvrir ${escapeHtml(title)}"><header><span class="summary-block-icon"><i class="${icon}"></i></span><div><h4>${escapeHtml(title)}</h4><p>${items.length > 1 ? 'Éléments identifiés dans l’entretien' : 'Élément identifié dans l’entretien'}</p></div><button class="summary-delete" data-delete-summary-section="${field}" type="button" title="Supprimer cette rubrique" aria-label="Supprimer ${escapeHtml(title)}"><i class="ri-close-line"></i></button><i class="ri-arrow-up-right-line summary-open-icon"></i></header><div class="summary-items">${items.map((item, index) => `<div class="summary-item"><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(item)}</p></div>`).join('')}</div></article>`
}

function renderInterviewSummary(item: Interview) {
  const summary = item.summary!
  const actionItems = summary.actionItems.length ? `<article class="summary-block actions wide"><header><span class="summary-block-icon"><i class="ri-task-line"></i></span><div><h4>Actions à lancer</h4><p>À transformer en prochaines actions de mission</p></div></header><div class="actions-table">${summary.actionItems.map((action) => `<div class="action-row"><b>${escapeHtml(action.task)}</b><span><small>Owner</small>${escapeHtml(action.owner || 'À définir')}</span><span><small>Échéance</small>${escapeHtml(action.deadline || 'À planifier')}</span></div>`).join('')}</div></article>` : ''
  return `<section class="summary-detail"><header class="interview-summary-head"><div class="summary-person"><span class="interview-avatar">${participantAvatar(item.participant)}</span><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(participantsLongLabel(item))} · ${formatDate(item.date)}</p></div></div><div class="summary-actions"><span class="status-pill complete"><i class="ri-sparkling-2-line"></i>Synthèse prête</span><button class="btn" id="openInterviewEditor" type="button"><i class="ri-edit-line"></i>Modifier l’entretien</button><button class="mini-btn delete-cross" id="deleteInterview" type="button" title="Supprimer cet entretien"><i class="ri-close-line"></i></button></div></header><div class="summary-bento"><article class="summary-lead"><small>Executive summary</small><p>${escapeHtml(summary.executiveSummary)}</p></article></div><div class="summary-grid">${listBlock('Points clés','ri-key-2-line',summary.keyPoints,'keyPoints','blue',true)}${listBlock('Décisions','ri-scales-3-line',summary.decisions,'decisions','green')}${listBlock('Points de friction','ri-error-warning-line',summary.painPoints,'painPoints','amber')}${listBlock('Processus décrits','ri-route-line',summary.processes,'processes','blue',true)}${listBlock('Systèmes cités','ri-stack-line',summary.systems,'systems','slate')}${listBlock('Risques','ri-shield-flash-line',summary.risks,'risks','red')}${listBlock('Questions ouvertes','ri-question-line',summary.openQuestions,'openQuestions','slate')}${listBlock('Questions de suivi','ri-question-answer-line',summary.followUpQuestions,'followUpQuestions','blue')}${listBlock('Citations notables','ri-double-quotes-l',summary.notableQuotes,'notableQuotes','slate',true)}${actionItems}</div></section>`
}

function renderInterviewEditor(item: Interview) {
  const statusClass = item.status
  return `<header class="interview-editor-head"><div><h2>Modifier l’entretien</h2><p>Les modifications sont enregistrées avant chaque analyse.</p></div><div class="summary-actions">${item.summary ? '<button class="btn" id="closeInterviewEditor" type="button"><i class="ri-arrow-left-line"></i>Voir la synthèse</button>' : ''}<span class="status-pill ${statusClass}">${statusLabel(item.status)}</span><button class="mini-btn delete-cross" id="deleteInterview" type="button" title="Supprimer cet entretien"><i class="ri-close-line"></i></button></div></header><div class="editor-meta two"><div class="field-group"><label for="interviewTitle">Titre</label><input class="field" id="interviewTitle" value="${escapeHtml(item.title)}"></div><div class="field-group"><label for="interviewDate">Date</label><input class="field" id="interviewDate" type="date" value="${escapeHtml(item.date)}"></div></div><section class="participants-block"><header><div><b>Participants</b><span>Un entretien peut réunir plusieurs collaborateurs. Commence à écrire pour rechercher dans les collaborateurs du projet.</span></div><button class="btn" id="addParticipant" type="button"><i class="ri-user-add-line"></i>Ajouter un participant</button></header><div id="participantRows">${(interviewParticipants(item).length ? interviewParticipants(item) : [{ name: '', role: '' }]).map(participantRow).join('')}</div></section><textarea class="transcript-area" id="transcriptText" placeholder="Colle ici la transcription complète…">${escapeHtml(item.transcript)}</textarea>${item.error ? `<p style="color:var(--red);font-size:10px">${escapeHtml(item.error)}</p>` : ''}<div class="editor-actions"><div><button class="btn" id="saveInterview"><i class="ri-save-line"></i>Enregistrer</button></div><button class="btn primary" id="summarizeInterview" ${item.status === 'processing' ? 'disabled' : ''}><i class="ri-sparkling-2-line"></i>${item.status === 'processing' ? 'Analyse en cours…' : item.summary ? 'Actualiser la synthèse' : 'Générer la synthèse'}</button></div>`
}

function renderInterviewDetail() {
  const detail = $('#interviewDetail')!
  const item = state.interviews.find((entry) => entry.id === activeInterviewId)
  if (!item) { detail.innerHTML = emptyHtml('ri-file-add-line', 'Sélectionne ou crée un entretien', 'Tu pourras renseigner le participant, coller une transcription et lancer l’analyse OpenAI.'); return }
  detail.innerHTML = item.summary && !interviewEditorOpen ? renderInterviewSummary(item) : renderInterviewEditor(item)
  $('#openInterviewEditor')?.addEventListener('click', () => { interviewEditorOpen = true; renderInterviewDetail() })
  $('#closeInterviewEditor')?.addEventListener('click', () => { interviewEditorOpen = false; renderInterviewDetail() })
  $('#saveInterview')?.addEventListener('click', () => void saveActiveInterview().catch((error) => toast(error.message, true)))
  $('#summarizeInterview')?.addEventListener('click', () => void summarizeActiveInterview())
  $('#deleteInterview')?.addEventListener('click', () => void deleteActiveInterview().catch((error) => toast(error.message, true)))
  const rows = $('#participantRows')
  rows?.addEventListener('change', (event) => { const input = (event.target as HTMLElement).closest<HTMLInputElement>('.participant-name'); if (input) applyParticipantRole(input) })
  rows?.addEventListener('input', (event) => { const input = (event.target as HTMLElement).closest<HTMLInputElement>('.participant-name'); if (!input) return; renderParticipantMatches(input, input.value); suggestParticipantCompletion(input) })
  rows?.addEventListener('keydown', (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>('.participant-name')
    if (!input || (event.key !== 'Tab' && event.key !== 'Enter')) return
    const selected = input.value.slice(input.selectionStart ?? input.value.length)
    if (!selected) return
    event.preventDefault(); input.setSelectionRange(input.value.length, input.value.length); renderParticipantMatches(input, '')
  })
  rows?.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const suggestion = target.closest<HTMLElement>('[data-person-suggestion]')
    if (suggestion) {
      const input = suggestion.closest('.autocomplete-wrap')?.querySelector<HTMLInputElement>('.participant-name')
      const person = peopleDirectory.find((entry) => entry.name === decodeURIComponent(suggestion.dataset.personSuggestion!))
      if (person && input) { input.value = person.name; const role = participantRoleInput(input); if (role && !role.value.trim()) role.value = person.title; renderParticipantMatches(input, '') }
      return
    }
    const remove = target.closest<HTMLElement>('.participant-remove')
    if (!remove) return
    const row = remove.closest('.participant-row')!
    if (rows!.querySelectorAll('.participant-row').length > 1) row.remove()
    else { row.querySelectorAll('input').forEach((input) => { input.value = '' }) }
  })
  $('#addParticipant')?.addEventListener('click', () => {
    rows?.insertAdjacentHTML('beforeend', participantRow({ name: '', role: '' }))
    rows?.querySelector<HTMLInputElement>('.participant-row:last-child .participant-name')?.focus()
  })
}

function renderInterviews() { renderInterviewList(); renderInterviewDetail() }

function openInterviewPreview(id: string) {
  const item = state.interviews.find((entry) => entry.id === id)
  const dialog = $<HTMLDialogElement>('#interviewPreviewDialog')
  const content = $('#interviewPreviewContent')
  if (!item || !dialog || !content) return
  const summary = item.summary
  content.innerHTML = `<header class="preview-top"><div class="preview-person"><span class="interview-avatar">${participantAvatar(item.participant)}</span><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.participant || 'Participant non renseigné')}${item.role ? ` · ${escapeHtml(item.role)}` : ''} · ${formatDate(item.date)}</p></div></div><button class="icon-btn" id="closeInterviewPreview" type="button" aria-label="Fermer"><i class="ri-close-line"></i></button></header>${summary ? `<section class="preview-executive"><small>Executive summary</small><p>${escapeHtml(summary.executiveSummary)}</p></section><div class="preview-insights"><article class="preview-insight"><i class="ri-key-2-line"></i><b>${summary.keyPoints.length}</b><span>points clés</span></article><article class="preview-insight"><i class="ri-error-warning-line"></i><b>${summary.painPoints.length}</b><span>frictions</span></article><article class="preview-insight"><i class="ri-task-line"></i><b>${summary.actionItems.length}</b><span>actions</span></article></div>` : `<div class="preview-empty"><i class="ri-file-text-line"></i>La synthèse n’est pas encore disponible. Ouvre l’entretien pour ajouter la transcription ou lancer l’analyse.</div>`}<div class="modal-actions"><button class="btn primary" id="openFullInterview" type="button"><i class="ri-arrow-right-line"></i>${summary ? 'Voir la synthèse complète' : 'Ouvrir l’entretien'}</button></div>`
  $('#closeInterviewPreview')?.addEventListener('click', () => dialog.close())
  $('#openFullInterview')?.addEventListener('click', () => { dialog.close(); activeInterviewId = item.id; interviewEditorOpen = false; renderInterviews(); showView('interviews') })
  if (!dialog.open) dialog.showModal()
}

function openSummarySection(encoded: string) {
  type SummarySectionPayload = { title: string; icon: string; items: string[]; tone: string }
  let section: SummarySectionPayload
  try { section = JSON.parse(decodeURIComponent(encoded)) as SummarySectionPayload } catch { return }
  const dialog = $<HTMLDialogElement>('#summarySectionDialog')
  const content = $('#summarySectionContent')
  if (!dialog || !content) return
  content.innerHTML = `<header class="summary-section-top ${escapeHtml(section.tone)}"><div><span class="summary-section-icon"><i class="${escapeHtml(section.icon)}"></i></span><small>Synthèse d’entretien</small><h2>${escapeHtml(section.title)}</h2><p>${section.items.length} élément${section.items.length > 1 ? 's' : ''} identifié${section.items.length > 1 ? 's' : ''}</p></div><button class="icon-btn" id="closeSummarySection" type="button" aria-label="Fermer"><i class="ri-close-line"></i></button></header><div class="summary-section-list">${section.items.map((item, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><p>${escapeHtml(item)}</p></article>`).join('')}</div>`
  $('#closeSummarySection')?.addEventListener('click', () => dialog.close())
  if (!dialog.open) dialog.showModal()
}

async function deleteSummarySection(field: Exclude<keyof InterviewSummary, 'executiveSummary' | 'actionItems'>) {
  const interview = state.interviews.find((item) => item.id === activeInterviewId)
  if (!interview?.summary) return
  const labels: Record<typeof field, string> = { keyPoints: 'Points clés', decisions: 'Décisions', painPoints: 'Points de friction', processes: 'Processus décrits', systems: 'Systèmes cités', risks: 'Risques', openQuestions: 'Questions ouvertes', notableQuotes: 'Citations notables', followUpQuestions: 'Questions de suivi' }
  const label = labels[field]
  if (!await confirmDeletion(`Supprimer la rubrique « ${label} » de cette synthèse ?`)) return
  const result = await api<{ interview: Interview }>(`/api/interviews/${interview.id}/summary-sections/${field}`, { method: 'DELETE' })
  state.interviews = state.interviews.map((item) => item.id === result.interview.id ? result.interview : item)
  renderInterviews()
  toast(`Rubrique « ${label} » supprimée.`, false, async () => {
    const restored = await api<{ interview: Interview }>(`/api/interviews/${interview.id}/summary-sections/${field}`, { method: 'PUT', body: JSON.stringify({ items: interview.summary?.[field] || [] }) })
    state.interviews = state.interviews.map((item) => item.id === restored.interview.id ? restored.interview : item)
    renderInterviews()
  })
}

function projectSection(title: string, icon: string, items: string[]) {
  if (!items.length) return ''
  return `<section class="project-section glass"><h3><i class="${icon}"></i>${escapeHtml(title)}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`
}

function renderProjectSummary() {
  const target = $('#projectSummary')
  if (!target) return
  const summary = state.projectSummary
  if (!summary) { target.innerHTML = emptyHtml('ri-sparkling-2-line', 'Aucune synthèse stratégique', 'Elle sera créée automatiquement après la première transcription analysée.'); return }
  target.innerHTML = `<section class="project-overview glass"><div class="card-head"><div><h2>Vue d’ensemble</h2><p>${state.projectSummaryUpdatedAt ? `Mise à jour le ${new Intl.DateTimeFormat('fr-FR',{dateStyle:'medium',timeStyle:'short'}).format(new Date(state.projectSummaryUpdatedAt))}` : ''}</p></div><span class="status-pill complete"><i class="ri-sparkling-2-line"></i>OpenAI</span></div><p>${escapeHtml(summary.overview)}</p></section><div class="project-grid" style="margin-top:18px"><div class="grid">${projectSection('Progression','ri-line-chart-line',summary.progress)}${projectSection('Constats confirmés','ri-checkbox-circle-line',summary.confirmedFindings)}${projectSection('Contradictions','ri-git-merge-line',summary.contradictions)}</div><div class="grid">${projectSection('Priorités','ri-focus-3-line',summary.priorities)}${projectSection('Prochaines étapes','ri-arrow-right-circle-line',summary.nextSteps)}${projectSection('Risques','ri-shield-flash-line',summary.risks)}</div></div>`
}

function renderAssistant() {
  const target = $('#assistantMessages')
  if (!target) return
  const conversation = state.assistantConversations?.find((item) => item.id === activeAssistantConversationId)
  const messages = conversation?.messages || []
  target.innerHTML = messages.length ? messages.map((message) => `<article class="assistant-message ${message.role}"><span class="assistant-label">${message.role === 'assistant' ? 'Assistant' : 'Vous'}</span>${message.attachmentName ? `<span class="assistant-attachment"><i class="ri-attachment-2"></i>${escapeHtml(message.attachmentName)}</span>` : ''}${escapeHtml(message.content)}${message.role === 'assistant' && message.actions?.length ? `<div class="assistant-actions">${message.actions.map((action, index) => `<div class="assistant-action"><span>${escapeHtml(action.label)}</span>${action.downloadUrl ? `<a class="btn primary" href="${escapeHtml(documentOpenUrl(action))}"><i class="ri-external-link-line"></i>Ouvrir dans le navigateur</a>` : `<button class="btn primary" data-apply-assistant-action="${message.id}" data-action-index="${index}" type="button">${action.type === 'generate_document' ? 'Générer' : 'Appliquer'}</button>`}</div>`).join('')}</div>` : ''}</article>`).join('') : '<div class="assistant-empty"><div><i class="ri-chat-ai-line"></i><b>Demande-moi où en est la mission.</b><br>Je peux analyser le contexte, te recommander une action ou préparer une modification à confirmer.</div></div>'
  $('#assistantConversationList')!.innerHTML = (state.assistantConversations || []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => `<button class="assistant-conversation${item.id === activeAssistantConversationId ? ' active' : ''}" data-assistant-conversation="${item.id}" type="button"><b>${escapeHtml(item.title)}</b><span>${item.messages.length ? `${item.messages.length} messages` : 'Nouvelle conversation'}</span></button>`).join('')
  target.scrollTop = target.scrollHeight
}

async function selectAssistantConversation(id: string) {
  const conversation = await api<AssistantConversation>(`/api/assistant/conversations/${encodeURIComponent(id)}`)
  const index = state.assistantConversations.findIndex((item) => item.id === id)
  if (index >= 0) state.assistantConversations[index] = conversation
  else state.assistantConversations.unshift(conversation)
  activeAssistantConversationId = id; renderAssistant()
}

async function createAssistantConversation() {
  const conversation = await api<AssistantConversation>('/api/assistant/conversations', { method: 'POST' })
  state.assistantConversations.unshift(conversation); activeAssistantConversationId = conversation.id; renderAssistant(); $<HTMLTextAreaElement>('#assistantInput')!.focus()
}

function showAssistantThinking() {
  const target = $('#assistantMessages')!
  target.insertAdjacentHTML('beforeend', '<article class="assistant-message assistant assistant-thinking" id="assistantThinking"><i></i><i></i><i></i></article>')
  target.scrollTop = target.scrollHeight
}

function revealAssistantMessage(message: AssistantMessage) {
  const target = $('#assistantMessages')!
  $('#assistantThinking')?.remove()
  const holder = document.createElement('article'); holder.className = 'assistant-message assistant'; holder.innerHTML = '<span class="assistant-label">Assistant</span><span class="assistant-message-text"></span>'
  target.append(holder); const text = holder.querySelector<HTMLElement>('.assistant-message-text')!; const full = message.content; let position = 0
  window.clearInterval(assistantTypingTimer)
  assistantTypingTimer = window.setInterval(() => { position = Math.min(full.length, position + Math.max(2, Math.ceil(full.length / 90))); text.textContent = full.slice(0, position); target.scrollTop = target.scrollHeight; if (position >= full.length) { window.clearInterval(assistantTypingTimer); if (message.actions?.length) holder.insertAdjacentHTML('beforeend', `<div class="assistant-actions">${message.actions.map((action, index) => `<div class="assistant-action"><span>${escapeHtml(action.label)}</span>${action.downloadUrl ? `<a class="btn primary" href="${escapeHtml(action.downloadUrl)}" download="${escapeHtml(action.filename || 'document.html')}"><i class="ri-download-2-line"></i>Télécharger</a>` : `<button class="btn primary" data-apply-assistant-action="${message.id}" data-action-index="${index}" type="button">${action.type === 'generate_document' ? 'Générer' : 'Appliquer'}</button>`}</div>`).join('')}</div>`) } }, 18)
}

async function sendAssistantMessage(event: SubmitEvent) {
  event.preventDefault()
  const input = $<HTMLTextAreaElement>('#assistantInput')!
  const content = input.value.trim()
  if (!content) return
  const attachmentInput = $<HTMLInputElement>('#assistantAttachment')
  const attachment = attachmentInput?.files?.[0]
  if (!activeAssistantConversationId) await createAssistantConversation()
  const button = $<HTMLButtonElement>('#assistantSend')!
  try {
    setButtonLoading(button, true, 'Réflexion…'); const conversation = state.assistantConversations.find((item) => item.id === activeAssistantConversationId)!; const optimistic: AssistantMessage = { id: 'pending', role: 'user', content, attachmentName: attachment?.name, createdAt: new Date().toISOString() }; conversation.messages.push(optimistic); input.value = ''; renderAssistant(); showAssistantThinking()
    const form = new FormData(); form.append('content', content); form.append('conversationId', activeAssistantConversationId!); if (attachment) form.append('attachment', attachment)
    const result = await api<{ conversation: AssistantConversation; userMessage: AssistantMessage; assistantMessage: AssistantMessage }>('/api/assistant/chat', { method: 'POST', body: form })
    if (attachmentInput) attachmentInput.value = ''
    $('#assistantFileName')?.classList.remove('visible')
    const index = state.assistantConversations.findIndex((item) => item.id === result.conversation.id); state.assistantConversations[index] = result.conversation; state.assistantConversations[index].messages = result.conversation.messages.slice(0, -1); renderAssistant(); state.assistantConversations[index].messages.push(result.assistantMessage); revealAssistantMessage(result.assistantMessage)
  } catch (error) { $('#assistantThinking')?.remove(); const conversation = state.assistantConversations.find((item) => item.id === activeAssistantConversationId); if (conversation) conversation.messages = conversation.messages.filter((item) => item.id !== 'pending'); renderAssistant(); toast(error instanceof Error ? error.message : 'L’assistant n’a pas pu répondre.', true) }
  finally { setButtonLoading(button, false) }
}

async function applyAssistantAction(messageId: string, index: number, button: HTMLButtonElement) {
  try {
    const action = state.assistantConversations.find((conversation) => conversation.id === activeAssistantConversationId)?.messages.find((message) => message.id === messageId)?.actions?.[index]
    if (action?.type !== 'generate_document' && !window.confirm('Appliquer cette modification à la mission ?')) return
    setButtonLoading(button, true, action?.type === 'generate_document' ? 'Génération…' : 'Application…')
    if (action?.type === 'generate_document') toast('Génération du document en cours…')
    const result = await api<{ state: State; document?: { title: string; filename: string; downloadUrl: string } }>(`/api/assistant/conversations/${encodeURIComponent(activeAssistantConversationId!)}/actions/${encodeURIComponent(messageId)}/${index}/apply`, { method: 'POST' })
    state = result.state
    if (action?.type === 'create_calendar_event' || action?.type === 'update_calendar_event' || action?.type === 'delete_calendar_event') await Promise.all([refreshCalendar(), refreshUpcomingCalendar()])
    renderAll()
    if (result.document) { const link = document.createElement('a'); link.href = result.document.downloadUrl; link.download = result.document.filename; document.body.append(link); link.click(); link.remove(); toast(`Document « ${result.document.title} » généré et téléchargé.`) }
    else toast('Modification appliquée.')
  } catch (error) { toast(error instanceof Error ? error.message : 'Modification impossible.', true) }
  finally { if (document.body.contains(button)) setButtonLoading(button, false) }
}

function renderMap() {
  const board = $('#mapBoard')!
  if (!state.mapLanes.length) { board.innerHTML = emptyHtml('ri-node-tree', 'Cartographie vide', 'Ajoute une première phase, puis construis les étapes réelles de ton processus.'); return }
  board.innerHTML = state.mapLanes.sort((a,b)=>a.order-b.order).map((lane) => {
    const nodes = state.mapNodes.filter((node) => node.laneId === lane.id).sort((a,b)=>a.order-b.order)
    const nodeHtml = nodes.length ? `<div class="nodes">${nodes.map((node) => `<article class="node ${node.status}" data-node-id="${node.id}" tabindex="0"><div class="node-head"><h4>${escapeHtml(node.label)}</h4></div>${node.description ? `<p>${escapeHtml(node.description)}</p>` : ''}<div class="node-meta">${node.owner ? `<span class="chip"><i class="ri-user-line"></i> ${escapeHtml(node.owner)}</span>` : ''}${node.systems.map((system) => `<span class="chip">${escapeHtml(system)}</span>`).join('')}</div><i class="node-status"></i></article>`).join('')}</div>` : emptyHtml('ri-add-box-line','Aucune étape','Ajoute la première étape de cette phase.',true)
    return `<section class="lane glass"><div class="lane-head"><div><h3>${escapeHtml(lane.name)}</h3>${lane.description ? `<p>${escapeHtml(lane.description)}</p>` : ''}</div><div class="lane-actions"><button class="mini-btn" data-add-node="${lane.id}" title="Ajouter une étape"><i class="ri-add-line"></i></button><button class="mini-btn" data-edit-lane="${lane.id}" title="Modifier la phase"><i class="ri-edit-line"></i></button><button class="mini-btn" data-delete-lane="${lane.id}" title="Supprimer la phase"><i class="ri-delete-bin-line"></i></button></div></div>${nodeHtml}</section>`
  }).join('')
  board.querySelectorAll<HTMLElement>('[data-node-id]').forEach((node) => node.querySelector('.node-head')?.insertAdjacentHTML('beforeend', `<button class="mini-btn delete-cross node-delete" data-delete-node="${node.dataset.nodeId}" type="button" title="Supprimer cette étape"><i class="ri-close-line"></i></button>`))
  board.querySelectorAll<HTMLElement>('[data-delete-lane] i').forEach((icon) => { icon.className = 'ri-close-line' })
}

function formatSlackTime(timestamp: string) {
  const value = Number(timestamp) * 1000
  return Number.isFinite(value) ? new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''
}

function renderSlack() {
  const statusTarget = $('#slackStatus')!
  const workspace = $('#slackWorkspace')!
  if (!slackStatus) {
    statusTarget.innerHTML = '<div class="slack-status-inner"><i class="ri-loader-4-line"></i><div><b>Connexion à Slack…</b><span>Vérification de la configuration locale.</span></div></div>'
    workspace.hidden = true
    return
  }
  if (!slackStatus.connected) {
    statusTarget.innerHTML = `<div class="slack-status-inner"><i class="ri-slack-line"></i><div><b>${slackStatus.configured ? 'Slack n’est pas disponible' : 'Slack n’est pas encore connecté'}</b><span>${escapeHtml(slackStatus.error || 'Ajoute le token bot de ta Slack App dans .env.local, puis redémarre l’application.')}</span></div></div>`
    workspace.hidden = true
    return
  }
  statusTarget.innerHTML = `<div class="slack-status-inner"><i class="ri-checkbox-circle-line"></i><div><b>Connecté à ${escapeHtml(slackStatus.team || 'Slack')}</b><span>Le bot lit uniquement les messages directs qui lui sont envoyés · synchronisation automatique toutes les 20 secondes.</span></div></div>`
  workspace.hidden = false
  $('#slackChannelCount')!.textContent = `${slackChannels.length} conversation${slackChannels.length > 1 ? 's' : ''}`
  $('#slackChannels')!.innerHTML = slackChannels.length ? slackChannels.map((channel) => `<button class="slack-channel${channel.id === activeSlackChannelId ? ' active' : ''}" data-slack-channel="${channel.id}" type="button"><i class="ri-message-3-line"></i><span><b>${escapeHtml(channel.name)}</b>${channel.purpose ? `<small>${escapeHtml(channel.purpose)}</small>` : ''}</span></button>`).join('') : '<div class="slack-empty">Aucun message direct reçu par le bot.</div>'
  const current = slackChannels.find((channel) => channel.id === activeSlackChannelId)
  $('#slackChannelTitle')!.textContent = current ? `Messages de ${current.name}` : 'Messages directs'
  $('#slackChannelMeta')!.textContent = current?.purpose || (current ? 'Messages récents envoyés au bot.' : 'Sélectionne une conversation.')
  $('#slackMessages')!.innerHTML = current ? (slackMessages.length ? slackMessages.map((message) => `<article class="slack-message"><b>${escapeHtml(message.user)}</b><span>${escapeHtml(message.text)}</span><time>${escapeHtml(formatSlackTime(message.ts))}${message.threadTs ? ' · Fil de discussion' : ''}</time></article>`).join('') : '<div class="slack-empty">Aucun message récent dans ce canal.</div>') : '<div class="slack-empty">Choisis un canal pour consulter les messages.</div>'
}

async function loadSlackMessages() {
  if (!activeSlackChannelId) { slackMessages = []; return }
  slackMessages = await api<SlackMessage[]>(`/api/slack/messages?channel=${encodeURIComponent(activeSlackChannelId)}`)
}

async function refreshSlack() {
  slackStatus = await api<SlackStatus>('/api/slack/status')
  if (!slackStatus.connected) { slackChannels = []; slackMessages = []; activeSlackChannelId = null; renderSlack(); return }
  slackChannels = await api<SlackChannel[]>('/api/slack/channels')
  if (!activeSlackChannelId || !slackChannels.some((channel) => channel.id === activeSlackChannelId)) activeSlackChannelId = slackChannels[0]?.id ?? null
  await loadSlackMessages()
  renderSlack()
}

async function selectSlackChannel(id: string) {
  activeSlackChannelId = id
  slackMessages = []
  renderSlack()
  await loadSlackMessages()
  renderSlack()
}

function participantRow(person: InterviewParticipant) {
  return `<div class="participant-row"><div class="autocomplete-wrap"><input class="field participant-name" list="peopleSuggestions" autocomplete="off" placeholder="Nom du participant" value="${escapeHtml(person.name)}"><div class="autocomplete-menu"></div></div><input class="field participant-role" placeholder="Rôle" value="${escapeHtml(person.role)}"><button class="mini-btn participant-remove" type="button" title="Retirer ce participant"><i class="ri-close-line"></i></button></div>`
}

function participantMenu(input: HTMLInputElement) {
  return input.closest('.autocomplete-wrap')?.querySelector<HTMLElement>('.autocomplete-menu') ?? null
}

function participantRoleInput(input: HTMLInputElement) {
  return input.closest('.participant-row')?.querySelector<HTMLInputElement>('.participant-role') ?? null
}

function renderPeopleSuggestions() {
  const datalist = $('#peopleSuggestions')
  if (datalist) datalist.innerHTML = peopleDirectory.map((person) => `<option value="${escapeHtml(person.name)}">${escapeHtml(person.title)}${person.sector ? ` · ${escapeHtml(person.sector)}` : ''}</option>`).join('')
}

function renderParticipantMatches(input: HTMLInputElement, value: string) {
  const menu = participantMenu(input)
  if (!menu) return
  const term = value.trim().toLowerCase()
  if (!term) { menu.innerHTML = ''; menu.classList.remove('open'); return }
  const matches = peopleDirectory.filter((person) => `${person.name} ${person.title}`.toLowerCase().includes(term)).slice(0, 7)
  menu.innerHTML = matches.map((person) => `<button type="button" data-person-suggestion="${encodeURIComponent(person.name)}"><b>${escapeHtml(person.name)}</b><span>${escapeHtml(person.title)}</span></button>`).join('')
  menu.classList.toggle('open', matches.length > 0)
}

function suggestParticipantCompletion(input: HTMLInputElement) {
  const typed = input.value
  const normalized = typed.trim().toLowerCase()
  if (normalized.length < 2) return
  const match = peopleDirectory.find((person) => person.name.toLowerCase().startsWith(normalized) && person.name.toLowerCase() !== normalized)
  if (!match) return
  input.value = match.name
  input.setSelectionRange(typed.length, match.name.length)
  const role = participantRoleInput(input)
  if (role && !role.value.trim()) role.value = match.title
}

function applyParticipantRole(input: HTMLInputElement) {
  const person = peopleDirectory.find((entry) => entry.name.toLowerCase() === input.value.trim().toLowerCase())
  const role = participantRoleInput(input)
  if (person && role && !role.value.trim()) role.value = person.title
}

let activeInterviewTab: 'interviews' | 'collaborators' = 'interviews'

function setInterviewTab(tab: 'interviews' | 'collaborators') {
  activeInterviewTab = tab
  $$('#interviewTabs .segment').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab))
  $('#interviewsPanel')!.hidden = tab !== 'interviews'
  $('#collaboratorsPanel')!.hidden = tab !== 'collaborators'
  $('#newInterview')!.hidden = tab !== 'interviews'
  $('#exportTranscripts')!.hidden = tab !== 'interviews'
  $('#newCollaborator')!.hidden = tab !== 'collaborators'
  $('#interviewsTitle')!.textContent = tab === 'interviews' ? 'Entretiens & transcriptions' : 'Collaborateurs du projet'
  $('#interviewsSubtitle')!.textContent = tab === 'interviews'
    ? 'Importe un fichier ou crée un entretien, puis génère une synthèse détaillée avec OpenAI.'
    : 'Renseigne les personnes que tu vas auditer : elles alimentent les suggestions des entretiens, de l’agenda et du rapport d’audit.'
}

function personInitials(name: string) {
  return name.split(/[\s—–-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? '').join('') || '?'
}

function renderCollaborators() {
  const list = $('#collaboratorList')!
  if (!state.collaborators.length) {
    list.innerHTML = '<div class="empty glass" style="grid-column:1/-1"><div><i class="ri-team-line"></i><b>Aucun collaborateur pour le moment</b><span>Ajoute les personnes que tu vas auditer sur ce projet : nom, rôle, équipe et email.</span></div></div>'
    return
  }
  list.innerHTML = state.collaborators.map((person) => {
    const interviews = state.interviews.filter((interview) => interviewParticipants(interview).some((entry) => entry.name.trim().toLowerCase() === person.name.trim().toLowerCase())).length
    const avatar = person.photo ? `<img src="${escapeHtml(person.photo)}" alt="">` : escapeHtml(personInitials(person.name))
    return `<article class="collaborator-card glass" data-collaborator="${escapeHtml(person.id)}" role="button" tabindex="0">
      <div class="collaborator-avatar">${avatar}</div>
      <div><b>${escapeHtml(person.name)}</b><span>${escapeHtml(person.title || 'Rôle à préciser')}</span>${person.sector ? `<small>${escapeHtml(person.sector)}</small>` : ''}</div>
      <span class="collaborator-count" title="Entretiens menés">${interviews}</span>
    </article>`
  }).join('')
}

function openCollaboratorDialog(person?: DirectoryPerson) {
  $('#collaboratorDialogTitle')!.textContent = person ? 'Modifier le collaborateur' : 'Ajouter un collaborateur'
  $<HTMLInputElement>('#collaboratorId')!.value = person?.id ?? ''
  $<HTMLInputElement>('#collaboratorName')!.value = person?.name ?? ''
  $<HTMLInputElement>('#collaboratorTitle')!.value = person?.title ?? ''
  $<HTMLInputElement>('#collaboratorSector')!.value = person?.sector ?? ''
  $<HTMLInputElement>('#collaboratorEmail')!.value = person?.email ?? ''
  $<HTMLInputElement>('#collaboratorPhoto')!.value = person?.photo ?? ''
  $('#deleteCollaborator')!.hidden = !person
  $<HTMLDialogElement>('#collaboratorDialog')!.showModal()
}

function syncPeopleDirectory() { peopleDirectory = state.collaborators; renderPeopleSuggestions() }

async function saveCollaborator(event: SubmitEvent) {
  event.preventDefault()
  const id = $<HTMLInputElement>('#collaboratorId')!.value
  const payload = {
    name: $<HTMLInputElement>('#collaboratorName')!.value.trim(),
    title: $<HTMLInputElement>('#collaboratorTitle')!.value.trim(),
    sector: $<HTMLInputElement>('#collaboratorSector')!.value.trim(),
    email: $<HTMLInputElement>('#collaboratorEmail')!.value.trim(),
    photo: $<HTMLInputElement>('#collaboratorPhoto')!.value.trim(),
  }
  const person = await api<DirectoryPerson>(id ? `/api/collaborators/${encodeURIComponent(id)}` : '/api/collaborators', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
  state.collaborators = id ? state.collaborators.map((item) => item.id === person.id ? person : item) : [...state.collaborators, person]
  $<HTMLDialogElement>('#collaboratorDialog')!.close()
  syncPeopleDirectory(); renderCollaborators()
  toast(id ? 'Collaborateur mis à jour.' : 'Collaborateur ajouté.')
}

async function deleteCollaborator() {
  const id = $<HTMLInputElement>('#collaboratorId')!.value
  const person = state.collaborators.find((item) => item.id === id)
  if (!person || !await confirmDeletion(`Retirer ${person.name} des collaborateurs du projet ?`)) return
  const result = await api<{ deleted: DirectoryPerson }>(`/api/collaborators/${encodeURIComponent(id)}`, { method: 'DELETE' })
  state.collaborators = state.collaborators.filter((item) => item.id !== id)
  $<HTMLDialogElement>('#collaboratorDialog')!.close()
  syncPeopleDirectory(); renderCollaborators()
  toast('Collaborateur retiré.', false, async () => {
    const restored = await api<DirectoryPerson>('/api/collaborators/restore', { method: 'POST', body: JSON.stringify({ person: result.deleted }) })
    state.collaborators = [...state.collaborators, restored]
    syncPeopleDirectory(); renderCollaborators()
  })
}

function renderAll() { renderProjectIdentity(); $<HTMLTextAreaElement>('#notesInput')!.value = state.notes; renderPeopleSuggestions(); renderDashboard(); renderDocuments(); renderInterviews(); renderCollaborators(); renderProjectSummary(); renderMap(); renderAssistant() }

function startOfMonthGrid(date: Date) { const next = new Date(date.getFullYear(), date.getMonth(), 1); const day = (next.getDay() + 6) % 7; next.setDate(next.getDate() - day); return next }
function localDateKey(date: Date) { const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, '0'); const day = String(date.getDate()).padStart(2, '0'); return `${year}-${month}-${day}` }
function renderCalendarParticipantMatches(value: string) { const menu = $('#calendarParticipantSuggestions')!; const term = value.trim().toLowerCase(); const matches = term ? peopleDirectory.filter((person) => `${person.name} ${person.title}`.toLowerCase().includes(term)).slice(0, 7) : []; menu.innerHTML = matches.map((person) => `<button type="button" data-calendar-person="${encodeURIComponent(person.name)}"><b>${escapeHtml(person.name)}</b><span>${escapeHtml(person.title)}</span></button>`).join(''); menu.classList.toggle('open', matches.length > 0) }
function applyCalendarParticipant(name: string) { const person = peopleDirectory.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase()); if (person) $<HTMLInputElement>('#calendarRole')!.value = person.title }
function suggestCalendarParticipant(input: HTMLInputElement) { const typed = input.value, term = typed.trim().toLowerCase(); const match = term.length > 1 ? peopleDirectory.find((person) => person.name.toLowerCase().startsWith(term) && person.name.toLowerCase() !== term) : undefined; if (!match) return; input.value = match.name; input.setSelectionRange(typed.length, match.name.length); applyCalendarParticipant(match.name) }
function renderCalendar() {
  const status = $('#calendarStatus')!; const workspace = $('#calendarWorkspace')!
  const grid = $('#calendarGrid')!; const rangeLabel = $('#calendarRangeLabel')!
  status.innerHTML = '<div class="calendar-status-inner"><i class="ri-calendar-event-line"></i><div><b>Agenda de mission</b><span>Rendez-vous enregistrés localement sur cette machine.</span></div></div>'
  workspace.hidden = false

  let start: Date;
  let days: Date[];
  
  if (calendarViewMode === 'month') {
    start = startOfMonthGrid(calendarAnchor); 
    days = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
    rangeLabel.textContent = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(calendarAnchor)
  } else if (calendarViewMode === 'week') {
    start = new Date(calendarAnchor);
    const dayOfWeek = start.getDay() === 0 ? 6 : start.getDay() - 1;
    start.setDate(start.getDate() - dayOfWeek);
    days = Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
    const endOfWeek = new Date(days[6]);
    const formatOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
    if (start.getFullYear() !== endOfWeek.getFullYear()) formatOpts.year = 'numeric';
    rangeLabel.textContent = `${new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: start.getMonth() !== endOfWeek.getMonth() ? 'short' : undefined }).format(start)} - ${new Intl.DateTimeFormat('fr-FR', formatOpts).format(endOfWeek)}`
  } else {
    start = new Date(calendarAnchor);
    days = [start];
    rangeLabel.textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(calendarAnchor)
  }

  grid.className = `calendar-grid ${calendarViewMode}-view`;
  
  const formatter = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }); const todayKey = localDateKey(new Date()); const weekdays = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']; 
  const header = calendarViewMode === 'day' ? '' : weekdays.map((day) => `<div class="calendar-weekday">${day}</div>`).join(''); 
  const cells = days.map((day) => { 
    const key = localDateKey(day); 
    const events = calendarEvents.filter((event) => localDateKey(new Date(event.start.dateTime)) === key); 
    const outside = calendarViewMode === 'month' && day.getMonth() !== calendarAnchor.getMonth(); 
    const isDayOrWeek = calendarViewMode !== 'month';
    const visibleEvents = isDayOrWeek ? events : events.slice(0, 3);
    
    return `<section class="calendar-day${outside ? ' outside-month' : ''}${key === todayKey ? ' today' : ''}" data-calendar-date="${key}"><header><b>${day.getDate()}</b>${isDayOrWeek ? `<span style="font-size: 11px; margin-left: 6px; font-weight: 600; opacity: 0.6; text-transform: capitalize;">${new Intl.DateTimeFormat('fr-FR', { weekday: 'long' }).format(day)}</span>` : ''}<button class="calendar-add" type="button" data-calendar-add="${key}" aria-label="Ajouter un rendez-vous"><i class="ri-add-line"></i></button></header><div class="calendar-events">${visibleEvents.map((event) => `<button class="calendar-event${event.participant ? ' has-participant' : ''}" data-calendar-event="${escapeHtml(event.id)}" draggable="true" type="button">${event.participant ? `<span class="calendar-event-avatar">${participantAvatar(event.participant)}</span>` : ''}<span class="calendar-event-copy"><time>${event.isAllDay ? 'Toute la journée' : formatter.format(new Date(event.start.dateTime))}${isDayOrWeek && !event.isAllDay ? ' - ' + formatter.format(new Date(event.end.dateTime)) : ''}</time><b>${escapeHtml(event.subject || 'Sans titre')}</b></span></button>`).join('')}${events.length > 3 && !isDayOrWeek ? `<button class="calendar-more" type="button" data-calendar-add="${key}">+ ${events.length - 3} autres</button>` : ''}</div></section>` 
  }).join(''); 
  
  grid.innerHTML = `${header}${cells}`
}

async function refreshCalendar() {
  let start: Date, end: Date;
  if (calendarViewMode === 'month') {
    start = startOfMonthGrid(calendarAnchor); 
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 42); 
  } else if (calendarViewMode === 'week') {
    start = new Date(calendarAnchor);
    const dayOfWeek = start.getDay() === 0 ? 6 : start.getDay() - 1;
    start.setDate(start.getDate() - dayOfWeek);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else {
    start = new Date(calendarAnchor);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  }
  const result = await api<{ events: CalendarEvent[] }>(`/api/calendar/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`); 
  calendarEvents = result.events; 
  renderCalendar() 
}
async function refreshUpcomingCalendar() { const start = new Date(2000, 0, 1); const end = new Date(new Date().getFullYear() + 10, 0, 1); const result = await api<{ events: CalendarEvent[] }>(`/api/calendar/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`); upcomingCalendarEvents = result.events; renderDashboard() }
async function moveCalendarEvent(id: string, targetDate: string) {
  const item = calendarEvents.find((event) => event.id === id) || upcomingCalendarEvents.find((event) => event.id === id)
  if (!item || localDateKey(new Date(item.start.dateTime)) === targetDate) return
  const originalStart = new Date(item.start.dateTime), originalEnd = new Date(item.end.dateTime)
  const nextStart = new Date(`${targetDate}T${String(originalStart.getHours()).padStart(2, '0')}:${String(originalStart.getMinutes()).padStart(2, '0')}`)
  const nextEnd = new Date(nextStart.getTime() + Math.max(5, originalEnd.getTime() - originalStart.getTime()))
  await api(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ subject: item.subject, location: item.location, participant: item.participant, role: item.role, start: { dateTime: nextStart.toISOString() }, end: { dateTime: nextEnd.toISOString() }, body: { content: item.bodyPreview || '' } }) })
  await Promise.all([refreshCalendar(), refreshUpcomingCalendar()])
  toast('Rendez-vous déplacé.')
}
function openCalendarEventDialog(event?: CalendarEvent, date?: string) { const base = event ? new Date(event.start.dateTime) : date ? new Date(`${date}T09:00:00`) : new Date(); const later = event ? new Date(event.end.dateTime) : new Date(base.getTime() + 30 * 60_000); const eventDate = localDateKey(base); $<HTMLInputElement>('#calendarEventId')!.value = event?.id || ''; $<HTMLInputElement>('#calendarEventDate')!.value = eventDate; $('#calendarDateLabel')!.textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(base); $<HTMLInputElement>('#calendarSubject')!.value = event?.subject === 'Sans titre' ? '' : event?.subject || ''; $<HTMLInputElement>('#calendarLocation')!.value = event?.location?.displayName || ''; $<HTMLInputElement>('#calendarParticipant')!.value = event?.participant || ''; $<HTMLInputElement>('#calendarRole')!.value = event?.role || ''; $<HTMLInputElement>('#calendarStartTime')!.value = `${String(base.getHours()).padStart(2, '0')}:${String(base.getMinutes()).padStart(2, '0')}`; const duration = Math.max(5, Math.round((later.getTime() - base.getTime()) / 60_000)); $<HTMLInputElement>('#calendarDuration')!.value = String(Math.min(480, duration)); $<HTMLTextAreaElement>('#calendarDescription')!.value = event?.bodyPreview || ''; $('#calendarEventTitle')!.textContent = event ? 'Modifier le rendez-vous' : 'Nouveau rendez-vous'; $<HTMLButtonElement>('#deleteCalendarEvent')!.hidden = !event; const guideButton = $<HTMLButtonElement>('#generateGuideButton')!; guideButton.hidden = !event; guideButton.innerHTML = '<i class="ri-sparkling-2-line"></i>Guide d’entretien'; const guideResult = $('#guideResult')!; guideResult.hidden = true; guideResult.innerHTML = ''; $<HTMLDialogElement>('#calendarEventDialog')!.showModal() }
async function saveCalendarEvent(event: SubmitEvent) { event.preventDefault(); const id = $<HTMLInputElement>('#calendarEventId')!.value, date = $<HTMLInputElement>('#calendarEventDate')!.value, time = $<HTMLInputElement>('#calendarStartTime')!.value, participant = $<HTMLInputElement>('#calendarParticipant')!.value.trim(), title = $<HTMLInputElement>('#calendarSubject')!.value.trim(), duration = Math.min(480, Math.max(5, Number($<HTMLInputElement>('#calendarDuration')!.value) || 30)); const start = new Date(`${date}T${time}`), end = new Date(start.getTime() + duration * 60_000); const body = { subject: title || participant || 'Rendez-vous', location: { displayName: $<HTMLInputElement>('#calendarLocation')!.value }, participant, role: $<HTMLInputElement>('#calendarRole')!.value, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, body: { content: $<HTMLTextAreaElement>('#calendarDescription')!.value } }; await api(id ? `/api/calendar/events/${encodeURIComponent(id)}` : '/api/calendar/events', { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) }); $<HTMLDialogElement>('#calendarEventDialog')!.close(); await Promise.all([refreshCalendar(), refreshUpcomingCalendar()]); toast('Rendez-vous enregistré.') }
async function deleteCalendarEvent() { const id = $<HTMLInputElement>('#calendarEventId')!.value; if (!id || !await confirmDeletion('Supprimer ce rendez-vous ?')) return; await api(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }); $<HTMLDialogElement>('#calendarEventDialog')!.close(); await Promise.all([refreshCalendar(), refreshUpcomingCalendar()]); toast('Rendez-vous supprimé.') }

function interviewPayload() {
  const participants = $$<HTMLElement>('#participantRows .participant-row')
    .map((row) => ({ name: row.querySelector<HTMLInputElement>('.participant-name')!.value.trim(), role: row.querySelector<HTMLInputElement>('.participant-role')!.value.trim() }))
    .filter((person) => person.name || person.role)
  return {
    title: $<HTMLInputElement>('#interviewTitle')!.value,
    participants,
    participant: participants[0]?.name ?? '',
    role: participants[0]?.role ?? '',
    date: $<HTMLInputElement>('#interviewDate')!.value,
    transcript: $<HTMLTextAreaElement>('#transcriptText')!.value,
  }
}

async function saveActiveInterview(silent = false) {
  if (!activeInterviewId) return null
  const previous = state.interviews.find((item) => item.id === activeInterviewId)
  const saved = await api<Interview>(`/api/interviews/${activeInterviewId}`, { method: 'PUT', body: JSON.stringify(interviewPayload()) })
  state.interviews = state.interviews.map((item) => item.id === saved.id ? saved : item); if (saved.summary) interviewEditorOpen = false; renderInterviews(); renderDashboard()
  if (previous?.summary && !saved.summary) {
    const rebuilt = await api<{ projectSummary: ProjectSummary | null; projectSummaryUpdatedAt: string | null }>('/api/project-summary/rebuild', { method: 'POST' })
    state.projectSummary = rebuilt.projectSummary; state.projectSummaryUpdatedAt = rebuilt.projectSummaryUpdatedAt; renderDashboard(); renderProjectSummary()
  }
  if (!silent) toast('Entretien enregistré.')
  return saved
}

async function summarizeActiveInterview() {
  if (!activeInterviewId) return
  const button = $<HTMLButtonElement>('#summarizeInterview')!
  try {
    await saveActiveInterview(true); setButtonLoading(button, true, 'Analyse OpenAI…')
    const current = state.interviews.find((item) => item.id === activeInterviewId); if (current) { current.status = 'processing'; renderInterviewList() }
    const result = await api<{ interview: Interview; projectSummary: ProjectSummary; projectSummaryUpdatedAt: string }>(`/api/interviews/${activeInterviewId}/summarize`, { method: 'POST' })
    state.interviews = state.interviews.map((item) => item.id === result.interview.id ? result.interview : item); state.projectSummary = result.projectSummary; state.projectSummaryUpdatedAt = result.projectSummaryUpdatedAt; interviewEditorOpen = false
    renderAll(); await syncGeneratedActions(); toast('Synthèse détaillée et résumé projet mis à jour.')
  } catch (error) { toast(error instanceof Error ? error.message : 'Erreur OpenAI.', true); state = await api<State>('/api/state'); renderAll() }
  finally { if (document.body.contains(button)) setButtonLoading(button, false) }
}

async function deleteActiveInterview() {
  const item = state.interviews.find((entry) => entry.id === activeInterviewId)
  if (!item || !await confirmDeletion(`Supprimer l’entretien « ${item.title} » ?`)) return
  const result = await api<{ deleted: Interview }>(`/api/interviews/${item.id}`, { method: 'DELETE' }); state.interviews = state.interviews.filter((entry) => entry.id !== item.id); activeInterviewId = state.interviews[0]?.id ?? null
  if (item.summary) {
    const rebuilt = await api<{ projectSummary: ProjectSummary | null; projectSummaryUpdatedAt: string | null }>('/api/project-summary/rebuild', { method: 'POST' })
    state.projectSummary = rebuilt.projectSummary; state.projectSummaryUpdatedAt = rebuilt.projectSummaryUpdatedAt
  }
  renderAll(); toast('Entretien supprimé.', false, async () => { await api<Interview>('/api/interviews/restore', { method: 'POST', body: JSON.stringify({ interview: result.deleted }) }); if (result.deleted.summary) await api('/api/project-summary/rebuild', { method: 'POST' }); state = await api<State>('/api/state'); activeInterviewId = result.deleted.id; renderAll() })
}

async function createInterview() {
  const interview = await api<Interview>('/api/interviews', { method: 'POST', body: JSON.stringify({ title: 'Nouvel entretien' }) })
  state.interviews.unshift(interview); activeInterviewId = interview.id; interviewEditorOpen = true; renderAll(); showView('interviews'); window.setTimeout(() => $<HTMLInputElement>('#interviewTitle')?.select(), 80)
}

async function uploadTranscript(file: File) {
  const dropzone = $('#dropzone')!; dropzone.classList.add('drag')
  try {
    const form = new FormData(); form.append('file', file)
    const interview = await api<Interview>('/api/interviews/upload', { method: 'POST', body: form })
    state.interviews.unshift(interview); activeInterviewId = interview.id; interviewEditorOpen = true; renderAll(); showView('interviews'); toast('Transcription importée. Analyse OpenAI en cours…')
    await summarizeActiveInterview()
  } finally { dropzone.classList.remove('drag'); $<HTMLInputElement>('#fileInput')!.value = '' }
}

async function rebuildProject(button: HTMLButtonElement) {
  try {
    setButtonLoading(button, true, 'Reconstruction…')
    const result = await api<{ projectSummary: ProjectSummary | null; projectSummaryUpdatedAt: string | null }>('/api/project-summary/rebuild', { method: 'POST' })
    state.projectSummary = result.projectSummary; state.projectSummaryUpdatedAt = result.projectSummaryUpdatedAt; renderDashboard(); renderProjectSummary(); await syncGeneratedActions(); toast('Synthèse stratégique reconstruite.')
  } catch (error) { toast(error instanceof Error ? error.message : 'Erreur OpenAI.', true) }
  finally { setButtonLoading(button, false) }
}

function openLaneDialog(lane?: MapLane) {
  $<HTMLInputElement>('#laneId')!.value = lane?.id ?? ''; $<HTMLInputElement>('#laneName')!.value = lane?.name ?? ''; $<HTMLTextAreaElement>('#laneDescription')!.value = lane?.description ?? ''
  $('#laneDialogTitle')!.textContent = lane ? 'Modifier la phase' : 'Ajouter une phase'; $<HTMLDialogElement>('#laneDialog')!.showModal()
}

function openMapSuggestionDialog() {
  currentMapSuggestion = null
  const eligible = state.interviews.filter((item) => item.transcript.trim())
  const target = $('#mapInterviewChoices')!
  target.innerHTML = eligible.length
    ? eligible.map((item) => `<label class="suggestion-choice"><input type="checkbox" value="${item.id}"><span><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.participant || 'Participant non renseigné')} · ${formatDate(item.date)} · ${statusLabel(item.status)}</span></span></label>`).join('')
    : emptyHtml('ri-file-text-line', 'Aucune transcription disponible', 'Importe ou colle une transcription avant de demander une suggestion.', true)
  $('#mapSuggestionSelect')!.hidden = false
  $('#mapSuggestionPreview')!.hidden = true
  $<HTMLButtonElement>('#generateMapSuggestion')!.disabled = !eligible.length
  $<HTMLDialogElement>('#mapSuggestionDialog')!.showModal()
}

function renderMapSuggestionPreview(proposal: MapSuggestion) {
  $('#mapSuggestionOverview')!.textContent = proposal.overview
  $('#mapSuggestionLanes')!.innerHTML = proposal.lanes.map((lane) => `<article class="suggestion-lane"><h3>${escapeHtml(lane.name)}</h3>${lane.description ? `<p>${escapeHtml(lane.description)}</p>` : ''}${lane.nodes.map((node) => `<div class="suggestion-node"><b>${escapeHtml(node.label)}</b><span>${escapeHtml(node.owner || 'À définir')} · ${node.status === 'confirmed' ? 'Confirmé' : node.status === 'friction' ? 'Friction' : 'À vérifier'}</span>${node.evidence ? `<span>${escapeHtml(node.evidence)}</span>` : ''}</div>`).join('')}</article>`).join('')
}

async function generateMapSuggestion(button: HTMLButtonElement) {
  const interviewIds = $$<HTMLInputElement>('#mapInterviewChoices input:checked').map((input) => input.value)
  if (!interviewIds.length) { toast('Sélectionne au moins un entretien.', true); return }
  try {
    setButtonLoading(button, true, 'Analyse des entretiens…')
    currentMapSuggestion = await api<MapSuggestion>('/api/map/suggestions', { method: 'POST', body: JSON.stringify({ interviewIds }) })
    renderMapSuggestionPreview(currentMapSuggestion)
    $('#mapSuggestionSelect')!.hidden = true
    $('#mapSuggestionPreview')!.hidden = false
  } catch (error) { toast(error instanceof Error ? error.message : 'Impossible de générer la proposition.', true) }
  finally { setButtonLoading(button, false) }
}

async function applyMapSuggestion(button: HTMLButtonElement) {
  if (!currentMapSuggestion) return
  try {
    setButtonLoading(button, true, 'Ajout en cours…')
    const result = await api<{ lanes: MapLane[]; nodes: MapNode[] }>('/api/map/suggestions/apply', { method: 'POST', body: JSON.stringify({ proposal: currentMapSuggestion }) })
    state.mapLanes.push(...result.lanes); state.mapNodes.push(...result.nodes)
    $<HTMLDialogElement>('#mapSuggestionDialog')!.close(); renderMap(); renderDashboard()
    toast(`${result.lanes.length} phase${result.lanes.length > 1 ? 's' : ''} et ${result.nodes.length} étape${result.nodes.length > 1 ? 's' : ''} ajoutées. À vérifier et modifier si besoin.`)
  } catch (error) { toast(error instanceof Error ? error.message : 'Impossible d’ajouter la proposition.', true) }
  finally { if (document.body.contains(button)) setButtonLoading(button, false) }
}

function openNodeDialog(laneId: string, node?: MapNode) {
  $<HTMLInputElement>('#nodeId')!.value = node?.id ?? ''; $<HTMLInputElement>('#nodeLabel')!.value = node?.label ?? ''; $<HTMLInputElement>('#nodeOwner')!.value = node?.owner ?? ''; $<HTMLTextAreaElement>('#nodeDescription')!.value = node?.description ?? ''; $<HTMLTextAreaElement>('#nodeEvidence')!.value = node?.evidence ?? ''; $<HTMLInputElement>('#nodeSystems')!.value = node?.systems.join(', ') ?? ''
  $<HTMLSelectElement>('#nodeLane')!.innerHTML = state.mapLanes.map((lane) => `<option value="${lane.id}" ${(node?.laneId ?? laneId) === lane.id ? 'selected' : ''}>${escapeHtml(lane.name)}</option>`).join('')
  $<HTMLSelectElement>('#nodeStatus')!.value = node?.status ?? 'verify'; $('#nodeDialogTitle')!.textContent = node ? 'Modifier l’étape' : 'Ajouter une étape'; $<HTMLButtonElement>('#deleteNode')!.hidden = !node; $<HTMLDialogElement>('#nodeDialog')!.showModal()
}

async function saveLane(event: SubmitEvent) {
  event.preventDefault(); const id = $<HTMLInputElement>('#laneId')!.value; const payload = { name: $<HTMLInputElement>('#laneName')!.value, description: $<HTMLTextAreaElement>('#laneDescription')!.value }
  const lane = await api<MapLane>(id ? `/api/map/lanes/${id}` : '/api/map/lanes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
  state.mapLanes = id ? state.mapLanes.map((item) => item.id === lane.id ? lane : item) : [...state.mapLanes, lane]; $<HTMLDialogElement>('#laneDialog')!.close(); renderMap(); toast('Phase enregistrée.')
}

async function saveNode(event: SubmitEvent) {
  event.preventDefault(); const id = $<HTMLInputElement>('#nodeId')!.value
  const payload = { laneId: $<HTMLSelectElement>('#nodeLane')!.value, status: $<HTMLSelectElement>('#nodeStatus')!.value, label: $<HTMLInputElement>('#nodeLabel')!.value, owner: $<HTMLInputElement>('#nodeOwner')!.value, description: $<HTMLTextAreaElement>('#nodeDescription')!.value, systems: $<HTMLInputElement>('#nodeSystems')!.value.split(',').map((item)=>item.trim()).filter(Boolean), evidence: $<HTMLTextAreaElement>('#nodeEvidence')!.value }
  const node = await api<MapNode>(id ? `/api/map/nodes/${id}` : '/api/map/nodes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) })
  state.mapNodes = id ? state.mapNodes.map((item) => item.id === node.id ? node : item) : [...state.mapNodes, node]; $<HTMLDialogElement>('#nodeDialog')!.close(); renderMap(); renderDashboard(); toast('Étape enregistrée.')
}

async function deleteNode() {
  const id = $<HTMLInputElement>('#nodeId')!.value; const node = state.mapNodes.find((item) => item.id === id)
  if (!node) return
  $<HTMLDialogElement>('#nodeDialog')!.close()
  if (!await confirmDeletion(`Supprimer l’étape « ${node.label} » ?`)) return
  await removeMapNode(node)
}

async function removeMapNode(node: MapNode) {
  const result = await api<{ deleted: MapNode }>(`/api/map/nodes/${node.id}`, { method: 'DELETE' })
  state.mapNodes = state.mapNodes.filter((item) => item.id !== node.id); renderMap(); renderDashboard()
  toast('Étape supprimée.', false, async () => { await api<MapNode>('/api/map/nodes/restore', { method: 'POST', body: JSON.stringify({ node: result.deleted }) }); state = await api<State>('/api/state'); renderAll() })
}

async function removeMapLane(lane: MapLane) {
  const result = await api<{ lane: MapLane; nodes: MapNode[] }>(`/api/map/lanes/${lane.id}`, { method: 'DELETE' })
  state.mapLanes = state.mapLanes.filter((item) => item.id !== lane.id); state.mapNodes = state.mapNodes.filter((item) => item.laneId !== lane.id); renderMap(); renderDashboard()
  toast('Phase supprimée.', false, async () => { await api('/api/map/lanes/restore', { method: 'POST', body: JSON.stringify(result) }); state = await api<State>('/api/state'); renderAll() })
}

function attachEvents() {
  $$('.nav-btn').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view!)))
  const contextInput = $<HTMLInputElement>('#contextFileInput'); contextInput?.addEventListener('change', () => { const file = contextInput.files?.[0]; if (file) void uploadContextDocument(file).catch((error) => toast(error.message, true)); contextInput.value = '' })
  const contextDropzone = $('#contextDropzone'); contextDropzone?.addEventListener('dragover', (event) => { event.preventDefault(); contextDropzone.classList.add('drag') }); contextDropzone?.addEventListener('dragleave', () => contextDropzone.classList.remove('drag')); contextDropzone?.addEventListener('drop', (event) => { event.preventDefault(); contextDropzone.classList.remove('drag'); const file = (event as DragEvent).dataTransfer?.files[0]; if (file) void uploadContextDocument(file).catch((error) => toast(error.message, true)) })
  $('#contextDocumentsList')?.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-delete-context-document]'); if (button) void deleteContextDocument(button.dataset.deleteContextDocument!).catch((error) => toast(error.message, true)) })
  $('#generateAuditReport')?.addEventListener('click', () => void generateAuditReport())
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.go!)))
  $('#dashboardActions')!.addEventListener('click', (event) => { const target = event.target as HTMLElement; const toggle = target.closest<HTMLElement>('[data-action-toggle]'); if (toggle) { void toggleAction(toggle.dataset.actionToggle!).catch((error) => toast(error.message, true)); return } const edit = target.closest<HTMLElement>('[data-edit-action]'); if (edit) { openActionDialog(state.missionActions.find((item) => item.id === edit.dataset.editAction)); return } const remove = target.closest<HTMLElement>('[data-delete-action]'); if (remove) { void deleteAction(remove.dataset.deleteAction!).catch((error) => toast(error.message, true)) } })
  $('#dashboardActions')!.addEventListener('click', (event) => { if ((event.target as HTMLElement).closest('#addAction')) openActionDialog() })
  $('#nextMeeting')!.addEventListener('click', (event) => { const target = event.target as HTMLElement; const guide = target.closest<HTMLButtonElement>('[data-generate-guide]'); if (guide) { event.stopPropagation(); void generateInterviewGuide(guide.dataset.generateGuide!, guide); return } const button = target.closest<HTMLElement>('[data-open-next-meeting]'); if (!button) return; const meeting = upcomingCalendarEvents.find((item) => item.id === button.dataset.openNextMeeting); if (!meeting) return; calendarAnchor = new Date(meeting.start.dateTime); showView('calendar'); void refreshCalendar().then(() => openCalendarEventDialog(meeting)).catch((error) => toast(error.message, true)) })
  $('#notesInput')!.addEventListener('input', () => { window.clearTimeout(notesTimer); $('#saveState')!.textContent = 'Enregistrement…'; notesTimer = window.setTimeout(async () => { try { const result = await api<{ notes: string }>('/api/notes', { method:'PUT', body:JSON.stringify({notes:$<HTMLTextAreaElement>('#notesInput')!.value}) }); state.notes = result.notes; $('#saveState')!.textContent = 'Enregistré localement.' } catch(error) { $('#saveState')!.textContent = error instanceof Error ? error.message : 'Erreur.' } }, 500) })
  $('#exportTranscripts')!.addEventListener('click', () => {
    const interviews = state.interviews.filter((item) => item.transcript.trim())
    if (!interviews.length) { toast('Aucune transcription à exporter pour cet audit.', true); return }
    try { const count = exportTranscripts(state.project, interviews.map((item) => ({ title: item.title, participants: interviewParticipants(item), date: item.date, transcript: item.transcript, createdAt: item.createdAt }))); toast(`${count} transcription${count > 1 ? 's' : ''} exportée${count > 1 ? 's' : ''} dans tes téléchargements.`) } catch (error) { toast((error as Error).message, true) }
  })
  $('#newInterview')!.addEventListener('click', () => void createInterview().catch((error)=>toast(error.message,true)))
  $('#newCollaborator')!.addEventListener('click', () => openCollaboratorDialog())
  $('#interviewTabs')!.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]'); if (button) setInterviewTab(button.dataset.tab as 'interviews' | 'collaborators') })
  $<HTMLFormElement>('#collaboratorForm')!.addEventListener('submit', (event) => void saveCollaborator(event).catch((error) => toast(error.message, true)))
  $('#deleteCollaborator')!.addEventListener('click', () => void deleteCollaborator().catch((error) => toast(error.message, true)))
  $('#collaboratorList')!.addEventListener('click', (event) => { const card = (event.target as HTMLElement).closest<HTMLElement>('[data-collaborator]'); if (card) openCollaboratorDialog(state.collaborators.find((person) => person.id === card.dataset.collaborator)) })
  $('#collaboratorList')!.addEventListener('keydown', (event) => { const card = (event.target as HTMLElement).closest<HTMLElement>('[data-collaborator]'); if (card && (event as KeyboardEvent).key === 'Enter') openCollaboratorDialog(state.collaborators.find((person) => person.id === card.dataset.collaborator)) })
  $('#interviewList')!.addEventListener('click', (event) => { const row=(event.target as HTMLElement).closest<HTMLElement>('[data-interview-id]'); if(row){activeInterviewId=row.dataset.interviewId!;interviewEditorOpen=false;renderInterviews()} })
  document.addEventListener('click', (event) => { const button=(event.target as HTMLElement).closest<HTMLElement>('[data-open-interview]'); if(button) openInterviewPreview(button.dataset.openInterview!) })
  $('#interviewDetail')!.addEventListener('click', (event) => { const target = event.target as HTMLElement; const remove = target.closest<HTMLElement>('[data-delete-summary-section]'); if (remove) { event.stopPropagation(); void deleteSummarySection(remove.dataset.deleteSummarySection as Exclude<keyof InterviewSummary, 'executiveSummary' | 'actionItems'>).catch((error) => toast(error.message, true)); return } const section = target.closest<HTMLElement>('[data-summary-section]'); if (section) openSummarySection(section.dataset.summarySection!) })
  $('#interviewDetail')!.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { const section = (event.target as HTMLElement).closest<HTMLElement>('[data-summary-section]'); if (section) { event.preventDefault(); openSummarySection(section.dataset.summarySection!) } } })
  const input=$<HTMLInputElement>('#fileInput')!; input.addEventListener('change',()=>{const file=input.files?.[0];if(file)void uploadTranscript(file).catch((error)=>toast(error.message,true))})
  const drop=$('#dropzone')!; ['dragenter','dragover'].forEach((name)=>drop.addEventListener(name,(event)=>{event.preventDefault();drop.classList.add('drag')})); ['dragleave','drop'].forEach((name)=>drop.addEventListener(name,(event)=>{event.preventDefault();drop.classList.remove('drag')})); drop.addEventListener('drop',(event)=>{const file=(event as DragEvent).dataTransfer?.files[0];if(file)void uploadTranscript(file).catch((error)=>toast(error.message,true))})
  $('#assistantForm')!.addEventListener('submit',(event)=>void sendAssistantMessage(event))
  $('#assistantAttachment')?.addEventListener('change', () => { const input = $<HTMLInputElement>('#assistantAttachment'); const file = input?.files?.[0]; const label = $('#assistantFileName'); const name = label?.querySelector('span'); if (label && name) { name.textContent = file ? file.name : ''; label.classList.toggle('visible', Boolean(file)) } })
  $('#assistantMessages')!.addEventListener('click',(event)=>{ const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-apply-assistant-action]'); if(button) void applyAssistantAction(button.dataset.applyAssistantAction!, Number(button.dataset.actionIndex), button) })
  $('#newAssistantConversation')!.addEventListener('click',()=>void createAssistantConversation().catch((error)=>toast(error.message,true)))
  $('#assistantConversationList')!.addEventListener('click',(event)=>{ const button=(event.target as HTMLElement).closest<HTMLElement>('[data-assistant-conversation]'); if(button) void selectAssistantConversation(button.dataset.assistantConversation!).catch((error)=>toast(error.message,true)) })
  $('#refreshSlack')!.addEventListener('click', () => void refreshSlack().catch((error) => toast(error.message, true)))
  $('#slackChannels')!.addEventListener('click', (event) => { const button = (event.target as HTMLElement).closest<HTMLElement>('[data-slack-channel]'); if (button) void selectSlackChannel(button.dataset.slackChannel!).catch((error) => toast(error.message, true)) })
  $('#newCalendarEvent')!.addEventListener('click', () => openCalendarEventDialog())
  $('#calendarPrevious')!.addEventListener('click', () => { 
    if (calendarViewMode === 'month') calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth() - 1, 1); 
    else if (calendarViewMode === 'week') calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth(), calendarAnchor.getDate() - 7);
    else calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth(), calendarAnchor.getDate() - 1);
    void refreshCalendar().catch((error) => toast(error.message, true)) 
  })
  $('#calendarNext')!.addEventListener('click', () => { 
    if (calendarViewMode === 'month') calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth() + 1, 1); 
    else if (calendarViewMode === 'week') calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth(), calendarAnchor.getDate() + 7);
    else calendarAnchor = new Date(calendarAnchor.getFullYear(), calendarAnchor.getMonth(), calendarAnchor.getDate() + 1);
    void refreshCalendar().catch((error) => toast(error.message, true)) 
  })
  $('#calendarToday')!.addEventListener('click', () => { calendarAnchor = new Date(); void refreshCalendar().catch((error) => toast(error.message, true)) })
  
  $$('[data-calendar-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      calendarViewMode = btn.dataset.calendarView as 'month' | 'week' | 'day';
      $$('[data-calendar-view]').forEach((b) => b.classList.remove('primary'));
      btn.classList.add('primary');
      void refreshCalendar().catch((error) => toast(error.message, true))
    });
  });
  $('#calendarGrid')!.addEventListener('click', (event) => { const target = event.target as HTMLElement; const card = target.closest<HTMLElement>('[data-calendar-event]'); if (card) { const found = calendarEvents.find((item) => item.id === card.dataset.calendarEvent); if (found) openCalendarEventDialog(found); return } const add = target.closest<HTMLElement>('[data-calendar-add]'); if (add) { openCalendarEventDialog(undefined, add.dataset.calendarAdd); return } const day = target.closest<HTMLElement>('[data-calendar-date]'); if (day) openCalendarEventDialog(undefined, day.dataset.calendarDate) })
  $('#generateGuideButton')!.addEventListener('click', () => { const id = $<HTMLInputElement>('#calendarEventId')!.value; if (id) void generateInterviewGuide(id, $<HTMLButtonElement>('#generateGuideButton')!) })
  let draggedCalendarEventId: string | null = null
  $('#calendarGrid')!.addEventListener('dragstart', (event) => { const card = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-event]'); if (!card || !(event instanceof DragEvent)) return; draggedCalendarEventId = card.dataset.calendarEvent || null; card.classList.add('dragging'); event.dataTransfer?.setData('text/plain', draggedCalendarEventId || ''); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' })
  $('#calendarGrid')!.addEventListener('dragend', () => { draggedCalendarEventId = null; $$('.calendar-event.dragging').forEach((item) => item.classList.remove('dragging')); $$('.calendar-day.drag-target').forEach((item) => item.classList.remove('drag-target')) })
  $('#calendarGrid')!.addEventListener('dragover', (event) => { const day = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-date]'); if (!day) return; event.preventDefault(); day.classList.add('drag-target'); if (event instanceof DragEvent && event.dataTransfer) event.dataTransfer.dropEffect = 'move' })
  $('#calendarGrid')!.addEventListener('dragleave', (event) => { const day = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-date]'); if (day && !day.contains(event.relatedTarget as Node | null)) day.classList.remove('drag-target') })
  $('#calendarGrid')!.addEventListener('drop', (event) => { const day = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-date]'); if (!day) return; event.preventDefault(); day.classList.remove('drag-target'); const id = draggedCalendarEventId || (event instanceof DragEvent ? event.dataTransfer?.getData('text/plain') : ''); if (id) void moveCalendarEvent(id, day.dataset.calendarDate!).catch((error) => toast(error.message, true)) })
  $<HTMLFormElement>('#calendarEventForm')!.addEventListener('submit', (event) => void saveCalendarEvent(event).catch((error) => toast(error.message, true)))
  $('#deleteCalendarEvent')!.addEventListener('click', () => void deleteCalendarEvent().catch((error) => toast(error.message, true)))
  const durationInput = $<HTMLInputElement>('#calendarDuration')!; const changeDuration = (delta: number) => { durationInput.value = String(Math.min(480, Math.max(5, (Number(durationInput.value) || 30) + delta))) }
  $('#calendarDurationMinus')!.addEventListener('click', () => changeDuration(-5)); $('#calendarDurationPlus')!.addEventListener('click', () => changeDuration(5))
  $('#calendarParticipant')!.addEventListener('input', (event) => { const input = event.currentTarget as HTMLInputElement; renderCalendarParticipantMatches(input.value); suggestCalendarParticipant(input) })
  $('#calendarParticipant')!.addEventListener('change', (event) => applyCalendarParticipant((event.currentTarget as HTMLInputElement).value))
  $('#calendarParticipantSuggestions')!.addEventListener('click', (event) => { const option = (event.target as HTMLElement).closest<HTMLElement>('[data-calendar-person]'); if (!option) return; const name = decodeURIComponent(option.dataset.calendarPerson!); $<HTMLInputElement>('#calendarParticipant')!.value = name; applyCalendarParticipant(name); renderCalendarParticipantMatches('') })
  $('#addLane')!.addEventListener('click',()=>openLaneDialog()); $('#suggestMap')!.addEventListener('click',()=>openMapSuggestionDialog()); $('#generateMapSuggestion')!.addEventListener('click',(event)=>void generateMapSuggestion(event.currentTarget as HTMLButtonElement)); $('#applyMapSuggestion')!.addEventListener('click',(event)=>void applyMapSuggestion(event.currentTarget as HTMLButtonElement)); $('#backToMapSelection')!.addEventListener('click',()=>{ $('#mapSuggestionSelect')!.hidden=false; $('#mapSuggestionPreview')!.hidden=true }); $<HTMLFormElement>('#laneForm')!.addEventListener('submit',(event)=>void saveLane(event).catch((error)=>toast(error.message,true))); $<HTMLFormElement>('#nodeForm')!.addEventListener('submit',(event)=>void saveNode(event).catch((error)=>toast(error.message,true))); $('#deleteNode')!.addEventListener('click',()=>void deleteNode().catch((error)=>toast(error.message,true)))
  $<HTMLFormElement>('#actionForm')!.addEventListener('submit',(event)=>void saveAction(event).catch((error)=>toast(error.message,true)))
  $$('[data-close]').forEach((button)=>button.addEventListener('click',()=> $<HTMLDialogElement>(`#${button.dataset.close}`)!.close()))
  $('#mapBoard')!.addEventListener('click',(event)=>{
    const target = event.target as HTMLElement
    const deleteNodeButton = target.closest<HTMLElement>('[data-delete-node]')
    if (deleteNodeButton) { const node = state.mapNodes.find((item) => item.id === deleteNodeButton.dataset.deleteNode); if (node) void (async () => { if (await confirmDeletion(`Supprimer l’étape « ${node.label} » ?`)) await removeMapNode(node) })().catch((error) => toast(error.message, true)); return }
    const add = target.closest<HTMLElement>('[data-add-node]'); if(add) return openNodeDialog(add.dataset.addNode!)
    const editLane = target.closest<HTMLElement>('[data-edit-lane]'); if(editLane) return openLaneDialog(state.mapLanes.find((item)=>item.id===editLane.dataset.editLane))
    const deleteLane = target.closest<HTMLElement>('[data-delete-lane]')
    if (deleteLane) { const lane = state.mapLanes.find((item)=>item.id===deleteLane.dataset.deleteLane); if(lane) void (async () => { if (await confirmDeletion(`Supprimer la phase « ${lane.name} » et toutes ses étapes ?`)) await removeMapLane(lane) })().catch((error) => toast(error.message, true)); return }
    const nodeEl = target.closest<HTMLElement>('[data-node-id]'); if(nodeEl){const node=state.mapNodes.find((item)=>item.id===nodeEl.dataset.nodeId);if(node)openNodeDialog(node.laneId,node)}
  })
}

async function start() {
  await bootAuth({
    notify: (message, error) => toast(message, error),
    onReady: async () => {
      document.querySelectorAll<HTMLElement>('.admin-only').forEach((node) => { node.hidden = !isAdmin() })
      await loadWorkspace()
    },
  })
}

async function loadWorkspace() {
  try {
    state = await api<State>('/api/state')
    peopleDirectory = state.collaborators; activeInterviewId = state.interviews[0]?.id ?? null; activeAssistantConversationId = state.assistantConversations?.[0]?.id ?? null; attachEvents(); renderAll(); await Promise.all([syncGeneratedActions(), refreshUpcomingCalendar()]); finishLaunch()
    window.setInterval(() => { if ($('#slack')?.classList.contains('active')) void refreshSlack().catch(() => undefined) }, 20_000)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Impossible de charger l’application.'
    if (message.includes('Projet introuvable')) { window.localStorage.removeItem(projectStorageKey); window.location.replace('/'); return }
    finishLaunch(); document.body.insertAdjacentHTML('beforeend', `<div class="empty" style="margin:40px">${escapeHtml(message)}</div>`)
  }
}

void start()
