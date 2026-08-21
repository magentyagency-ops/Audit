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

`vercel.json` et la fonction `api/admin/users.ts` sont prêts : le build produit `dist/` et l'administration des comptes tourne en serverless avec la clé `service_role`.

⚠️ Avant de déployer, les données de mission doivent quitter le disque local : le serveur Express (`server/index.ts`) écrit dans `data/projects/<id>/mission-control.json`, or le système de fichiers de Vercel est éphémère et l'API locale n'y tourne pas. Il reste donc à porter l'état des projets vers Supabase (ou un stockage distant) et à convertir les routes Express en fonctions serverless.

## Configuration OpenAI

Créer un fichier `.env.local` à la racine à partir de `.env.example`, puis renseigner :

```bash
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-5.6-luna
```

Le fichier `.env.local` est exclu de Git. La clé n’est jamais exposée au navigateur : seul le serveur local l’utilise.

## Connexion Slack

Créer une Slack App, l’installer dans le workspace et ajouter son token bot dans `.env.local` :

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
```

Pour recevoir uniquement les messages privés envoyés directement au bot, donner les scopes minimums `im:read`, `im:history` et `users:read`. Le bot ne peut pas lire les messages directs échangés entre deux autres personnes, ni les canaux Slack.

L’application détecte automatiquement le token dès qu’il est enregistré dans `.env.local`.

## Fonctionnalités

- Authentification Supabase, rôles administrateur / consultant et gestion des comptes de l'équipe.
- Tableau de bord multi-projets : création, sélection et suppression des missions.
- Contexte de projet généré par l’IA à partir d’une description en quelques phrases.
- Notes sauvegardées automatiquement.
- Thème mémorisé.
- Import de transcriptions `.txt` et `.md` ou collage direct.
- Synthèse détaillée et structurée des entretiens avec OpenAI.
- Résumé projet cumulatif : chaque nouvel entretien met à jour le résumé précédent.
- Suivi des entretiens persistant.
- Cartographie entièrement éditable : ajout, modification et suppression des phases et étapes.
- Statuts de cartographie : `confirmé`, `à vérifier` et `friction`.
- Espace Slack : lecture des messages directs envoyés au bot et synchronisation automatique.

## Vérifier la version de production

```bash
npm run build
```
