import { config as loadEnv } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Migration des missions locales vers Supabase.
 *
 *   npm run migrate:supabase
 *
 * Lit data/projects.json et data/projects/<id>/mission-control.json, téléverse
 * les documents de contexte et les documents générés dans le bucket, puis écrit
 * le tout dans relay_projects / relay_project_state. Le script est réexécutable :
 * chaque ligne est mise à jour plutôt que dupliquée.
 */

loadEnv({ path: ['.env.local', '.env'] })

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataRoot = path.join(root, 'data')
const bucket = 'relay-files'

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!supabaseUrl || !serviceRoleKey) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis dans .env.local pour lancer la migration.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })

async function ensureBucket() {
  const { data } = await supabase.storage.getBucket(bucket)
  if (!data) {
    const { error } = await supabase.storage.createBucket(bucket, { public: false, fileSizeLimit: '16MB' })
    if (error) throw new Error(`Création du bucket impossible : ${error.message}`)
    console.log(`Bucket « ${bucket} » créé.`)
  }
}

async function upload(key: string, body: Buffer, contentType: string) {
  const { error } = await supabase.storage.from(bucket).upload(key, body, { contentType, upsert: true })
  if (error) throw new Error(`Téléversement de ${key} impossible : ${error.message}`)
}

async function migrateGeneratedDocuments() {
  const directory = path.join(dataRoot, 'generated-documents')
  const files = await fs.readdir(directory).catch(() => [] as string[])
  for (const name of files.filter((file) => file.endsWith('.html'))) {
    await upload(`documents/${name}`, await fs.readFile(path.join(directory, name)), 'text/html; charset=utf-8')
  }
  return files.length
}

type ContextDocument = { id: string; name: string; mimeType: string; filePath: string }

async function migrateContextDocuments(state: { contextDocuments?: ContextDocument[] }) {
  let migrated = 0
  for (const document of state.contextDocuments ?? []) {
    if (!document.filePath || !path.isAbsolute(document.filePath)) continue
    const buffer = await fs.readFile(document.filePath).catch(() => null)
    if (!buffer) {
      console.warn(`  fichier introuvable, ignoré : ${document.name}`)
      continue
    }
    const key = `context/${path.basename(document.filePath)}`
    await upload(key, buffer, document.mimeType || 'application/octet-stream')
    document.filePath = key
    migrated += 1
  }
  return migrated
}

async function main() {
  await ensureBucket()

  const registry = JSON.parse(await fs.readFile(path.join(dataRoot, 'projects.json'), 'utf8')) as { projects: Array<{ id: string; name: string; createdAt?: string }> }
  const documents = await migrateGeneratedDocuments()
  console.log(`${documents} document(s) généré(s) téléversé(s).`)

  for (const project of registry.projects) {
    const stateFile = path.join(dataRoot, 'projects', project.id, 'mission-control.json')
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8').catch(() => '{}')) as Record<string, unknown>
    const contextCount = await migrateContextDocuments(state as { contextDocuments?: ContextDocument[] })

    const { error: projectError } = await supabase.from('relay_projects').upsert({
      id: project.id,
      data: project,
      created_at: project.createdAt ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (projectError) throw new Error(`Projet ${project.name} : ${projectError.message}`)

    const { error: stateError } = await supabase.from('relay_project_state').upsert({
      project_id: project.id,
      state,
      updated_at: new Date().toISOString(),
    })
    if (stateError) throw new Error(`État de ${project.name} : ${stateError.message}`)

    const interviews = Array.isArray(state.interviews) ? state.interviews.length : 0
    const collaborators = Array.isArray(state.collaborators) ? state.collaborators.length : 0
    console.log(`Projet « ${project.name} » migré — ${interviews} entretien(s), ${collaborators} collaborateur(s), ${contextCount} document(s) de contexte.`)
  }

  console.log('Migration terminée.')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
