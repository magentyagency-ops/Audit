import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Stockage des données de mission.
 *
 * Deux implémentations derrière la même interface :
 *   * `local`    — fichiers JSON dans data/ (développement sur la machine) ;
 *   * `supabase` — tables jsonb + bucket de stockage (déploiement Vercel, dont
 *                  le système de fichiers est éphémère).
 *
 * Le mode est choisi par RELAY_STORAGE, sinon Supabase dès qu'une clé
 * service_role est disponible, sinon le disque.
 */

export type StorageMode = 'local' | 'supabase'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.join(root, 'data')
const registryFile = path.join(dataRoot, 'projects.json')
const projectsRoot = path.join(dataRoot, 'projects')
const documentDirectory = path.join(dataRoot, 'generated-documents')
const contextDirectory = path.join(dataRoot, 'context-documents')

// Lecture différée : ce module est importé avant que dotenv n'ait chargé
// .env.local, une lecture au chargement ne verrait donc rien en développement.
const supabaseUrl = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const serviceRoleKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || ''

export function resolveStorageMode(): StorageMode {
  if (process.env.RELAY_STORAGE === 'local') return 'local'
  if (process.env.RELAY_STORAGE === 'supabase') return 'supabase'
  return supabaseUrl() && serviceRoleKey() ? 'supabase' : 'local'
}

export const bucket = 'relay-files'

let client: SupabaseClient | null = null

export function serviceClient(): SupabaseClient {
  const url = supabaseUrl(), key = serviceRoleKey()
  if (!url || !key) {
    throw Object.assign(new Error('Stockage Supabase indisponible : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.'), { status: 503 })
  }
  client ??= createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return client
}

/** Crée le bucket privé au premier usage : le déploiement n'a ainsi rien à préparer à la main. */
let bucketReady: Promise<void> | null = null
async function ensureBucket() {
  bucketReady ??= (async () => {
    const store = serviceClient().storage
    const { data } = await store.getBucket(bucket)
    if (!data) await store.createBucket(bucket, { public: false, fileSizeLimit: '16MB' })
  })()
  await bucketReady
}

/* ------------------------------------------------------------------ projets */

export async function readRegistryRaw<T>(fallback: T): Promise<T> {
  if (resolveStorageMode() === 'local') {
    try { return JSON.parse(await fs.readFile(registryFile, 'utf8')) as T }
    catch { return fallback }
  }
  const { data, error } = await serviceClient().from('relay_projects').select('data').order('created_at', { ascending: false })
  if (error) throw new Error(`Lecture des projets impossible : ${error.message}`)
  return { projects: (data ?? []).map((row) => (row as { data: unknown }).data) } as T
}

export async function writeRegistryRaw(registry: { projects: Array<{ id: string; createdAt?: string }> }) {
  if (resolveStorageMode() === 'local') {
    await fs.mkdir(dataRoot, { recursive: true })
    const temp = `${registryFile}.tmp`
    await fs.writeFile(temp, JSON.stringify(registry, null, 2), 'utf8')
    await fs.rename(temp, registryFile)
    return
  }
  const supabase = serviceClient()
  const rows = registry.projects.map((project) => ({ id: project.id, data: project, created_at: project.createdAt ?? new Date().toISOString(), updated_at: new Date().toISOString() }))
  if (rows.length) {
    const { error } = await supabase.from('relay_projects').upsert(rows)
    if (error) throw new Error(`Enregistrement des projets impossible : ${error.message}`)
  }
  // Les projets absents du registre ont été supprimés.
  const keep = rows.map((row) => row.id)
  const query = supabase.from('relay_projects').delete()
  const { error: deleteError } = keep.length ? await query.not('id', 'in', `(${keep.map((id) => `"${id}"`).join(',')})`) : await query.neq('id', '')
  if (deleteError) throw new Error(`Nettoyage des projets impossible : ${deleteError.message}`)
}

export async function readProjectState<T>(projectId: string): Promise<T | null> {
  if (resolveStorageMode() === 'local') {
    try { return JSON.parse(await fs.readFile(path.join(projectsRoot, projectId, 'mission-control.json'), 'utf8')) as T }
    catch { return null }
  }
  const { data, error } = await serviceClient().from('relay_project_state').select('state').eq('project_id', projectId).maybeSingle()
  if (error) throw new Error(`Lecture de la mission impossible : ${error.message}`)
  return (data?.state as T) ?? null
}

export async function writeProjectState(projectId: string, state: unknown) {
  if (resolveStorageMode() === 'local') {
    const file = path.join(projectsRoot, projectId, 'mission-control.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await fs.rename(temp, file)
    return
  }
  const { error } = await serviceClient().from('relay_project_state').upsert({ project_id: projectId, state, updated_at: new Date().toISOString() })
  if (error) throw new Error(`Enregistrement de la mission impossible : ${error.message}`)
}

export async function removeProjectStorage(projectId: string) {
  if (resolveStorageMode() === 'local') {
    await fs.rm(path.join(projectsRoot, projectId), { recursive: true, force: true })
    return
  }
  const supabase = serviceClient()
  await supabase.from('relay_project_state').delete().eq('project_id', projectId)
  await supabase.from('relay_projects').delete().eq('id', projectId)
}

/* ------------------------------------------------------------------ fichiers */

/** Chemin logique d'un fichier : `documents/<nom>.html` ou `context/<id>-<nom>`. */
export async function putFile(key: string, content: Buffer | string, contentType: string) {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  if (resolveStorageMode() === 'local') {
    const file = localPath(key)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
    return key
  }
  await ensureBucket()
  const { error } = await serviceClient().storage.from(bucket).upload(key, body, { contentType, upsert: true })
  if (error) throw new Error(`Enregistrement du fichier impossible : ${error.message}`)
  return key
}

export async function getFile(key: string): Promise<Buffer> {
  if (resolveStorageMode() === 'local') return fs.readFile(localPath(key))
  await ensureBucket()
  const { data, error } = await serviceClient().storage.from(bucket).download(key)
  if (error || !data) throw Object.assign(new Error('Fichier introuvable.'), { status: 404 })
  return Buffer.from(await data.arrayBuffer())
}

export async function removeFile(key: string) {
  if (resolveStorageMode() === 'local') {
    await fs.rm(localPath(key), { force: true })
    return
  }
  await ensureBucket()
  await serviceClient().storage.from(bucket).remove([key])
}

/** Ancien chemin absolu (données créées avant le passage au stockage partagé). */
function localPath(key: string) {
  if (path.isAbsolute(key)) return key
  const [scope, ...rest] = key.split('/')
  const name = rest.join('/')
  if (scope === 'documents') return path.join(documentDirectory, name)
  if (scope === 'context') return path.join(contextDirectory, name)
  return path.join(dataRoot, key)
}

/* ---------------------------------------------------------------- traitements */

export type StoredJob = { id: string; status: 'processing' | 'complete' | 'error'; createdAt: string; result?: unknown; error?: string }

const localJobs = new Map<string, StoredJob>()

/**
 * Les générations longues (rapport d'audit) survivent au-delà d'une requête :
 * en local une Map suffit, en serverless l'état doit être partagé entre les
 * invocations, donc stocké en base.
 */
export async function writeJob(job: StoredJob) {
  if (resolveStorageMode() === 'local') { localJobs.set(job.id, job); return }
  const { error } = await serviceClient().from('relay_jobs').upsert({
    id: job.id, status: job.status, created_at: job.createdAt, result: job.result ?? null, error: job.error ?? null,
  })
  if (error) throw new Error(`Suivi du traitement impossible : ${error.message}`)
}

export async function readJob(id: string): Promise<StoredJob | null> {
  if (resolveStorageMode() === 'local') return localJobs.get(id) ?? null
  const { data, error } = await serviceClient().from('relay_jobs').select('*').eq('id', id).maybeSingle()
  if (error) throw new Error(`Lecture du traitement impossible : ${error.message}`)
  if (!data) return null
  return { id: data.id, status: data.status, createdAt: data.created_at, result: data.result ?? undefined, error: data.error ?? undefined }
}
