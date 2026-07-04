# Valorant Discord Alert

Envoie une alerte Discord (webhook) à chaque **victoire** ou **défaite** compétitive d'un joueur, avec **RR gagné/perdu**, **rang**, **K/D/A**, **KD**, **ACS** et **agent**.

Données via l'API non officielle **HenrikDev**.

## Installation

```bash
npm install          # (aucune dépendance externe, mais crée le lock)
cp .env.example .env # puis remplis les valeurs
```

## Configuration

**1. Variables d'environnement** (`.env`) :
- `HENRIK_API_KEY` : ta clé HenrikDev (dashboard : https://api.henrikdev.xyz/dashboard)
- `DISCORD_WEBHOOK_URL` : Salon Discord > Paramètres > Intégrations > Webhooks > Nouveau webhook > Copier l'URL
- `POLL_INTERVAL_SECONDS` : fréquence de check (60 par défaut)

**2. Joueurs à surveiller** (`players.json`) :
```json
[
  { "name": "TonPseudo", "tag": "EUW", "region": "eu" }
]
```
- `region` : `eu`, `na`, `ap`, `kr`, `latam`, `br`

## Lancement

```bash
npm start
```

Au **premier lancement**, le bot mémorise les matchs actuels sans alerter (évite le spam d'anciens matchs). Ensuite, chaque nouveau match compétitif déclenche une alerte.

## Déploiement Render

- Type : **Background Worker** (pas Web Service, il n'y a pas de port HTTP)
- Build : `npm install`
- Start : `npm start`
- Variables d'env à renseigner dans le dashboard Render

⚠️ Le disque Render (free) est **éphémère** : `state.json` est réinitialisé à chaque redeploy. Comme le bot re-seed au démarrage, tu ne recevras pas de faux positifs, juste un cycle sans alerte après un redeploy.

## Notes

- Rate limit HenrikDev : 30 req/min (clé Basic) / 90 (Advanced). Chaque joueur = ~2 req par cycle.
- API non officielle : peut casser sans préavis, non endorsée par Riot.
