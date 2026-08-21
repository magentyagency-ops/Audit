import { config as loadEnv } from 'dotenv'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import OpenAI from 'openai'
import { WebClient } from '@slack/web-api'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { authConfigured, currentUser, requireSession } from './auth.js'
import { getFile, putFile, readJob, removeFile, readProjectState, storageMode, writeJob, writeProjectState, type StoredJob } from './storage.js'
import { waitUntil } from '@vercel/functions'
import { handleAdminUsers } from './adminUsers.js'
import { ProjectBriefSchema, activeProject, bootstrapProjects, findProject, insertProject, listProjects, patchProject, projectStateFile, projectStats, removeProject, withProject, type Project, type ProjectBrief } from './projects.js'

type Theme = 'light' | 'midnight' | 'ocean' | 'sunset'
type InterviewStatus = 'draft' | 'processing' | 'complete' | 'error'
type MapStatus = 'confirmed' | 'verify' | 'friction'

const ActionItemSchema = z.object({
  task: z.string(),
  owner: z.string(),
  deadline: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
})

const InterviewSummarySchema = z.object({
  executiveSummary: z.string(),
  keyPoints: z.array(z.string()),
  decisions: z.array(z.string()),
  painPoints: z.array(z.string()),
  processes: z.array(z.string()),
  systems: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
  actionItems: z.array(ActionItemSchema),
  notableQuotes: z.array(z.string()),
  followUpQuestions: z.array(z.string()),
})

const ProjectSummarySchema = z.object({
  overview: z.string(),
  progress: z.array(z.string()),
  confirmedFindings: z.array(z.string()),
  contradictions: z.array(z.string()),
  priorities: z.array(z.string()),
  nextSteps: z.array(z.string()),
  risks: z.array(z.string()),
})

const MapSuggestionNodeSchema = z.object({
  label: z.string(),
  description: z.string(),
  owner: z.string(),
  status: z.enum(['confirmed', 'verify', 'friction']),
  systems: z.array(z.string()),
  evidence: z.string(),
})

const MapSuggestionLaneSchema = z.object({
  name: z.string(),
  description: z.string(),
  nodes: z.array(MapSuggestionNodeSchema),
})

const MapSuggestionSchema = z.object({
  overview: z.string(),
  lanes: z.array(MapSuggestionLaneSchema),
})

const AssistantMapNodeSchema = z.object({
  label: z.string(), description: z.string(), owner: z.string(), status: z.enum(['confirmed', 'verify', 'friction']), systems: z.array(z.string()), evidence: z.string(),
})
const AssistantMapLaneSchema = z.object({ name: z.string(), description: z.string(), nodes: z.array(AssistantMapNodeSchema) })
const AssistantCalendarEventSchema = z.object({
  subject: z.string(), startDateTime: z.string(), endDateTime: z.string(), location: z.string(), description: z.string(), participant: z.string(), role: z.string(), isAllDay: z.boolean(),
})
const AssistantActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('generate_document'), label: z.string(), title: z.string(), format: z.enum(['document', 'presentation']), brief: z.string() }),
  z.object({ type: z.literal('update_notes'), label: z.string(), notes: z.string() }),
  z.object({ type: z.literal('create_mission_action'), label: z.string(), text: z.string(), done: z.boolean() }),
  z.object({ type: z.literal('update_mission_action'), label: z.string(), actionId: z.string(), text: z.string(), done: z.boolean() }),
  z.object({ type: z.literal('delete_mission_action'), label: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('create_calendar_event'), label: z.string(), event: AssistantCalendarEventSchema }),
  z.object({ type: z.literal('update_calendar_event'), label: z.string(), eventId: z.string(), event: AssistantCalendarEventSchema }),
  z.object({ type: z.literal('delete_calendar_event'), label: z.string(), eventId: z.string() }),
  z.object({ type: z.literal('create_map'), label: z.string(), lanes: z.array(AssistantMapLaneSchema) }),
  z.object({ type: z.literal('update_lane'), label: z.string(), laneId: z.string(), name: z.string(), description: z.string() }),
  z.object({ type: z.literal('delete_lane'), label: z.string(), laneId: z.string() }),
  z.object({ type: z.literal('update_node'), label: z.string(), nodeId: z.string(), labelValue: z.string(), description: z.string(), owner: z.string(), status: z.enum(['confirmed', 'verify', 'friction']), systems: z.array(z.string()), evidence: z.string() }),
  z.object({ type: z.literal('delete_node'), label: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal('create_interview'), label: z.string(), title: z.string(), participant: z.string(), role: z.string(), date: z.string(), transcript: z.string() }),
  z.object({ type: z.literal('update_interview'), label: z.string(), interviewId: z.string(), title: z.string(), participant: z.string(), role: z.string(), date: z.string() }),
  z.object({ type: z.literal('update_interview_summary_section'), label: z.string(), interviewId: z.string(), section: z.enum(['keyPoints', 'decisions', 'painPoints', 'processes', 'systems', 'risks', 'openQuestions', 'notableQuotes', 'followUpQuestions']), items: z.array(z.string()) }),
  z.object({ type: z.literal('delete_interview'), label: z.string(), interviewId: z.string() }),
])
const AssistantReplySchema = z.object({ reply: z.string(), actions: z.array(AssistantActionSchema) })

type InterviewSummary = z.infer<typeof InterviewSummarySchema>
type ProjectSummary = z.infer<typeof ProjectSummarySchema>
type MapSuggestion = z.infer<typeof MapSuggestionSchema>
type AssistantAction = z.infer<typeof AssistantActionSchema>
type AssistantReply = z.infer<typeof AssistantReplySchema>
type AssistantMessage = { id: string; role: 'user' | 'assistant'; content: string; actions?: AssistantAction[]; attachmentName?: string; createdAt: string }
type AssistantConversation = { id: string; title: string; messages: AssistantMessage[]; createdAt: string; updatedAt: string }
type MissionAction = { id: string; text: string; done: boolean; source: 'ai' | 'manual'; createdAt: string; updatedAt: string }
type OutlookConnection = { accessToken: string; refreshToken?: string; expiresAt: number; account?: string; name?: string }
type LocalCalendarEvent = { id: string; subject: string; start: { dateTime: string }; end: { dateTime: string }; location?: { displayName?: string }; bodyPreview?: string; participant?: string; role?: string; isAllDay?: boolean; createdAt: string; updatedAt: string }
type ContextDocument = { id: string; name: string; mimeType: string; size: number; filePath: string; extractedText: string; createdAt: string }

type InterviewParticipant = { name: string; role: string }
type Interview = {
  id: string
  title: string
  /** Kept in sync with the first entry of `participants` so older data and single-participant views keep working. */
  participant: string
  role: string
  participants: InterviewParticipant[]
  date: string
  transcript: string
  sourceFile?: string
  status: InterviewStatus
  summary?: InterviewSummary
  error?: string
  createdAt: string
  updatedAt: string
}

type MapLane = { id: string; name: string; description: string; order: number }
type MapNode = {
  id: string
  laneId: string
  label: string
  description: string
  owner: string
  status: MapStatus
  systems: string[]
  evidence: string
  order: number
}
type DirectoryPerson = { id: string; name: string; title: string; email: string; sector: string; photo: string }

const summarySectionFields = ['keyPoints', 'decisions', 'painPoints', 'processes', 'systems', 'risks', 'openQuestions', 'notableQuotes', 'followUpQuestions'] as const
type SummarySectionField = typeof summarySectionFields[number]

type MissionState = {
  notes: string
  theme: Theme
  interviews: Interview[]
  projectSummary: ProjectSummary | null
  projectSummaryUpdatedAt: string | null
  mapLanes: MapLane[]
  mapNodes: MapNode[]
  assistantConversations: AssistantConversation[]
  missionActions: MissionAction[]
  outlookConnection?: OutlookConnection
  calendarEvents: LocalCalendarEvent[]
  contextDocuments: ContextDocument[]
  collaborators: DirectoryPerson[]
  updatedAt: string
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stateFile = () => projectStateFile(activeProject().id)
const documentDirectory = path.join(root, 'data', 'generated-documents')
const contextDocumentDirectory = path.join(root, 'data', 'context-documents')
const downloadsDirectory = path.join(homedir(), 'Downloads')
const envFile = path.join(root, '.env.local')
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = ['.txt', '.md', '.text']
    callback(null, allowed.includes(path.extname(file.originalname).toLowerCase()) || file.mimetype.startsWith('text/'))
  },
})
const contextUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } })
const assistantAttachmentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } })

loadEnv({ path: envFile, override: true })
const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna'
const assistantModel = 'gpt-5.6-terra'
const auditReportModel = 'gpt-5.6-terra'
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null
let slackClient: WebClient | null = null
let slackToken = ''
const outlookStates = new Map<string, { createdAt: number; projectId: string }>()
const outlookRedirectUri = process.env.OUTLOOK_REDIRECT_URI || 'http://127.0.0.1:3001/api/outlook/callback'
const outlookClientId = process.env.OUTLOOK_CLIENT_ID?.trim() || ''
const outlookClientSecret = process.env.OUTLOOK_CLIENT_SECRET?.trim() || ''
const outlookTenant = process.env.OUTLOOK_TENANT_ID?.trim() || 'organizations'
const outlookScopes = 'openid profile offline_access User.Read Calendars.ReadWrite'

const emptyState = (): MissionState => ({
  notes: '',
  theme: 'light',
  interviews: [],
  projectSummary: null,
  projectSummaryUpdatedAt: null,
  mapLanes: [],
  mapNodes: [],
  assistantConversations: [],
  missionActions: [],
  calendarEvents: [],
  contextDocuments: [],
  collaborators: [],
  updatedAt: new Date().toISOString(),
})

let peopleDirectory: DirectoryPerson[] | null = null
/** Prolonge le travail au-delà de la réponse : `waitUntil` en serverless, simple promesse en local. */
function runInBackground(work: Promise<unknown>) {
  try { waitUntil(work) } catch { void work }
}

async function readPeopleDirectory() {
  if (peopleDirectory) return peopleDirectory
  try {
    const html = await fs.readFile(path.join(root, 'cartographie-noyau-employes.html'), 'utf8')
    const match = html.match(/const people=(\[.*?\]);const colors=/s)
    const people = match ? JSON.parse(match[1]) as Array<Partial<DirectoryPerson>> : []
    peopleDirectory = people.filter((person) => person.name).map((person) => ({
      id: String(person.id || person.name), name: String(person.name), title: String(person.title || ''), email: String(person.email || ''), sector: String(person.sector || ''), photo: String(person.photo || ''),
    }))
  } catch { peopleDirectory = [] }
  return peopleDirectory
}

function normalizeParticipants(value: unknown, fallbackName = '', fallbackRole = ''): InterviewParticipant[] {
  const list = Array.isArray(value)
    ? value.map((entry) => ({ name: String((entry as InterviewParticipant)?.name || '').trim().slice(0, 160), role: String((entry as InterviewParticipant)?.role || '').trim().slice(0, 160) })).filter((entry) => entry.name || entry.role)
    : []
  if (list.length) return list.slice(0, 12)
  const name = fallbackName.trim(), role = fallbackRole.trim()
  return name || role ? [{ name, role }] : []
}

function syncPrimaryParticipant(interview: Interview) {
  interview.participant = interview.participants[0]?.name ?? ''
  interview.role = interview.participants[0]?.role ?? ''
}

function normalizeInterview(interview: Interview): Interview {
  interview.participants = normalizeParticipants(interview.participants, interview.participant, interview.role)
  syncPrimaryParticipant(interview)
  return interview
}

function normalizeState(value: Partial<MissionState>): MissionState {
  const empty = emptyState()
  const legacyMessages = (value as Partial<MissionState> & { assistantMessages?: AssistantMessage[] }).assistantMessages
  return {
    ...empty,
    ...value,
    interviews: Array.isArray(value.interviews) ? value.interviews.map(normalizeInterview) : [],
    mapLanes: Array.isArray(value.mapLanes) ? value.mapLanes : [],
    mapNodes: Array.isArray(value.mapNodes) ? value.mapNodes : [],
    assistantConversations: Array.isArray(value.assistantConversations) ? value.assistantConversations : Array.isArray(legacyMessages) && legacyMessages.length ? [{ id: 'legacy-assistant-conversation', title: 'Conversation précédente', messages: legacyMessages, createdAt: value.updatedAt || new Date().toISOString(), updatedAt: value.updatedAt || new Date().toISOString() }] : [],
    missionActions: Array.isArray(value.missionActions) ? value.missionActions : [],
    calendarEvents: Array.isArray(value.calendarEvents) ? value.calendarEvents : [],
    contextDocuments: Array.isArray(value.contextDocuments) ? value.contextDocuments : [],
    collaborators: Array.isArray(value.collaborators) ? value.collaborators : [],
  }
}

async function readState(): Promise<MissionState> {
  const stored = await readProjectState<Partial<MissionState>>(activeProject().id)
  if (!stored) { const fresh = emptyState(); await saveState(fresh); return fresh }
  return normalizeState(stored)
}

async function saveState(next: MissionState) {
  next.updatedAt = new Date().toISOString()
  await writeProjectState(activeProject().id, next)
}

/** Every AI prompt is grounded in the brief of the selected project so each mission stays in its own context. */
function missionBriefing(project = activeProject()) {
  const brief = project.brief
  const lines = [
    `Projet : ${project.name}`,
    `Client : ${project.client || project.name}`,
    `Secteur : ${project.sector || 'Non renseigné'}`,
    `Type de mission : ${project.missionType || 'Mission de conseil'}`,
    `Description donnée par le consultant : ${project.description || 'Non renseignée'}`,
  ]
  if (brief) {
    lines.push(`Objectif : ${brief.objective}`)
    if (brief.scope.length) lines.push(`Périmètre : ${brief.scope.join(' · ')}`)
    if (brief.stakeholders.length) lines.push(`Parties prenantes : ${brief.stakeholders.join(' · ')}`)
    if (brief.keyQuestions.length) lines.push(`Questions clés : ${brief.keyQuestions.join(' · ')}`)
    if (brief.deliverables.length) lines.push(`Livrables attendus : ${brief.deliverables.join(' · ')}`)
  }
  return lines.join('\n')
}

function missionLabel(project = activeProject()) {
  return `${project.missionType || 'mission de conseil'} chez ${project.client || project.name}`
}

function requireOpenAI() {
  if (!openai) throw Object.assign(new Error('La clé OpenAI n’est pas configurée.'), { status: 503 })
  return openai
}

function getSlackClient() {
  loadEnv({ path: envFile, override: true })
  const token = process.env.SLACK_BOT_TOKEN?.trim() ?? ''
  if (!token) { slackClient = null; slackToken = ''; return null }
  if (!slackClient || token !== slackToken) { slackClient = new WebClient(token); slackToken = token }
  return slackClient
}

function outlookConfigured() { return Boolean(outlookClientId && outlookClientSecret) }
function outlookAuthorizeUrl(state: string) {
  const parameters = new URLSearchParams({ client_id: outlookClientId, response_type: 'code', redirect_uri: outlookRedirectUri, response_mode: 'query', scope: outlookScopes, state })
  return `https://login.microsoftonline.com/${encodeURIComponent(outlookTenant)}/oauth2/v2.0/authorize?${parameters}`
}
async function exchangeOutlookToken(parameters: URLSearchParams) {
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(outlookTenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters })
  const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
  if (!response.ok || !payload.access_token) throw Object.assign(new Error(payload.error_description || 'La connexion Outlook a échoué.'), { status: 502 })
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + Math.max(60, payload.expires_in || 3600) * 1000 }
}
async function getOutlookConnection(current: MissionState) {
  const connection = current.outlookConnection
  if (!connection) throw Object.assign(new Error('Connecte Outlook pour accéder à ton agenda.'), { status: 401 })
  if (connection.expiresAt > Date.now() + 60_000) return connection
  if (!connection.refreshToken || !outlookConfigured()) throw Object.assign(new Error('La connexion Outlook a expiré. Reconnecte ton compte.'), { status: 401 })
  const refreshed = await exchangeOutlookToken(new URLSearchParams({ client_id: outlookClientId, client_secret: outlookClientSecret, grant_type: 'refresh_token', refresh_token: connection.refreshToken, redirect_uri: outlookRedirectUri, scope: outlookScopes }))
  current.outlookConnection = { ...connection, ...refreshed, refreshToken: refreshed.refreshToken || connection.refreshToken }; await saveState(current)
  return current.outlookConnection
}
async function outlookRequest(current: MissionState, path: string, init?: RequestInit) {
  const connection = await getOutlookConnection(current)
  const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }
  if (!response.ok) throw Object.assign(new Error(payload.error?.message || 'Outlook a refusé la demande.'), { status: response.status })
  return payload
}

function requireSlack() {
  const client = getSlackClient()
  if (!client) throw Object.assign(new Error('Slack n’est pas configuré. Ajoute SLACK_BOT_TOKEN dans .env.local.'), { status: 503 })
  return client
}

function slackErrorMessage(error: unknown) {
  const detail = error as { data?: { error?: string }; code?: string; message?: string }
  if (detail.data?.error === 'missing_scope') return 'La Slack App n’a pas les permissions nécessaires.'
  if (detail.data?.error === 'not_in_channel') return 'Le bot Slack doit être ajouté à ce canal avant de pouvoir lire ou écrire.'
  if (detail.data?.error === 'channel_not_found') return 'Canal Slack introuvable ou non autorisé.'
  if (detail.data?.error === 'invalid_auth' || detail.data?.error === 'token_revoked') return 'Le token Slack est invalide ou révoqué.'
  return detail.message || 'Erreur de connexion à Slack.'
}

function splitTranscript(transcript: string, maxCharacters = 180_000) {
  const chunks: string[] = []
  let start = 0
  while (start < transcript.length) {
    let end = Math.min(start + maxCharacters, transcript.length)
    if (end < transcript.length) {
      const paragraphBreak = transcript.lastIndexOf('\n\n', end)
      const lineBreak = transcript.lastIndexOf('\n', end)
      const space = transcript.lastIndexOf(' ', end)
      const safeBreak = Math.max(paragraphBreak, lineBreak, space)
      if (safeBreak > start + maxCharacters * 0.7) end = safeBreak
    }
    chunks.push(transcript.slice(start, end).trim())
    start = end
  }
  return chunks.filter(Boolean)
}

function participantsLabel(interview: Interview) {
  if (!interview.participants.length) return 'Non renseigné'
  return interview.participants.map((person) => person.role ? `${person.name} (${person.role})` : person.name).join(', ')
}

async function summarizeTranscriptPart(interview: Interview, transcript: string, part: number, totalParts: number): Promise<InterviewSummary> {
  const client = requireOpenAI()
  const response = await client.responses.parse({
    model,
    reasoning: { effort: 'low' },
    text: { format: zodTextFormat(InterviewSummarySchema, 'interview_summary') },
    input: [
      {
        role: 'system',
        content: `Tu es un analyste senior en conseil et en organisation. Analyse ${totalParts > 1 ? `la partie ${part} sur ${totalParts} d’` : ''}une transcription d’entretien menée dans le cadre de la mission suivante.\n\nCONTEXTE DE MISSION\n${missionBriefing()}\n\nRéponds en français. Sois factuel, détaillé et utile à la prise de décision. Ne complète jamais les informations absentes. Quand un owner ou une échéance n’est pas explicitement mentionné, écris "À définir". Les citations doivent être courtes et fidèles à la transcription.`,
      },
      {
        role: 'user',
        content: `Titre : ${interview.title}\nParticipants : ${participantsLabel(interview)}\nDate : ${interview.date || 'Non renseignée'}\n\nTRANSCRIPTION${totalParts > 1 ? ` — PARTIE ${part}/${totalParts}` : ''}\n${transcript}`,
      },
    ],
  })
  if (!response.output_parsed) throw new Error('OpenAI n’a pas retourné de synthèse structurée.')
  return response.output_parsed
}

async function consolidateInterviewSummaries(interview: Interview, summaries: InterviewSummary[]): Promise<InterviewSummary> {
  const client = requireOpenAI()
  const response = await client.responses.parse({
    model,
    reasoning: { effort: 'low' },
    text: { format: zodTextFormat(InterviewSummarySchema, 'interview_summary') },
    input: [
      {
        role: 'system',
        content: `Tu es un analyste senior en conseil et en organisation. Fusionne plusieurs analyses partielles du même entretien en une synthèse unique, détaillée et structurée en français. Préserve tous les faits importants, décisions, frictions, systèmes, risques, actions et questions. Supprime seulement les doublons. Ne crée aucune information et ne transforme pas une hypothèse en fait.`,
      },
      {
        role: 'user',
        content: `Entretien : ${interview.title}\nParticipants : ${participantsLabel(interview)}\n\nANALYSES PARTIELLES\n${JSON.stringify(summaries)}`,
      },
    ],
  })
  if (!response.output_parsed) throw new Error('OpenAI n’a pas consolidé la synthèse de l’entretien.')
  return response.output_parsed
}

async function summarizeTranscript(interview: Interview): Promise<InterviewSummary> {
  const chunks = splitTranscript(interview.transcript)
  const partials: InterviewSummary[] = []
  for (let index = 0; index < chunks.length; index += 1) {
    partials.push(await summarizeTranscriptPart(interview, chunks[index], index + 1, chunks.length))
  }
  while (partials.length > 1) {
    const nextLevel: InterviewSummary[] = []
    for (let index = 0; index < partials.length; index += 6) {
      nextLevel.push(await consolidateInterviewSummaries(interview, partials.slice(index, index + 6)))
    }
    partials.splice(0, partials.length, ...nextLevel)
  }
  if (!partials[0]) throw new Error('La transcription est vide.')
  return partials[0]
}

async function updateProjectSummary(previous: ProjectSummary | null, interview: Interview): Promise<ProjectSummary> {
  const client = requireOpenAI()
  const response = await client.responses.parse({
    model,
    reasoning: { effort: 'low' },
    text: { format: zodTextFormat(ProjectSummarySchema, 'project_summary') },
    input: [
      {
        role: 'system',
        content: `Tu pilotes la synthèse cumulative de la mission suivante.\n\nCONTEXTE DE MISSION\n${missionBriefing()}\n\nRéponds en français. Mets à jour le résumé projet existant uniquement à partir de la nouvelle synthèse d’entretien. Conserve les constats encore valides, ajoute les nouveaux éléments, signale les contradictions et supprime les doublons. Ne transforme jamais une hypothèse en fait.`,
      },
      {
        role: 'user',
        content: `RÉSUMÉ PROJET ACTUEL\n${previous ? JSON.stringify(previous) : 'Aucun résumé précédent.'}\n\nNOUVELLE SYNTHÈSE D’ENTRETIEN\n${JSON.stringify({ title: interview.title, participant: interview.participant, date: interview.date, summary: interview.summary })}`,
      },
    ],
  })
  if (!response.output_parsed) throw new Error('OpenAI n’a pas retourné de résumé projet structuré.')
  return response.output_parsed
}

async function generateMapSuggestion(interviews: Interview[]): Promise<MapSuggestion> {
  const client = requireOpenAI()
  const source = interviews.map((interview) => ({
    title: interview.title,
    participant: interview.participant || 'Non renseigné',
    role: interview.role || 'Non renseigné',
    participantsLabel: participantsLabel(interview),
    date: interview.date || 'Non renseignée',
    participants: interview.participants,
    summary: interview.summary ?? null,
    transcript: interview.summary ? undefined : interview.transcript.slice(0, 120_000),
  }))
  const response = await client.responses.parse({
    model,
    reasoning: { effort: 'low' },
    text: { format: zodTextFormat(MapSuggestionSchema, 'map_suggestion') },
    input: [
      {
        role: 'system',
        content: `Tu es un analyste senior en conseil et en organisation. À partir des entretiens fournis, propose une cartographie des processus étudiés dans la mission suivante.\n\nCONTEXTE DE MISSION\n${missionBriefing()}\n\nRéponds en français. Cette sortie est une proposition à valider : n’invente aucun fait, système, propriétaire ou étape. Crée au maximum 6 phases et 8 étapes par phase. Pour toute information qui n’est pas explicitement établie, utilise le statut "verify" et écris "À définir" pour l’owner. Utilise "confirmed" uniquement lorsqu’un entretien établit explicitement l’étape. Utilise "friction" uniquement lorsqu’un problème est explicitement décrit. Chaque étape doit comporter une preuve concise citant l’entretien ou le participant source.`,
      },
      { role: 'user', content: `ENTRETIENS SÉLECTIONNÉS\n${JSON.stringify(source)}` },
    ],
  })
  if (!response.output_parsed) throw new Error('OpenAI n’a pas retourné de proposition de cartographie.')
  return response.output_parsed
}

/** Turns the few sentences typed at project creation into the starting context every mission prompt reuses. */
async function generateProjectBrief(description: string, fallbackName: string): Promise<ProjectBrief> {
  const client = requireOpenAI()
  const response = await client.responses.parse({
    model,
    reasoning: { effort: 'low' },
    text: { format: zodTextFormat(ProjectBriefSchema, 'project_brief') },
    input: [
      {
        role: 'system',
        content: `Tu prépares le démarrage d’une mission de conseil à partir de la description libre écrite par le consultant. Réponds en français. Donne un nom de projet court et reconnaissable (le nom du client si tu peux l’identifier). N’invente aucun fait qui ne serait pas plausible : ce qui n’est pas dit doit rester générique et prudent. Le périmètre, les parties prenantes, les questions clés, les livrables et les premières étapes doivent être directement exploitables dès le premier jour de mission. Maximum 6 éléments par liste, formulés en une ligne chacun. Les premières étapes sont des actions concrètes que le consultant peut cocher.`,
      },
      { role: 'user', content: `DESCRIPTION DU PROJET\n${description}${fallbackName ? `\n\nNOM SUGGÉRÉ PAR LE CONSULTANT\n${fallbackName}` : ''}` },
    ],
  })
  if (!response.output_parsed) throw new Error('L’assistant n’a pas réussi à préparer le contexte du projet.')
  return response.output_parsed
}

function assistantContext(current: MissionState) {
  const now = Date.now()
  let documentBudget = 60_000
  const supportingDocuments = current.contextDocuments.map((document) => {
    const extractedText = document.extractedText.slice(0, Math.max(0, Math.min(document.extractedText.length, documentBudget)))
    documentBudget -= extractedText.length
    return { id: document.id, name: document.name, mimeType: document.mimeType, size: document.size, addedAt: document.createdAt, extractedText }
  })
  return {
    generatedAt: new Date().toISOString(),
    notes: current.notes.slice(0, 20_000),
    projectSummary: current.projectSummary,
    interviews: current.interviews.map((interview) => ({ id: interview.id, title: interview.title, participant: interview.participant, role: interview.role, participants: interview.participants, date: interview.date, status: interview.status, summary: interview.summary ?? null, transcript: interview.summary ? undefined : interview.transcript.slice(0, 12_000) })),
    missionActions: current.missionActions.map((action) => ({ id: action.id, text: action.text, done: action.done, source: action.source, updatedAt: action.updatedAt })),
    calendar: current.calendarEvents.slice().sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime)).map((event) => ({ id: event.id, subject: event.subject, start: event.start.dateTime, end: event.end.dateTime, participant: event.participant || '', role: event.role || '', location: event.location?.displayName || '', description: event.bodyPreview || '', isAllDay: Boolean(event.isAllDay), timing: new Date(event.start.dateTime).getTime() >= now ? 'upcoming' : 'past' })),
    collaborators: current.collaborators.map((person) => ({ name: person.name, title: person.title, sector: person.sector, email: person.email })),
    supportingDocuments,
    map: current.mapLanes.sort((a, b) => a.order - b.order).map((lane) => ({ ...lane, nodes: current.mapNodes.filter((node) => node.laneId === lane.id).sort((a, b) => a.order - b.order) })),
  }
}

async function contextVisionContent(current: MissionState, text: string, attachment?: { buffer: Buffer; name: string; mimeType: string }) {
  const content: Array<Record<string, unknown>> = [{ type: 'input_text', text }]
  const visualDocuments = current.contextDocuments.filter((document) => document.mimeType.startsWith('image/') || !document.mimeType.startsWith('text/')).slice(-5)
  for (const document of visualDocuments) {
    try {
      const bytes = await getFile(document.filePath)
      if (bytes.byteLength <= 4 * 1024 * 1024) {
        if (document.mimeType.startsWith('image/')) content.push({ type: 'input_image', image_url: `data:${document.mimeType};base64,${bytes.toString('base64')}`, detail: 'low' })
        else content.push({ type: 'input_file', filename: document.name, file_data: `data:${document.mimeType};base64,${bytes.toString('base64')}` })
      }
    } catch { /* A missing local attachment should not block the assistant. */ }
  }
  if (attachment && attachment.buffer.byteLength <= 12 * 1024 * 1024) {
    const mimeType = attachment.mimeType || 'application/octet-stream'
    if (mimeType.startsWith('image/')) content.push({ type: 'input_image', image_url: `data:${mimeType};base64,${attachment.buffer.toString('base64')}`, detail: 'high' })
    else content.push({ type: 'input_file', filename: attachment.name, file_data: `data:${mimeType};base64,${attachment.buffer.toString('base64')}` })
  }
  return content
}

async function answerAssistant(current: MissionState, question: string, messages: AssistantMessage[], attachment?: { buffer: Buffer; name: string; mimeType: string }): Promise<AssistantReply> {
  const client = requireOpenAI()
  const history = messages.slice(-16).map((message) => ({ role: message.role, content: message.content }))
  const response = await client.responses.parse({
    model: assistantModel,
    reasoning: { effort: 'low' },
    tools: [{ type: 'web_search' }],
    text: { format: zodTextFormat(AssistantReplySchema, 'mission_assistant_reply') },
    input: [
      {
        role: 'system',
        content: `Tu es l’Assistant de mission du projet « ${activeProject().name} ».\n\nCONTEXTE DE MISSION\n${missionBriefing()}\n\nRéponds en français, de façon directe, utile et naturelle. Tu as accès au contexte de Mission Control : entretiens et leurs synthèses, notes, synthèse du projet, actions, agenda, cartographie et documents importés. Hiérarchie impérative des sources : les entretiens, leurs transcriptions et leurs synthèses sont la source principale pour comprendre les pratiques réelles, les retours humains, les frictions et les décisions. Les notes et la synthèse du projet servent à les compléter. Les documents importés sont des sources secondaires : utilise-les seulement lorsqu’ils apportent une preuve ou un détail directement pertinent à la question. Ne laisse jamais un document général ou théorique remplacer un témoignage d’entretien. Si un document contredit un entretien, signale la contradiction et donne la priorité à ce qui a été observé ou déclaré pendant l’entretien, sauf preuve clairement plus récente et directement vérifiable. Avant de répondre, sélectionne les éléments réellement concernés et explique le lien avec la question ; ne récite jamais tout le contenu disponible. Si une information est absente, dis-le sans l’inventer. N’utilise jamais d’astérisque, ni pour mettre en forme ni dans le texte. Pour une question simple, réponds brièvement, idéalement en un court paragraphe. N’écris une réponse exhaustive que si l’utilisateur le demande explicitement ou si la complexité le justifie. Privilégie les paragraphes rédigés ; évite les listes et les retours à la ligne superflus. Utilise une liste uniquement lorsqu’elle améliore réellement la clarté et limite-la alors à quelques éléments. Distingue strictement les faits établis des hypothèses. Utilise la recherche web seulement si l’utilisateur demande une information externe ou récente. Tu peux préparer une action confirmable pour toute donnée modifiable de l’application : notes, prochaines actions, rendez-vous de l’agenda, entretiens et rubriques de synthèse, ainsi que phases et étapes de cartographie. Choisis l’action la plus précise. Ne prétends jamais avoir appliqué une modification : elle devra toujours être confirmée dans l’interface. Les rendez-vous doivent avoir des dates ISO complètes avec fuseau horaire, et une fin postérieure au début. Lorsqu’on te demande de générer un document, un livrable ou une présentation HTML, propose exactement une action generate_document avec un titre clair, le format approprié et un brief éditorial complet. Pour créer une cartographie complète, utilise une seule action create_map. Limite les actions à 6. Ne propose jamais de suppression sans demande explicite.`,
      },
      { role: 'user', content: await contextVisionContent(current, `CONTEXTE ACTUEL\n${JSON.stringify(assistantContext(current))}\n\nHISTORIQUE RÉCENT\n${JSON.stringify(history)}\n\nDEMANDE UTILISATEUR\n${question}${attachment ? `\n\nPIÈCE JOINTE À ANALYSER\nLe fichier « ${attachment.name} » est joint à cette demande. Analyse-le directement et relie ta réponse à la question de l’utilisateur.` : ''}`) as any },
    ],
  })
  if (!response.output_parsed) throw new Error('OpenAI n’a pas retourné de réponse exploitable.')
  return response.output_parsed
}

async function generateMissionDocument(current: MissionState, action: Extract<AssistantAction, { type: 'generate_document' }>) {
  const client = requireOpenAI()
  const response = await client.responses.create({
    model,
    reasoning: { effort: 'low' },
    input: [
      { role: 'system', content: `You are an exceptional editorial designer and front-end developer. Create a complete, polished, self-contained HTML ${action.format === 'presentation' ? 'presentation deck' : 'document'} in French from the provided brief and mission context. Output only the final HTML beginning with <!doctype html>. Use refined custom CSS, a premium light blue-and-white liquid-glass visual language, sophisticated typography using safe web fonts, strong hierarchy, generous whitespace, and responsive layout. Make it look intentionally designed, creative and executive-ready. Keep the result focused and under 1,400 words. Do not use external images, JavaScript, frameworks, or external dependencies. Do not invent facts: clearly label hypotheses as such. Include all content needed for the requested deliverable and make it printable.` },
      { role: 'user', content: `BRIEF\n${action.brief}\n\nTITRE\n${action.title}\n\nCONTEXTE DE MISSION\n${missionBriefing()}\n\nMISSION CONTEXT\n${JSON.stringify(assistantContext(current))}` },
    ],
  })
  const html = response.output_text.replace(/^```html\s*/i, '').replace(/\s*```$/, '').trim()
  if (!html.toLowerCase().startsWith('<!doctype html')) throw new Error('Le document généré est incomplet. Réessaie.')
  const safeTitle = action.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document'
  const filename = `${safeTitle}-${Date.now()}.html`
  await putFile(`documents/${filename}`, html, 'text/html; charset=utf-8')
  const encoded = encodeURIComponent(filename)
  return { title: action.title, filename, downloadUrl: `/api/documents/${encoded}`, viewUrl: `/api/documents/${encoded}/view`, openUrl: `/api/documents/${encoded}/open` }
}

async function generateAuditReport(current: MissionState) {
  const client = requireOpenAI()
  const directory = current.collaborators
  const names = new Set([...current.interviews.flatMap((item) => item.participants.map((person) => person.name.trim().toLowerCase())), ...current.calendarEvents.map((item) => item.participant?.trim().toLowerCase() || '')].filter(Boolean))
  const profiles = directory.filter((person) => names.has(person.name.toLowerCase())).map(({ name, title, sector, photo }) => ({ name, title, sector, photo }))
  const { map: _unvalidatedInAppMap, ...validatedMissionContext } = assistantContext(current)
  const reportContext = { ...validatedMissionContext, interviewedProfiles: profiles }
  const response = await client.responses.create({
    model: auditReportModel,
    reasoning: { effort: 'medium' },
    input: [
      { role: 'system', content: `You are a senior audit partner and an exceptional information designer. Create a complete, detailed, executive-ready audit progress report as a single self-contained HTML document. The report covers the following mission, and every section must stay inside that scope:\n${missionBriefing()}\n Write every part of the report in clear professional English, including section titles, captions, findings, limitations, and recommendations. Treat interviews and interview syntheses as the primary evidence of real practices and human feedback. Treat notes and the project summary as supporting interpretation. Treat imported documents as secondary corroborating material: use them only when directly relevant, and never let a generic document replace a specific interview finding. If sources conflict, explain the conflict and privilege the interview evidence unless a clearly newer, directly verifiable document resolves it. Output only HTML beginning with <!doctype html>. Use no JavaScript, no external CSS, and no markdown. Use a premium editorial visual system: white and very light blue canvas, deep navy typography, electric blue accents, liquid-glass cards, strong spacing, bento grids, process lanes, timelines, progress indicators, callout blocks, and print-friendly responsive CSS. Use the provided participant photo URLs in img tags next to the relevant interview cards; do not invent or replace URLs. If a profile photo is missing, use a refined initials avatar made with CSS. Keep the report substantial but focused, roughly 1,800–3,000 words. Use complete explanatory sentences and short paragraphs. Do not fill the page with isolated keywords, unexplained labels, jargon tiles, or fragments. Every finding must explain what was observed, why it matters, and what evidence supports it, so an executive who did not attend the interviews can understand it. When something is uncertain, write a precise sentence explaining what remains unknown and why it matters. Include these sections in this order: 1) a cover/header with report title, audit scope, generation date and coverage indicators; 2) a detailed Executive Summary explaining concretely what has been done, what feedback has emerged, the current level of confidence, and what remains unresolved; 3) Audit coverage and progress, with visual metrics grounded in the data; 4) Interview findings, one visual card per interview with participant photo when available, role, date, purpose, detailed but readable findings, decisions, frictions, risks, open questions and implications; 5) Evidence-based end-to-end process maps; 6) Cross-audit themes and key issues; 7) Decisions, priorities and risks; 8) Recommended next steps and a practical sequence for the next interviews; 9) an evidence and limitations note. For section 5, build the end-to-end process maps yourself by cross-referencing the interviews, their summaries, notes, project summary, mission actions, and calendar context. Do not use, quote, or rely on the in-application mapping feature; it has deliberately been excluded from your source material. Only show processes that are sufficiently evidenced. Render each identified process as a dedicated visual map, not a plain list or generic table: use a process title and one-sentence purpose, then a horizontal or vertical sequence of numbered glass step cards connected by clear arrows, with distinct styling for handoffs and decision gates. Every step card must show the stage name, a plain-English explanation, the responsible team or role, the system involved, and a short evidence sentence. Add a compact legend explaining colors and statuses, and show known gaps or uncertain links as visibly separated callouts. Keep each map readable on screen and printable, and never collapse the process into keyword chips. For each process, describe the actual sequence of stages, handoffs, systems, decision points, and known failure modes in clear sentences. If an end-to-end link is not evidenced, show the gap explicitly rather than inventing a connection. Never invent facts, dates, accountable teams, feedback, metrics, or process steps. Clearly explain hypotheses, missing information, and items that still require verification. Favor visual hierarchy and concise paragraphs over huge tables. Ensure every factual claim can be traced to the supplied context.` },
      { role: 'system', content: `VISUAL CARTOGRAPHY REQUIREMENT: Section 5 must look like a polished process-design deliverable. For every evidenced process, create a dedicated <article class="process-map"> with a clear title, purpose sentence, and a visible legend. Inside it, use a <div class="flow-track"> containing numbered <div class="flow-step"> cards connected by large visible arrow elements. Each card must have a stage name, a short explanatory paragraph, a “Responsible” line, a “System” line, and an “Evidence” line. Use separate classes such as handoff, decision-gate, and evidence-gap so handoffs, decisions, and uncertainty are visually distinct. Add a final evidence-gap callout when the end-to-end chain is incomplete. Include embedded responsive CSS for .process-map, .flow-track, .flow-step, arrows, decision gates, handoffs, and evidence gaps: glass surfaces, navy text, electric-blue connectors, subtle shadows, consistent spacing, CSS counters/number badges, horizontal flow on wide screens, vertical flow on small screens, and print-safe page breaks. Do not render this section as a generic table, a row of keyword chips, or unnumbered text blocks. The reader should understand the journey by following the arrows from left to right (or top to bottom on mobile).` },
      { role: 'user', content: await contextVisionContent(current, `COMPLETE MISSION CONTEXT\n${JSON.stringify(reportContext)}\n\nCRITICAL RULE\nDescribe the current state of the audit exactly as evidenced. Do not fill gaps with assumptions. The report itself must be entirely in English.`) as any },
    ],
  })
  const html = response.output_text.replace(/^```html\s*/i, '').replace(/\s*```$/, '').trim()
  if (!html.toLowerCase().startsWith('<!doctype html')) throw new Error('Le rapport d’audit généré est incomplet. Réessaie.')
  const projectSlug = activeProject().name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projet'
  const filename = `Rapport-audit-${projectSlug}-${Date.now()}.html`
  await putFile(`documents/${filename}`, html, 'text/html; charset=utf-8')
  const encoded = encodeURIComponent(filename)
  return { title: `Rapport d’audit — ${activeProject().name}`, filename, downloadUrl: `/api/documents/${encoded}`, viewUrl: `/api/documents/${encoded}/view`, openUrl: `/api/documents/${encoded}/open`, model: auditReportModel }
}

function assistantCalendarPayload(event: Extract<AssistantAction, { type: 'create_calendar_event' }>['event']) {
  return calendarEventPayload({
    subject: event.subject,
    start: { dateTime: event.startDateTime },
    end: { dateTime: event.endDateTime },
    location: { displayName: event.location },
    body: { content: event.description },
    participant: event.participant,
    role: event.role,
    isAllDay: event.isAllDay,
  })
}

function applyAssistantAction(current: MissionState, action: AssistantAction) {
  const now = new Date().toISOString()
  if (action.type === 'update_notes') { current.notes = action.notes.slice(0, 200_000); return }
  if (action.type === 'create_mission_action') {
    const text = action.text.trim().slice(0, 300)
    if (!text) throw Object.assign(new Error('L’action à créer est vide.'), { status: 422 })
    current.missionActions.unshift({ id: randomUUID(), text, done: action.done, source: 'ai', createdAt: now, updatedAt: now }); return
  }
  if (action.type === 'update_mission_action') {
    const item = current.missionActions.find((entry) => entry.id === action.actionId)
    if (!item) throw Object.assign(new Error('L’action ciblée n’existe plus.'), { status: 404 })
    const text = action.text.trim().slice(0, 300)
    if (!text) throw Object.assign(new Error('L’action ne peut pas être vide.'), { status: 422 })
    item.text = text; item.done = action.done; item.updatedAt = now; return
  }
  if (action.type === 'delete_mission_action') {
    if (!current.missionActions.some((entry) => entry.id === action.actionId)) throw Object.assign(new Error('L’action ciblée n’existe plus.'), { status: 404 })
    current.missionActions = current.missionActions.filter((entry) => entry.id !== action.actionId); return
  }
  if (action.type === 'create_calendar_event') {
    current.calendarEvents.push({ id: randomUUID(), ...assistantCalendarPayload(action.event), createdAt: now, updatedAt: now }); return
  }
  if (action.type === 'update_calendar_event') {
    const event = current.calendarEvents.find((entry) => entry.id === action.eventId)
    if (!event) throw Object.assign(new Error('Le rendez-vous ciblé n’existe plus.'), { status: 404 })
    Object.assign(event, assistantCalendarPayload(action.event), { updatedAt: now }); return
  }
  if (action.type === 'delete_calendar_event') {
    if (!current.calendarEvents.some((entry) => entry.id === action.eventId)) throw Object.assign(new Error('Le rendez-vous ciblé n’existe plus.'), { status: 404 })
    current.calendarEvents = current.calendarEvents.filter((entry) => entry.id !== action.eventId); return
  }
  if (action.type === 'create_map') {
    for (const suggestedLane of action.lanes.slice(0, 6)) {
      const lane: MapLane = { id: randomUUID(), name: suggestedLane.name.trim().slice(0, 120) || 'Phase suggérée', description: suggestedLane.description.trim().slice(0, 300), order: current.mapLanes.length }
      current.mapLanes.push(lane)
      for (const suggestedNode of suggestedLane.nodes.slice(0, 8)) current.mapNodes.push({ id: randomUUID(), laneId: lane.id, label: suggestedNode.label.trim().slice(0, 120) || 'Étape suggérée', description: suggestedNode.description.trim().slice(0, 500), owner: suggestedNode.owner.trim().slice(0, 120) || 'À définir', status: suggestedNode.status, systems: suggestedNode.systems.map((system) => system.trim()).filter(Boolean).slice(0, 20), evidence: suggestedNode.evidence.trim().slice(0, 2_000), order: current.mapNodes.filter((node) => node.laneId === lane.id).length })
    }
    return
  }
  if (action.type === 'update_lane') { const lane = current.mapLanes.find((item) => item.id === action.laneId); if (!lane) throw Object.assign(new Error('La phase ciblée n’existe plus.'), { status: 404 }); lane.name = action.name.trim().slice(0, 120); lane.description = action.description.trim().slice(0, 300); return }
  if (action.type === 'delete_lane') { if (!current.mapLanes.some((item) => item.id === action.laneId)) throw Object.assign(new Error('La phase ciblée n’existe plus.'), { status: 404 }); current.mapLanes = current.mapLanes.filter((item) => item.id !== action.laneId); current.mapNodes = current.mapNodes.filter((item) => item.laneId !== action.laneId); return }
  if (action.type === 'update_node') { const node = current.mapNodes.find((item) => item.id === action.nodeId); if (!node) throw Object.assign(new Error('L’étape ciblée n’existe plus.'), { status: 404 }); node.label = action.labelValue.trim().slice(0, 120); node.description = action.description.trim().slice(0, 500); node.owner = action.owner.trim().slice(0, 120); node.status = action.status; node.systems = action.systems.map((system) => system.trim()).filter(Boolean).slice(0, 20); node.evidence = action.evidence.trim().slice(0, 2_000); return }
  if (action.type === 'delete_node') { if (!current.mapNodes.some((item) => item.id === action.nodeId)) throw Object.assign(new Error('L’étape ciblée n’existe plus.'), { status: 404 }); current.mapNodes = current.mapNodes.filter((item) => item.id !== action.nodeId); return }
  if (action.type === 'create_interview') {
    current.interviews.unshift({ id: randomUUID(), title: action.title.trim().slice(0, 160) || 'Nouvel entretien', participant: action.participant.trim().slice(0, 160), role: action.role.trim().slice(0, 160), participants: normalizeParticipants(null, action.participant, action.role), date: action.date.trim().slice(0, 160) || new Date().toISOString().slice(0, 10), transcript: action.transcript.slice(0, 5_000_000), status: 'draft', createdAt: now, updatedAt: now }); return
  }
  if (action.type === 'update_interview') { const interview = current.interviews.find((item) => item.id === action.interviewId); if (!interview) throw Object.assign(new Error('L’entretien ciblé n’existe plus.'), { status: 404 }); interview.title = action.title.trim().slice(0, 160); interview.participant = action.participant.trim().slice(0, 160); interview.role = action.role.trim().slice(0, 160); interview.participants = normalizeParticipants(interview.participants.slice(1), '', '').length ? [{ name: interview.participant, role: interview.role }, ...interview.participants.slice(1)] : normalizeParticipants(null, interview.participant, interview.role); interview.date = action.date.trim().slice(0, 160); interview.updatedAt = now }
  if (action.type === 'update_interview_summary_section') {
    const interview = current.interviews.find((item) => item.id === action.interviewId)
    if (!interview?.summary) throw Object.assign(new Error('La synthèse ciblée n’existe plus.'), { status: 404 })
    interview.summary[action.section] = action.items.map((item) => item.trim().slice(0, 10_000)).filter(Boolean)
    interview.updatedAt = now; return
  }
  if (action.type === 'delete_interview') {
    const interview = current.interviews.find((item) => item.id === action.interviewId)
    if (!interview) throw Object.assign(new Error('L’entretien ciblé n’existe plus.'), { status: 404 })
    current.interviews = current.interviews.filter((item) => item.id !== action.interviewId)
    if (interview.summary) { current.projectSummary = null; current.projectSummaryUpdatedAt = null }
  }
}

async function processInterview(id: string) {
  const current = await readState()
  const interview = current.interviews.find((item) => item.id === id)
  if (!interview) throw Object.assign(new Error('Entretien introuvable.'), { status: 404 })
  if (!interview.transcript.trim()) throw Object.assign(new Error('La transcription est vide.'), { status: 422 })
  interview.status = 'processing'; interview.error = undefined; interview.updatedAt = new Date().toISOString(); await saveState(current)
  try {
    interview.summary = await summarizeTranscript(interview)
    interview.status = 'complete'; interview.updatedAt = new Date().toISOString()
    current.projectSummary = await updateProjectSummary(current.projectSummary, interview)
    current.projectSummaryUpdatedAt = new Date().toISOString()
    await saveState(current)
    return { interview, projectSummary: current.projectSummary, projectSummaryUpdatedAt: current.projectSummaryUpdatedAt }
  } catch (error) {
    interview.status = 'error'; interview.error = error instanceof Error ? error.message : 'Erreur OpenAI inconnue.'; interview.updatedAt = new Date().toISOString(); await saveState(current)
    throw error
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '8mb' }))

app.use('/api', requireSession)

app.all('/api/admin/users', async (req, res, next) => {
  try {
    const header = req.header('authorization') ?? ''
    const result = await handleAdminUsers(req.method, header.startsWith('Bearer ') ? header.slice(7) : '', (req.body ?? {}) as Record<string, unknown>)
    if (result.status === 405) res.setHeader('Allow', 'GET, POST, PATCH, DELETE')
    res.status(result.status).json(result.body)
  } catch (error) { next(error) }
})

/** Resolves the mission the request belongs to; project-free routes (health, projects, documents) simply run without one. */
app.use('/api', (req, res, next) => {
  const identifier = (req.header('x-project-id') || (typeof req.query.projectId === 'string' ? req.query.projectId : '') || '').trim()
  if (!identifier) return next()
  void findProject(identifier).then((project) => {
    if (!project) return res.status(404).json({ error: 'Projet introuvable. Retourne au tableau de bord.' })
    withProject(project, next)
  }).catch(next)
})

app.get('/api/health', (_req, res) => res.json({ ok: true, openaiConfigured: Boolean(openai), authConfigured: authConfigured(), storage: storageMode, model }))

app.get('/api/projects', async (_req, res, next) => {
  try {
    const projects = await listProjects()
    res.json({ projects: await Promise.all(projects.map(async (project) => ({ ...project, stats: await projectStats(project.id) }))) })
  } catch (error) { next(error) }
})

app.post('/api/projects', async (req, res, next) => {
  try {
    const description = String((req.body as { description?: string }).description || '').trim()
    const fallbackName = String((req.body as { name?: string }).name || '').trim()
    if (description.length < 12) return res.status(400).json({ error: 'Décris le projet en quelques phrases pour que l’assistant puisse démarrer avec du contexte.' })
    const brief = openai ? await generateProjectBrief(description, fallbackName) : null
    const project = await insertProject({
      name: brief?.name || fallbackName || description.split(/[.\n]/)[0].slice(0, 60),
      client: brief?.client || fallbackName || '',
      sector: brief?.sector || '',
      missionType: brief?.missionType || '',
      description,
      brief,
      createdBy: currentUser().id,
      createdByEmail: currentUser().email,
    })
    const seeded = emptyState()
    const now = new Date().toISOString()
    seeded.missionActions = (brief?.firstSteps || []).slice(0, 8).map((text: string) => ({ id: randomUUID(), text, done: false, source: 'ai' as const, createdAt: now, updatedAt: now }))
    await withProject(project, () => saveState(seeded))
    res.status(201).json({ project, briefGenerated: Boolean(brief) })
  } catch (error) { next(error) }
})

app.get('/api/projects/:id', async (req, res, next) => {
  try {
    const project = await findProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'Projet introuvable.' })
    res.json({ project, stats: await projectStats(project.id) })
  } catch (error) { next(error) }
})

app.put('/api/projects/:id', async (req, res, next) => {
  try {
    const body = req.body as Partial<Project>
    res.json({ project: await patchProject(req.params.id, { name: body.name, client: body.client, sector: body.sector, missionType: body.missionType, description: body.description, accent: body.accent, archived: body.archived }) })
  } catch (error) { next(error) }
})

app.delete('/api/projects/:id', async (req, res, next) => {
  try {
    const project = await findProject(req.params.id)
    if (!project) return res.status(404).json({ error: 'Projet introuvable.' })
    const user = currentUser()
    // Un projet appartient à l'équipe : son créateur ou un administrateur peut le supprimer.
    if (project.createdBy && project.createdBy !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'Seul le créateur du projet ou un administrateur peut le supprimer.' })
    }
    res.json({ deleted: await removeProject(req.params.id) })
  } catch (error) { next(error) }
})

app.get('/api/state', async (_req, res) => res.json({ ...await readState(), project: activeProject() }))
app.get('/api/people', async (_req, res) => res.json((await readState()).collaborators))

function collaboratorPayload(body: Record<string, unknown>) {
  return {
    name: String(body.name || '').trim(),
    title: String(body.title || '').trim(),
    email: String(body.email || '').trim(),
    sector: String(body.sector || '').trim(),
    photo: String(body.photo || '').trim(),
  }
}

app.post('/api/collaborators', async (req, res) => {
  const payload = collaboratorPayload(req.body as Record<string, unknown>)
  if (!payload.name) return res.status(400).json({ error: 'Le nom du collaborateur est obligatoire.' })
  const current = await readState()
  const person: DirectoryPerson = { id: randomUUID(), ...payload }
  current.collaborators = [...current.collaborators, person]
  await saveState(current)
  res.status(201).json(person)
})

app.put('/api/collaborators/:id', async (req, res) => {
  const current = await readState()
  const existing = current.collaborators.find((person) => person.id === req.params.id)
  if (!existing) return res.status(404).json({ error: 'Collaborateur introuvable.' })
  const payload = collaboratorPayload(req.body as Record<string, unknown>)
  if (!payload.name) return res.status(400).json({ error: 'Le nom du collaborateur est obligatoire.' })
  const updated: DirectoryPerson = { ...existing, ...payload }
  current.collaborators = current.collaborators.map((person) => person.id === updated.id ? updated : person)
  await saveState(current)
  res.json(updated)
})

app.delete('/api/collaborators/:id', async (req, res) => {
  const current = await readState()
  const deleted = current.collaborators.find((person) => person.id === req.params.id)
  if (!deleted) return res.status(404).json({ error: 'Collaborateur introuvable.' })
  current.collaborators = current.collaborators.filter((person) => person.id !== deleted.id)
  await saveState(current)
  res.json({ deleted })
})

app.post('/api/collaborators/restore', async (req, res) => {
  const current = await readState()
  const person = (req.body as { person?: DirectoryPerson }).person
  if (!person?.id) return res.status(400).json({ error: 'Collaborateur invalide.' })
  current.collaborators = [...current.collaborators.filter((item) => item.id !== person.id), person]
  await saveState(current)
  res.status(201).json(person)
})

app.get('/api/slack/status', async (_req, res) => {
  const client = getSlackClient()
  if (!client) return res.json({ configured: false, connected: false })
  try {
    const identity = await client.auth.test()
    res.json({ configured: true, connected: true, team: identity.team ?? '', user: identity.user ?? '', botId: identity.bot_id ?? '' })
  } catch (error) {
    res.json({ configured: true, connected: false, error: slackErrorMessage(error) })
  }
})

app.get('/api/slack/channels', async (_req, res, next) => {
  try {
    const client = requireSlack()
    const result = await client.conversations.list({ exclude_archived: true, types: 'im', limit: 200 })
    const conversations = (result.channels ?? []).filter((channel) => channel.id)
    const people = await Promise.all(conversations.map(async (channel) => {
      if (!channel.user) return null
      try {
        const user = await client.users.info({ user: channel.user })
        return [channel.user, user.user?.real_name || user.user?.profile?.display_name || user.user?.name || channel.user] as const
      } catch { return [channel.user, channel.user] as const }
    }))
    const names = new Map(people.filter((item): item is readonly [string, string] => Boolean(item)))
    res.json(conversations.map((channel) => ({
      id: channel.id,
      name: names.get(channel.user ?? '') || 'Message direct',
      isPrivate: true,
      purpose: 'Message direct avec le bot',
    })))
  } catch (error) { next(error) }
})

app.get('/api/slack/messages', async (req, res, next) => {
  try {
    const channel = typeof req.query.channel === 'string' ? req.query.channel : ''
    if (!channel) return res.status(422).json({ error: 'Sélectionne un canal Slack.' })
    const client = requireSlack()
    const result = await client.conversations.history({ channel, limit: 50 })
    res.json((result.messages ?? []).filter((message) => message.type === 'message').reverse().map((message) => ({
      ts: message.ts ?? '', text: message.text ?? '', user: message.user ?? message.bot_id ?? 'Slack', threadTs: message.thread_ts ?? null,
    })))
  } catch (error) { next(error) }
})

app.put('/api/notes', async (req, res) => {
  const current = await readState(); current.notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 200_000) : current.notes
  await saveState(current); res.json({ notes: current.notes, updatedAt: current.updatedAt })
})

app.post('/api/actions/sync', async (req, res) => {
  const texts = Array.isArray(req.body.texts) ? req.body.texts.filter((text: unknown): text is string => typeof text === 'string').map((text: string) => text.trim().slice(0, 300)).filter(Boolean).slice(0, 20) : []
  const current = await readState(); const now = new Date().toISOString()
  for (const text of texts) if (!current.missionActions.some((action) => action.text.toLowerCase() === text.toLowerCase())) current.missionActions.push({ id: randomUUID(), text, done: false, source: 'ai', createdAt: now, updatedAt: now })
  await saveState(current); res.json({ actions: current.missionActions })
})

app.post('/api/actions', async (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 300) : ''
  if (!text) return res.status(422).json({ error: 'Écris une action.' })
  const current = await readState(); const now = new Date().toISOString(); const action: MissionAction = { id: randomUUID(), text, done: false, source: 'manual', createdAt: now, updatedAt: now }
  current.missionActions.unshift(action); await saveState(current); res.status(201).json(action)
})

app.put('/api/actions/:id', async (req, res) => {
  const current = await readState(); const action = current.missionActions.find((item) => item.id === req.params.id)
  if (!action) return res.status(404).json({ error: 'Action introuvable.' })
  if (typeof req.body.text === 'string') { const text = req.body.text.trim().slice(0, 300); if (!text) return res.status(422).json({ error: 'Écris une action.' }); action.text = text }
  if (typeof req.body.done === 'boolean') action.done = req.body.done
  action.updatedAt = new Date().toISOString(); await saveState(current); res.json(action)
})

app.delete('/api/actions/:id', async (req, res) => {
  const current = await readState(); const action = current.missionActions.find((item) => item.id === req.params.id)
  if (!action) return res.status(404).json({ error: 'Action introuvable.' })
  current.missionActions = current.missionActions.filter((item) => item.id !== action.id); await saveState(current); res.json({ deleted: action })
})

app.post('/api/actions/restore', async (req, res) => {
  const action = req.body.action as MissionAction | undefined
  if (!action?.id || !action.text) return res.status(422).json({ error: 'Action à restaurer invalide.' })
  const current = await readState(); if (!current.missionActions.some((item) => item.id === action.id)) current.missionActions.unshift(action); await saveState(current); res.status(201).json(action)
})

app.put('/api/preferences', async (req, res) => {
  const current = await readState(); const theme = req.body.theme
  if (['light', 'midnight', 'ocean', 'sunset'].includes(theme)) current.theme = theme
  await saveState(current); res.json({ theme: current.theme })
})

function calendarEventPayload(body: Record<string, unknown>) {
  const startValue = typeof (body.start as { dateTime?: unknown } | undefined)?.dateTime === 'string' ? (body.start as { dateTime: string }).dateTime : ''
  const endValue = typeof (body.end as { dateTime?: unknown } | undefined)?.dateTime === 'string' ? (body.end as { dateTime: string }).dateTime : ''
  const start = new Date(startValue); const end = new Date(endValue)
  if (!startValue || !endValue || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw Object.assign(new Error('Choisis une heure de fin postérieure au début.'), { status: 422 })
  return { subject: String(body.subject || 'Sans titre').trim().slice(0, 200), start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, location: { displayName: String((body.location as { displayName?: unknown } | undefined)?.displayName || '').trim().slice(0, 250) }, bodyPreview: String((body.body as { content?: unknown } | undefined)?.content || '').trim().slice(0, 10_000), participant: String(body.participant || '').trim().slice(0, 160), role: String(body.role || '').trim().slice(0, 160), isAllDay: Boolean(body.isAllDay) }
}

app.get('/api/calendar/events', async (req, res) => {
  const start = new Date(typeof req.query.start === 'string' ? req.query.start : Date.now()); const end = new Date(typeof req.query.end === 'string' ? req.query.end : Date.now() + 7 * 86_400_000)
  const current = await readState(); const events = current.calendarEvents.filter((event) => new Date(event.start.dateTime) < end && new Date(event.end.dateTime) > start).sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime)); res.json({ events })
})
app.post('/api/calendar/events', async (req, res, next) => {
  try { const current = await readState(); const now = new Date().toISOString(); const event: LocalCalendarEvent = { id: randomUUID(), ...calendarEventPayload(req.body), createdAt: now, updatedAt: now }; current.calendarEvents.push(event); await saveState(current); res.status(201).json(event) } catch (error) { next(error) }
})
app.put('/api/calendar/events/:id', async (req, res, next) => {
  try { const current = await readState(); const event = current.calendarEvents.find((item) => item.id === req.params.id); if (!event) return res.status(404).json({ error: 'Rendez-vous introuvable.' }); Object.assign(event, calendarEventPayload(req.body), { updatedAt: new Date().toISOString() }); await saveState(current); res.json(event) } catch (error) { next(error) }
})
app.delete('/api/calendar/events/:id', async (req, res) => {
  const current = await readState(); const before = current.calendarEvents.length; current.calendarEvents = current.calendarEvents.filter((item) => item.id !== req.params.id); if (current.calendarEvents.length === before) return res.status(404).json({ error: 'Rendez-vous introuvable.' }); await saveState(current); res.status(204).end()
})

app.post('/api/calendar/events/:id/interview-guide', async (req, res, next) => {
  try {
    const current = await readState()
    const event = current.calendarEvents.find((item) => item.id === req.params.id)
    if (!event) return res.status(404).json({ error: 'Rendez-vous introuvable.' })
    const subject = event.subject || event.participant || 'rendez-vous'
    const participant = event.participant ? ` avec ${event.participant}${event.role ? ` (${event.role})` : ''}` : ''
    const action: Extract<AssistantAction, { type: 'generate_document' }> = {
      type: 'generate_document', label: `Générer le guide d’entretien · ${subject}`, title: `Guide d’entretien — ${subject}`, format: 'document',
      brief: `Crée un guide pratique non exhaustif pour le rendez-vous « ${subject} »${participant}. Le document doit commencer par une section très visible « Pourquoi cet entretien est particulièrement intéressant » en français : explique précisément ce que le poste, les responsabilités et la position de cette personne peuvent apporter à l’audit, quelles zones d’ombre elle est la mieux placée pour éclairer et comment cet échange complète les entretiens déjà réalisés. Cette justification doit piloter tout le reste du guide. Le guide doit contenir exactement 10 questions à poser, rédigées en anglais naturel et professionnel, entièrement adaptées au rôle, au périmètre et aux enjeux de cette personne ; ne produis surtout pas une liste générique réutilisable pour n’importe quel participant. Pour chaque question, ajoute une courte intention en français expliquant pourquoi elle est pertinente pour ce profil et ce que l’enquêteur cherche à comprendre. Ajoute ensuite une section « Préparation de l’entretien » en français, avec l’objectif ciblé de cet entretien, les éléments du contexte de mission à garder en tête, les hypothèses spécifiques à tester et les signaux à écouter chez cette personne. Termine par une section française « À noter pendant l’échange » et une courte consigne de suivi. Appuie-toi uniquement sur les faits présents dans le contexte de Mission Control, notamment le rôle et le participant du rendez-vous, les autres entretiens déjà menés, les synthèses, les notes, la cartographie, les actions ouvertes et l’agenda. Si le rôle ou le contexte est insuffisamment renseigné, indique précisément ce qui manque au lieu d’inventer, et formule les questions pour le vérifier. Signale clairement les éléments à confirmer et n’invente aucune information. Le document doit être directement utilisable pendant une conversation et rester lisible en impression.`,
    }
    const document = await generateMissionDocument(current, action)
    res.json({ ...document, eventId: event.id })
  } catch (error) { next(error) }
})

app.get('/api/outlook/status', async (_req, res) => {
  const current = await readState(); const connection = current.outlookConnection
  res.json({ configured: outlookConfigured(), connected: Boolean(connection), account: connection?.account, name: connection?.name, redirectUri: outlookRedirectUri })
})

app.get('/api/outlook/connect', (_req, res) => {
  if (!outlookConfigured()) return res.status(503).json({ error: 'Ajoute OUTLOOK_CLIENT_ID et OUTLOOK_CLIENT_SECRET dans .env.local avant de connecter Outlook.', redirectUri: outlookRedirectUri })
  const state = randomUUID(); outlookStates.set(state, { createdAt: Date.now(), projectId: activeProject().id })
  res.redirect(outlookAuthorizeUrl(state))
})

app.get('/api/outlook/callback', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : ''; const state = typeof req.query.state === 'string' ? req.query.state : ''
    const pending = outlookStates.get(state); outlookStates.delete(state)
    if (!code || !pending || Date.now() - pending.createdAt > 10 * 60_000) throw Object.assign(new Error('La demande de connexion Outlook a expiré. Réessaie.'), { status: 400 })
    const project = await findProject(pending.projectId)
    if (!project) throw Object.assign(new Error('Projet introuvable.'), { status: 404 })
    const token = await exchangeOutlookToken(new URLSearchParams({ client_id: outlookClientId, client_secret: outlookClientSecret, code, redirect_uri: outlookRedirectUri, grant_type: 'authorization_code' }))
    await withProject(project, async () => {
      const current = await readState(); current.outlookConnection = token
      const profile = await outlookRequest(current, '/me?$select=displayName,mail,userPrincipalName') as { displayName?: string; mail?: string; userPrincipalName?: string }
      current.outlookConnection = { ...token, name: profile.displayName, account: profile.mail || profile.userPrincipalName }; await saveState(current)
    })
    res.redirect(`http://127.0.0.1:5173/workspace.html?project=${encodeURIComponent(project.id)}&outlook=connected`)
  } catch (error) { next(error) }
})

app.post('/api/outlook/disconnect', async (_req, res) => { const current = await readState(); delete current.outlookConnection; await saveState(current); res.status(204).end() })

app.get('/api/outlook/events', async (req, res, next) => {
  try {
    const start = typeof req.query.start === 'string' ? req.query.start : new Date().toISOString(); const end = typeof req.query.end === 'string' ? req.query.end : new Date(Date.now() + 7 * 86_400_000).toISOString()
    const current = await readState(); const params = new URLSearchParams({ startDateTime: start, endDateTime: end, '$select': 'id,subject,start,end,location,bodyPreview,isAllDay,webLink', '$orderby': 'start/dateTime' })
    const result = await outlookRequest(current, `/me/calendarView?${params}`, { headers: { Prefer: 'outlook.timezone="America/New_York"' } }) as { value?: unknown[] }
    res.json({ events: result.value || [] })
  } catch (error) { next(error) }
})

app.post('/api/outlook/events', async (req, res, next) => {
  try { const current = await readState(); const event = await outlookRequest(current, '/me/events', { method: 'POST', body: JSON.stringify(req.body) }); res.status(201).json(event) } catch (error) { next(error) }
})
app.put('/api/outlook/events/:id', async (req, res, next) => {
  try { const current = await readState(); const event = await outlookRequest(current, `/me/events/${encodeURIComponent(req.params.id)}`, { method: 'PATCH', body: JSON.stringify(req.body) }); res.json(event) } catch (error) { next(error) }
})
app.delete('/api/outlook/events/:id', async (req, res, next) => {
  try { const current = await readState(); await outlookRequest(current, `/me/events/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' }); res.status(204).end() } catch (error) { next(error) }
})

app.post('/api/interviews', async (req, res) => {
  const current = await readState(); const now = new Date().toISOString()
  const interview: Interview = {
    id: randomUUID(),
    title: String(req.body.title || 'Nouvel entretien').trim().slice(0, 160),
    participant: '',
    role: '',
    participants: normalizeParticipants(req.body.participants, String(req.body.participant || ''), String(req.body.role || '')),
    date: String(req.body.date || new Date().toISOString().slice(0, 10)),
    transcript: String(req.body.transcript || '').slice(0, 5_000_000),
    status: 'draft', createdAt: now, updatedAt: now,
  }
  syncPrimaryParticipant(interview)
  current.interviews.unshift(interview); await saveState(current); res.status(201).json(interview)
})

app.put('/api/interviews/:id', async (req, res) => {
  const current = await readState(); const interview = current.interviews.find((item) => item.id === req.params.id)
  if (!interview) return res.status(404).json({ error: 'Entretien introuvable.' })
  for (const field of ['title', 'participant', 'role', 'date'] as const) if (typeof req.body[field] === 'string') interview[field] = req.body[field].trim().slice(0, 160)
  if (Array.isArray(req.body.participants) || typeof req.body.participant === 'string') {
    interview.participants = normalizeParticipants(req.body.participants, interview.participant, interview.role)
    syncPrimaryParticipant(interview)
  }
  if (typeof req.body.transcript === 'string') {
    const transcript = req.body.transcript.slice(0, 5_000_000)
    if (transcript !== interview.transcript) {
      const invalidatesProjectSummary = Boolean(interview.summary)
      interview.transcript = transcript
      interview.status = 'draft'
      interview.summary = undefined
      interview.error = undefined
      if (invalidatesProjectSummary) {
        current.projectSummary = null
        current.projectSummaryUpdatedAt = null
      }
    }
  }
  interview.updatedAt = new Date().toISOString(); await saveState(current); res.json(interview)
})

app.delete('/api/interviews/:id/summary-sections/:section', async (req, res) => {
  const current = await readState(); const interview = current.interviews.find((item) => item.id === req.params.id)
  const section = req.params.section as SummarySectionField
  if (!interview?.summary) return res.status(404).json({ error: 'Synthèse introuvable.' })
  if (!summarySectionFields.includes(section)) return res.status(422).json({ error: 'Rubrique de synthèse invalide.' })
  interview.summary[section] = []
  interview.updatedAt = new Date().toISOString(); await saveState(current); res.json({ interview })
})

app.put('/api/interviews/:id/summary-sections/:section', async (req, res) => {
  const current = await readState(); const interview = current.interviews.find((item) => item.id === req.params.id)
  const section = req.params.section as SummarySectionField
  if (!interview?.summary) return res.status(404).json({ error: 'Synthèse introuvable.' })
  if (!summarySectionFields.includes(section) || !Array.isArray(req.body.items)) return res.status(422).json({ error: 'Rubrique de synthèse invalide.' })
  interview.summary[section] = req.body.items.filter((item: unknown) => typeof item === 'string').map((item: string) => item.slice(0, 10_000))
  interview.updatedAt = new Date().toISOString(); await saveState(current); res.json({ interview })
})

app.delete('/api/interviews/:id', async (req, res) => {
  const current = await readState(); const removed = current.interviews.find((item) => item.id === req.params.id); const before = current.interviews.length
  current.interviews = current.interviews.filter((item) => item.id !== req.params.id)
  if (before === current.interviews.length) return res.status(404).json({ error: 'Entretien introuvable.' })
  if (removed?.summary) { current.projectSummary = null; current.projectSummaryUpdatedAt = null }
  await saveState(current); res.json({ deleted: removed })
})

app.post('/api/interviews/restore', async (req, res) => {
  const interview = req.body.interview as Interview | undefined
  if (!interview?.id || !interview.title) return res.status(422).json({ error: 'Entretien à restaurer invalide.' })
  const current = await readState()
  if (!current.interviews.some((item) => item.id === interview.id)) current.interviews.unshift(interview)
  await saveState(current); res.status(201).json(interview)
})

app.post('/api/interviews/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'Ajoute un fichier texte ou Markdown.' })
  const transcript = req.file.buffer.toString('utf8').trim()
  if (!transcript) return res.status(422).json({ error: 'La transcription est vide.' })
  const current = await readState(); const now = new Date().toISOString()
  const interview: Interview = {
    id: randomUUID(), title: path.parse(req.file.originalname).name, participant: '', role: '', participants: [], date: new Date().toISOString().slice(0, 10),
    transcript: transcript.slice(0, 5_000_000), sourceFile: req.file.originalname, status: 'draft', createdAt: now, updatedAt: now,
  }
  current.interviews.unshift(interview); await saveState(current); res.status(201).json(interview)
})

app.post('/api/context-documents', contextUpload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ajoute un document, une image ou un tableau.' })
    const current = await readState(); const now = new Date().toISOString(); const id = randomUUID()
    const safeName = req.file.originalname.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 140) || 'document'
    const filePath = await putFile(`context/${id}-${safeName}`, req.file.buffer, req.file.mimetype || 'application/octet-stream')
    const extension = path.extname(safeName).toLowerCase(); const textLike = req.file.mimetype.startsWith('text/') || ['.md', '.txt', '.csv', '.json', '.xml', '.html'].includes(extension)
    const extractedText = textLike ? req.file.buffer.toString('utf8').slice(0, 200_000) : ''
    const document: ContextDocument = { id, name: req.file.originalname.slice(0, 180), mimeType: req.file.mimetype || 'application/octet-stream', size: req.file.size, filePath, extractedText, createdAt: now }
    current.contextDocuments.unshift(document); await saveState(current)
    res.status(201).json({ id: document.id, name: document.name, mimeType: document.mimeType, size: document.size, extractedText: document.extractedText, createdAt: document.createdAt })
  } catch (error) { next(error) }
})

app.delete('/api/context-documents/:id', async (req, res, next) => {
  try {
    const current = await readState(); const document = current.contextDocuments.find((item) => item.id === req.params.id)
    if (!document) return res.status(404).json({ error: 'Document introuvable.' })
    current.contextDocuments = current.contextDocuments.filter((item) => item.id !== document.id); await saveState(current); await removeFile(document.filePath); res.json({ deleted: document.id })
  } catch (error) { next(error) }
})

app.post('/api/interviews/:id/summarize', async (req, res, next) => {
  try { res.json(await processInterview(req.params.id)) } catch (error) { next(error) }
})

app.get('/api/assistant/conversations', async (_req, res) => {
  const current = await readState()
  res.json(current.assistantConversations.map(({ id, title, createdAt, updatedAt, messages }) => ({ id, title, createdAt, updatedAt, messageCount: messages.length })))
})

app.post('/api/assistant/conversations', async (_req, res) => {
  const current = await readState(); const now = new Date().toISOString()
  const conversation: AssistantConversation = { id: randomUUID(), title: 'Nouvelle conversation', messages: [], createdAt: now, updatedAt: now }
  current.assistantConversations.unshift(conversation); await saveState(current); res.status(201).json(conversation)
})

app.get('/api/assistant/conversations/:id', async (req, res) => {
  const current = await readState(); const conversation = current.assistantConversations.find((item) => item.id === req.params.id)
  if (!conversation) return res.status(404).json({ error: 'Conversation introuvable.' })
  res.json(conversation)
})

app.post('/api/audit-report', async (_req, res, next) => {
  try {
    const jobId = randomUUID()
    const job: StoredJob = { id: jobId, status: 'processing', createdAt: new Date().toISOString() }
    await writeJob(job)
    const project = activeProject()
    runInBackground(withProject(project, async () => {
      try { await writeJob({ ...job, status: 'complete', result: await generateAuditReport(await readState()) }) }
      catch (error) { await writeJob({ ...job, status: 'error', error: error instanceof Error ? error.message : 'La génération du rapport a échoué.' }) }
    }))
    res.status(202).json({ jobId, status: job.status })
  } catch (error) { next(error) }
})

app.get('/api/audit-report/:jobId', async (req, res, next) => {
  try {
    const job = await readJob(req.params.jobId)
    const expired = job && Date.now() - new Date(job.createdAt).getTime() > 30 * 60_000
    if (!job || expired) return res.status(404).json({ error: 'La génération du rapport a expiré. Relance-la.' })
    res.json({ status: job.status, result: job.result, error: job.error })
  } catch (error) { next(error) }
})

async function readGeneratedDocument(name: string) {
  const filename = path.basename(name)
  if (!filename.endsWith('.html')) throw Object.assign(new Error('Document introuvable.'), { status: 404 })
  try { return { filename, html: (await getFile(`documents/${filename}`)).toString('utf8') } }
  catch { throw Object.assign(new Error('Document introuvable.'), { status: 404 }) }
}

app.get('/api/documents/:filename', async (req, res, next) => {
  try {
    const { filename, html } = await readGeneratedDocument(req.params.filename)
    res.type('html').setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(html)
  } catch (error) { next(error) }
})

app.get('/api/documents/:filename/view', async (req, res, next) => {
  try { res.type('html').send((await readGeneratedDocument(req.params.filename)).html) }
  catch (error) { next(error) }
})

app.get('/api/documents/:filename/open', async (req, res, next) => {
  try {
    const { filename, html } = await readGeneratedDocument(req.params.filename)
    // En ligne, « ouvrir » revient à afficher le document : rien n'est écrit sur le disque du serveur.
    if (storageMode !== 'local') return res.type('html').send(html)
    const downloadedFile = path.join(downloadsDirectory, filename)
    await fs.mkdir(downloadsDirectory, { recursive: true })
    await fs.writeFile(downloadedFile, html, 'utf8')
    spawn('open', [downloadedFile], { detached: true, stdio: 'ignore' }).unref()
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Document ouvert</title><p>Le document a été enregistré dans Téléchargements et ouvert dans votre navigateur par défaut.</p>')
  } catch (error) { next(error) }
})

app.post('/api/assistant/chat', assistantAttachmentUpload.single('attachment'), async (req, res, next) => {
  try {
    const content = typeof req.body.content === 'string' ? req.body.content.trim().slice(0, 12_000) : ''
    if (!content) return res.status(422).json({ error: 'Écris un message pour l’assistant.' })
    const current = await readState()
    const conversation = current.assistantConversations.find((item) => item.id === req.body.conversationId)
    if (!conversation) return res.status(404).json({ error: 'Conversation introuvable.' })
    const attachment = req.file ? { buffer: req.file.buffer, name: req.file.originalname.slice(0, 180), mimeType: req.file.mimetype || 'application/octet-stream' } : undefined
    const answer = await answerAssistant(current, content, conversation.messages, attachment)
    const now = new Date().toISOString()
    const userMessage: AssistantMessage = { id: randomUUID(), role: 'user', content, attachmentName: attachment?.name, createdAt: now }
    const assistantMessage: AssistantMessage = { id: randomUUID(), role: 'assistant', content: answer.reply, actions: answer.actions, createdAt: new Date().toISOString() }
    conversation.messages.push(userMessage, assistantMessage); conversation.messages = conversation.messages.slice(-80)
    conversation.title = conversation.messages.filter((item) => item.role === 'user')[0]?.content.slice(0, 56) || 'Nouvelle conversation'; conversation.updatedAt = new Date().toISOString()
    await saveState(current)
    res.json({ conversation, userMessage, assistantMessage })
  } catch (error) { next(error) }
})

app.post('/api/assistant/conversations/:conversationId/actions/:messageId/:actionIndex/apply', async (req, res, next) => {
  try {
    const index = Number(req.params.actionIndex)
    const current = await readState()
    const conversation = current.assistantConversations.find((item) => item.id === req.params.conversationId)
    const message = conversation?.messages.find((item) => item.id === req.params.messageId && item.role === 'assistant')
    const action = Number.isInteger(index) ? message?.actions?.[index] : undefined
    if (!action) return res.status(404).json({ error: 'Action proposée introuvable.' })
    const document = action.type === 'generate_document' ? await generateMissionDocument(current, action) : undefined
    if (document && action.type === 'generate_document') Object.assign(action, { downloadUrl: document.downloadUrl, viewUrl: document.viewUrl, openUrl: document.openUrl, filename: document.filename, label: `Ouvrir ou télécharger · ${document.title}` })
    if (!document) applyAssistantAction(current, action)
    await saveState(current)
    res.json({ state: current, document })
  } catch (error) { next(error) }
})

app.post('/api/project-summary/rebuild', async (_req, res, next) => {
  try {
    const current = await readState(); const complete = current.interviews.filter((item) => item.summary).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    let cumulative: ProjectSummary | null = null
    for (const interview of complete) cumulative = await updateProjectSummary(cumulative, interview)
    current.projectSummary = cumulative; current.projectSummaryUpdatedAt = cumulative ? new Date().toISOString() : null; await saveState(current)
    res.json({ projectSummary: cumulative, projectSummaryUpdatedAt: current.projectSummaryUpdatedAt })
  } catch (error) { next(error) }
})

app.post('/api/map/suggestions', async (req, res, next) => {
  try {
    const rawIds: unknown[] = Array.isArray(req.body.interviewIds) ? req.body.interviewIds as unknown[] : []
    const ids = rawIds.filter((id): id is string => typeof id === 'string').slice(0, 8)
    if (!ids.length) return res.status(422).json({ error: 'Sélectionne au moins un entretien.' })
    const current = await readState()
    const interviews = ids.map((id) => current.interviews.find((item) => item.id === id)).filter((item): item is Interview => Boolean(item && item.transcript.trim()))
    if (!interviews.length) return res.status(422).json({ error: 'Les entretiens sélectionnés doivent contenir une transcription.' })
    res.json(await generateMapSuggestion(interviews))
  } catch (error) { next(error) }
})

app.post('/api/map/suggestions/apply', async (req, res) => {
  const proposal = MapSuggestionSchema.safeParse(req.body.proposal)
  if (!proposal.success || !proposal.data.lanes.length) return res.status(422).json({ error: 'Proposition de cartographie invalide.' })
  const current = await readState()
  const newLanes: MapLane[] = []
  const newNodes: MapNode[] = []
  for (const suggestedLane of proposal.data.lanes.slice(0, 6)) {
    const lane: MapLane = { id: randomUUID(), name: suggestedLane.name.trim().slice(0, 120) || 'Phase suggérée', description: suggestedLane.description.trim().slice(0, 300), order: current.mapLanes.length + newLanes.length }
    newLanes.push(lane)
    for (const suggestedNode of suggestedLane.nodes.slice(0, 8)) {
      newNodes.push({
        id: randomUUID(), laneId: lane.id, label: suggestedNode.label.trim().slice(0, 120) || 'Étape suggérée', description: suggestedNode.description.trim().slice(0, 500), owner: suggestedNode.owner.trim().slice(0, 120) || 'À définir',
        status: suggestedNode.status, systems: suggestedNode.systems.map((system) => system.trim()).filter(Boolean).slice(0, 20), evidence: suggestedNode.evidence.trim().slice(0, 2_000), order: newNodes.filter((node) => node.laneId === lane.id).length,
      })
    }
  }
  current.mapLanes.push(...newLanes); current.mapNodes.push(...newNodes); await saveState(current)
  res.status(201).json({ lanes: newLanes, nodes: newNodes })
})

app.post('/api/map/lanes', async (req, res) => {
  const current = await readState(); const lane: MapLane = { id: randomUUID(), name: String(req.body.name || 'Nouvelle phase').trim().slice(0, 120), description: String(req.body.description || '').trim().slice(0, 300), order: current.mapLanes.length }
  current.mapLanes.push(lane); await saveState(current); res.status(201).json(lane)
})

app.put('/api/map/lanes/:id', async (req, res) => {
  const current = await readState(); const lane = current.mapLanes.find((item) => item.id === req.params.id)
  if (!lane) return res.status(404).json({ error: 'Phase introuvable.' })
  if (typeof req.body.name === 'string') lane.name = req.body.name.trim().slice(0, 120)
  if (typeof req.body.description === 'string') lane.description = req.body.description.trim().slice(0, 300)
  await saveState(current); res.json(lane)
})

app.delete('/api/map/lanes/:id', async (req, res) => {
  const current = await readState(); const lane = current.mapLanes.find((item) => item.id === req.params.id)
  if (!lane) return res.status(404).json({ error: 'Phase introuvable.' })
  const nodes = current.mapNodes.filter((item) => item.laneId === req.params.id)
  current.mapLanes = current.mapLanes.filter((item) => item.id !== req.params.id); current.mapNodes = current.mapNodes.filter((item) => item.laneId !== req.params.id)
  await saveState(current); res.json({ lane, nodes })
})

app.post('/api/map/lanes/restore', async (req, res) => {
  const lane = req.body.lane as MapLane | undefined; const nodes = Array.isArray(req.body.nodes) ? req.body.nodes as MapNode[] : []
  if (!lane?.id || !lane.name) return res.status(422).json({ error: 'Phase à restaurer invalide.' })
  const current = await readState()
  if (!current.mapLanes.some((item) => item.id === lane.id)) current.mapLanes.push(lane)
  for (const node of nodes) if (node?.id && !current.mapNodes.some((item) => item.id === node.id)) current.mapNodes.push(node)
  await saveState(current); res.status(201).json({ lane, nodes })
})

app.post('/api/map/nodes', async (req, res) => {
  const current = await readState(); const lane = current.mapLanes.find((item) => item.id === req.body.laneId)
  if (!lane) return res.status(422).json({ error: 'Sélectionne une phase valide.' })
  const node: MapNode = {
    id: randomUUID(), laneId: lane.id, label: String(req.body.label || 'Nouvelle étape').trim().slice(0, 120), description: String(req.body.description || '').trim().slice(0, 500),
    owner: String(req.body.owner || '').trim().slice(0, 120), status: ['confirmed', 'verify', 'friction'].includes(req.body.status) ? req.body.status : 'verify',
    systems: Array.isArray(req.body.systems) ? req.body.systems.map(String).slice(0, 20) : [], evidence: String(req.body.evidence || '').trim().slice(0, 2_000),
    order: current.mapNodes.filter((item) => item.laneId === lane.id).length,
  }
  current.mapNodes.push(node); await saveState(current); res.status(201).json(node)
})

app.put('/api/map/nodes/:id', async (req, res) => {
  const current = await readState(); const node = current.mapNodes.find((item) => item.id === req.params.id)
  if (!node) return res.status(404).json({ error: 'Étape introuvable.' })
  for (const field of ['label', 'description', 'owner', 'evidence'] as const) if (typeof req.body[field] === 'string') node[field] = req.body[field].trim().slice(0, field === 'evidence' ? 2_000 : 500)
  if (typeof req.body.laneId === 'string' && current.mapLanes.some((item) => item.id === req.body.laneId)) node.laneId = req.body.laneId
  if (['confirmed', 'verify', 'friction'].includes(req.body.status)) node.status = req.body.status
  if (Array.isArray(req.body.systems)) node.systems = req.body.systems.map(String).slice(0, 20)
  await saveState(current); res.json(node)
})

app.delete('/api/map/nodes/:id', async (req, res) => {
  const current = await readState(); const node = current.mapNodes.find((item) => item.id === req.params.id)
  if (!node) return res.status(404).json({ error: 'Étape introuvable.' })
  current.mapNodes = current.mapNodes.filter((item) => item.id !== req.params.id)
  await saveState(current); res.json({ deleted: node })
})

app.post('/api/map/nodes/restore', async (req, res) => {
  const node = req.body.node as MapNode | undefined
  if (!node?.id || !node.label || !node.laneId) return res.status(422).json({ error: 'Étape à restaurer invalide.' })
  const current = await readState()
  if (!current.mapNodes.some((item) => item.id === node.id)) current.mapNodes.push(node)
  await saveState(current); res.status(201).json(node)
})

app.use((error: Error & { status?: number; statusCode?: number; code?: string; type?: string; data?: { error?: string } }, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error)
  const status = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413 : error.status || error.statusCode || 500
  const apiMessage = error.data?.error ? slackErrorMessage(error) : status === 401 ? 'La clé OpenAI est invalide ou révoquée.' : status === 413 ? 'Le fichier est trop volumineux. La limite est de 5 Mo.' : status === 429 ? 'La limite OpenAI est atteinte. Réessaie dans quelques instants.' : error.message
  res.status(status).json({ error: apiMessage || 'Une erreur est survenue.' })
})

const bootstrapped = storageMode === 'local' ? await bootstrapProjects() : []
for (const project of bootstrapped) {
  if (project.id !== 'perfectserve') continue
  await withProject(project, async () => {
    const current = await readState()
    if (current.collaborators.length) return
    current.collaborators = (await readPeopleDirectory()).map((person) => ({ ...person }))
    await saveState(current)
    console.log(`Migration : ${current.collaborators.length} collaborateurs de l’organigramme rattachés au projet « ${project.name} ».`)
  })
}

// En local le serveur écoute ; en serverless, api/index.ts réutilise l'application telle quelle.
if (!process.env.VERCEL) {
  app.listen(3001, '127.0.0.1', () => console.log(`Relay API listening on http://127.0.0.1:3001 · OpenAI ${openai ? 'ready' : 'not configured'} · Auth ${authConfigured() ? 'ready' : 'not configured'} · Stockage ${storageMode} · ${model}`))
}

export default app
