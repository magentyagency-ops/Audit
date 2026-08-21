import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleAdminUsers } from '../../server/adminUsers.js'

/** Fonction serverless d'administration des comptes (déploiement Vercel). */
export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const header = request.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  const body = (typeof request.body === 'string' ? JSON.parse(request.body || '{}') : request.body) ?? {}
  const result = await handleAdminUsers(request.method ?? 'GET', token, body as Record<string, unknown>)
  if (result.status === 405) response.setHeader('Allow', 'GET, POST, PATCH, DELETE')
  response.status(result.status).json(result.body)
}
