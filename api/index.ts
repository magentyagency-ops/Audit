import type { IncomingMessage, ServerResponse } from 'node:http'
import app from '../server/index.js'

/**
 * Point d'entrée serverless de l'API de mission.
 *
 * L'application Express est réutilisée telle quelle : les mêmes routes servent
 * en développement (serveur local sur le port 3001) et en production, avec le
 * stockage Supabase à la place du disque.
 *
 * Le routage par fichiers de Vercel ne fait correspondre qu'un seul segment à
 * une fonction : `/api/projects` arriverait ici, mais pas
 * `/api/assistant/conversations`. La réécriture déclarée dans vercel.json
 * redirige donc tout `/api/*` vers cette fonction en passant le chemin
 * d'origine dans `__path`, que l'on restitue avant de le confier à Express.
 */
export default function handler(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const forwarded = url.searchParams.get('__path')
  if (forwarded !== null) {
    url.searchParams.delete('__path')
    const query = url.searchParams.toString()
    request.url = `/api/${forwarded}${query ? `?${query}` : ''}`
  }
  return (app as unknown as (request: IncomingMessage, response: ServerResponse) => void)(request, response)
}
