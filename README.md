# Relay — Mission Control

Application locale TypeScript pour piloter des missions de conseil : plusieurs projets clients, chacun avec ses notes, ses entretiens, ses synthèses OpenAI et sa cartographie des processus.

## Démarrer en local

```bash
npm run dev
```

Ouvrir ensuite : <http://127.0.0.1:5173/> — le tableau de bord des projets.

## Projets

- Le tableau de bord (`dashboard.html`) liste les projets, leurs statistiques et permet d’en créer ou d’en supprimer.
- À la création, la mission est décrite en quelques phrases : l’assistant en tire un contexte de départ (nom, client, secteur, objectif, périmètre, parties prenantes, questions clés, livrables, premières actions). Ce contexte est ensuite injecté dans tous les prompts du projet.
- L’espace de travail d’un projet est ouvert via `workspace.html?project=<id>` ; le navigateur envoie l’en-tête `X-Project-Id` sur chaque appel API.
- Chaque projet possède son propre état, isolé dans `data/projects/<id>/mission-control.json`. Le registre des projets vit dans `data/projects.json`.
- Au premier démarrage de la version multi-projets, les données existantes de `data/mission-control.json` sont rattachées automatiquement à un projet « PerfectServe » et l’ancien fichier est conservé en `.pre-multiprojet.bak`.

Lorsqu’une analyse est lancée, la transcription concernée est envoyée à l’API OpenAI pour produire la synthèse.

## Comptes et authentification

L'application est fermée par un écran de connexion Supabase, sur le même modèle que Nira CRM et sur la **même base** : les comptes de la table `profiles` sont partagés entre les deux applications.

1. Exécuter `supabase/relay-auth.sql` dans l'éditeur SQL de Supabase. Le script est idempotent et ne casse rien si la table `profiles` du CRM existe déjà.
2. Renseigner dans `.env.local` (ou dans les variables Vercel) :

```bash
VITE_SUPABASE_URL=https://votre-projet.supabase.co
VITE_SUPABASE_ANON_KEY=votre-anon-key
SUPABASE_SERVICE_ROLE_KEY=votre-service-role-key   # administration des comptes uniquement
```

- Le premier compte créé — ou celui portant l'email défini par `bootstrap_admin_email()` — devient administrateur.
- Un **consultant** accède à toutes les missions de l'équipe. Un **administrateur** gère en plus les comptes, depuis le bouton « Équipe » du tableau de bord : création, changement de rôle, désactivation, suppression.
- Chaque compte peut changer son mot de passe depuis le menu de compte, ou demander un lien de réinitialisation depuis l'écran de connexion.
- Le jeton de session est envoyé à l'API de mission sur chaque appel (`Authorization: Bearer`), qui le revalide auprès de Supabase et vérifie que le compte est actif. Restent volontairement ouvertes, faute de pouvoir porter un en-tête : `/api/health`, la redirection OAuth Outlook et l'ouverture d'un document généré dans le navigateur — toutes servies par le serveur local uniquement.
- Un projet mémorise son créateur ; sa suppression est réservée à ce créateur ou à un administrateur.

## Déploiement Vercel

L'application tourne en ligne avec l'API de mission en fonction serverless et les données dans Supabase.

### 1. Base de données

Exécuter dans l'éditeur SQL de Supabase, dans cet ordre :

```
supabase/relay-auth.sql   → comptes, rôles, RLS
supabase/relay-data.sql   → tables des missions (relay_projects, relay_project_state, relay_jobs)
```

Le bucket de stockage `relay-files` (documents générés et fichiers de contexte) est créé automatiquement au premier usage.

### 2. Migration des missions existantes

Renseigner `SUPABASE_SERVICE_ROLE_KEY` dans `.env.local`, puis :

```bash
npm run migrate:supabase
```

Le script pousse `data/projects.json`, l'état de chaque mission et les fichiers associés vers Supabase. Il est réexécutable sans créer de doublon.

### 3. Variables d'environnement Vercel

```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
OPENAI_MODEL
SLACK_BOT_TOKEN            (facultatif)
OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET / OUTLOOK_TENANT_ID / OUTLOOK_REDIRECT_URI  (facultatif)
```

### Stockage : local ou Supabase

`server/storage.ts` expose la même interface au-dessus de deux implémentations. Le mode est choisi par `RELAY_STORAGE` (`local` ou `supabase`) ; sans cette variable, c'est Supabase dès qu'une clé `service_role` est présente, sinon le disque. `GET /api/health` indique le mode actif.

En pratique : sur Vercel, toujours Supabase ; en local, `RELAY_STORAGE=local` pour continuer à travailler sur `data/` même avec la clé renseignée.

### Limites connues en ligne

- Vercel plafonne le corps d'une requête serverless à environ 4,5 Mo : les transcriptions et documents de contexte plus lourds passent en local mais sont refusés en ligne.
- « Ouvrir » un document généré l'affiche dans le navigateur au lieu de l'enregistrer dans Téléchargements, le serveur n'ayant pas de disque.
