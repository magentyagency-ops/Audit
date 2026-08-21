import app from '../server/index.js'

/**
 * Point d'entrée serverless de l'API de mission.
 *
 * L'application Express est réutilisée telle quelle : les mêmes routes servent
 * en développement (serveur local sur le port 3001) et en production (fonction
 * Vercel), avec le stockage Supabase à la place du disque.
 */
export default app
