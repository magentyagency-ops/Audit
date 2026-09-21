import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readProjectState, readRegistryRaw, removeProjectStorage, resolveStorageMode, writeProjectState, writeRegistryRaw } from './storage.js'

export const ProjectBriefSchema = z.object({
  name: z.string(),
  client: z.string(),
  sector: z.string(),
  missionType: z.string(),
  objective: z.string(),
  scope: z.array(z.string()),
  stakeholders: z.array(z.string()),
  keyQuestions: z.array(z.string()),
  deliverables: z.array(z.string()),
  firstSteps: z.array(z.string()),
})

export type ProjectBrief = z.infer<typeof ProjectBriefSchema>

export type Project = {
  id: string
  name: string
  client: string
  sector: string
  missionType: string
  description: string
  brief: ProjectBrief | null
  accent: string
  archived: boolean
  createdBy: string
  createdByEmail: string
  createdAt: string
  updatedAt: string
}

type ProjectRegistry = { projects: Project[] }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.join(root, 'data')
const registryFile = path.join(dataRoot, 'projects.json')
const projectsRoot = path.join(dataRoot, 'projects')
const legacyStateFile = path.join(dataRoot, 'mission-control.json')

export const accentPalette = ['#087af5', '#7c5cff', '#18a67e', '#e99512', '#e84d6a', '#32ade6']

const store = new AsyncLocalStorage<{ project: Project }>()

export function withProject<T>(project: Project, run: () => T): T {
  return store.run({ project }, run)
}

export function activeProject(): Project {
  const context = store.getStore()
  if (!context) throw Object.assign(new Error('Aucun projet sélectionné.'), { status: 400 })
  return context.project
}

export function projectStateFile(id: string) {
  return path.join(projectsRoot, id, 'mission-control.json')
}

export async function readRegistry(): Promise<ProjectRegistry> {
  const parsed = await readRegistryRaw<Partial<ProjectRegistry>>({ projects: [] })
  return { projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : [] }
}

async function saveRegistry(registry: ProjectRegistry) {
  await writeRegistryRaw(registry)
}

function normalizeProject(value: Partial<Project>): Project {
  const now = new Date().toISOString()
  return {
    id: String(value.id || randomUUID()),
    name: String(value.name || 'Projet sans nom'),
    client: String(value.client || ''),
    sector: String(value.sector || ''),
    missionType: String(value.missionType || ''),
    description: String(value.description || ''),
    brief: value.brief ?? null,
    accent: String(value.accent || accentPalette[0]),
    archived: Boolean(value.archived),
    createdBy: String(value.createdBy || ''),
    createdByEmail: String(value.createdByEmail || ''),
    createdAt: String(value.createdAt || now),
    updatedAt: String(value.updatedAt || value.createdAt || now),
  }
}

export async function listProjects() {
  return (await readRegistry()).projects
}

export async function findProject(id: string) {
  return (await readRegistry()).projects.find((project) => project.id === id) ?? null
}

export async function insertProject(draft: Partial<Project>) {
  const registry = await readRegistry()
  const project = normalizeProject({ ...draft, id: draft.id || randomUUID(), accent: draft.accent || accentPalette[registry.projects.length % accentPalette.length] })
  registry.projects.unshift(project)
  await saveRegistry(registry)
  return project
}

export async function patchProject(id: string, patch: Partial<Project>) {
  const registry = await readRegistry()
  const index = registry.projects.findIndex((project) => project.id === id)
  if (index < 0) throw Object.assign(new Error('Projet introuvable.'), { status: 404 })
  const next = normalizeProject({ ...registry.projects[index], ...patch, id, createdAt: registry.projects[index].createdAt, updatedAt: new Date().toISOString() })
  registry.projects[index] = next
  await saveRegistry(registry)
  return next
}

export async function removeProject(id: string) {
  const registry = await readRegistry()
  const project = registry.projects.find((item) => item.id === id)
  if (!project) throw Object.assign(new Error('Projet introuvable.'), { status: 404 })
  registry.projects = registry.projects.filter((item) => item.id !== id)
  await saveRegistry(registry)
  await removeProjectStorage(id)
  return project
}

export async function projectStats(id: string) {
  try {
    const parsed = (await readProjectState<{
      interviews?: Array<{ status?: string }>
      mapNodes?: unknown[]
      missionActions?: Array<{ done?: boolean }>
      contextDocuments?: unknown[]
      collaborators?: unknown[]
      updatedAt?: string
    }>(id)) ?? {}
    const interviews = Array.isArray(parsed.interviews) ? parsed.interviews : []
    const actions = Array.isArray(parsed.missionActions) ? parsed.missionActions : []
    return {
      interviews: interviews.length,
      summaries: interviews.filter((interview) => interview.status === 'complete').length,
      mapNodes: Array.isArray(parsed.mapNodes) ? parsed.mapNodes.length : 0,
      documents: Array.isArray(parsed.contextDocuments) ? parsed.contextDocuments.length : 0,
      collaborators: Array.isArray(parsed.collaborators) ? parsed.collaborators.length : 0,
      openActions: actions.filter((action) => !action.done).length,
      lastActivityAt: parsed.updatedAt || null,
    }
  } catch {
    return { interviews: 0, summaries: 0, mapNodes: 0, documents: 0, collaborators: 0, openActions: 0, lastActivityAt: null }
  }
}

/** Moves the single-tenant data file into a first project the first time the multi-project server boots. */
export async function bootstrapProjects() {
  const registry = await readRegistry()
  if (registry.projects.length) return registry.projects
  if (resolveStorageMode() !== 'local') return []
  const hasLegacyState = await fs.access(legacyStateFile).then(() => true).catch(() => false)
  if (!hasLegacyState) return []
  const project = await insertProject({
    id: 'perfectserve',
    name: 'PerfectServe',
    client: 'PerfectServe',
    sector: 'Santé — communication clinique',
    missionType: 'Audit Revenue Operations',
    description: 'Audit et refonte du parcours des leads entrants (inbound lead journey) chez PerfectServe, avec Rebecca et les équipes marketing, sales et Salesforce.',
    accent: accentPalette[0],
    brief: {
      name: 'PerfectServe',
      client: 'PerfectServe',
      sector: 'Santé — communication clinique',
      missionType: 'Audit Revenue Operations',
      objective: 'Cartographier le parcours des leads entrants de bout en bout, identifier les frictions et redessiner le processus avec les équipes concernées.',
      scope: ['Parcours du lead entrant', 'Qualification et routage', 'Salesforce et automatisations', 'Handoff marketing vers sales'],
      stakeholders: ['Marketing', 'Sales / SDR', 'Salesforce Administrator', 'Revenue Operations'],
      keyQuestions: ['Comment un lead entrant est-il traité aujourd’hui, étape par étape ?', 'Où se situent les pertes et les délais ?', 'Quelles règles de routage sont réellement appliquées ?'],
      deliverables: ['Cartographie du processus actuel', 'Rapport d’audit', 'Processus cible recommandé'],
      firstSteps: [],
    },
  })
  await writeProjectState(project.id, JSON.parse(await fs.readFile(legacyStateFile, 'utf8')))
  await fs.rename(legacyStateFile, `${legacyStateFile}.pre-multiprojet.bak`).catch(() => undefined)
  console.log(`Migration : les données existantes ont été rattachées au projet « ${project.name} ».`)
  return [project]
}
