import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Chargement de la config depuis les variables d'environnement ---
const API_KEY = process.env.HENRIK_API_KEY;
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POLL_INTERVAL = (Number(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(ROOT, "state.json");
const PLAYERS_FILE = path.join(ROOT, "players.json");

const BASE = "https://api.henrikdev.xyz/valorant";

// Secours : conversion numéro de palier -> nom lisible, si l'API ne renvoie pas le nom
const TIER_NAMES = {
  0: "Non classé", 3: "Fer 1", 4: "Fer 2", 5: "Fer 3",
  6: "Bronze 1", 7: "Bronze 2", 8: "Bronze 3",
  9: "Argent 1", 10: "Argent 2", 11: "Argent 3",
  12: "Or 1", 13: "Or 2", 14: "Or 3",
  15: "Platine 1", 16: "Platine 2", 17: "Platine 3",
  18: "Diamant 1", 19: "Diamant 2", 20: "Diamant 3",
  21: "Ascendant 1", 22: "Ascendant 2", 23: "Ascendant 3",
  24: "Immortel 1", 25: "Immortel 2", 26: "Immortel 3",
  27: "Radiant",
};

if (!API_KEY || !WEBHOOK_URL) {
  console.error("❌ HENRIK_API_KEY et DISCORD_WEBHOOK_URL sont obligatoires (voir .env.example).");
  process.exit(1);
}

// --- Petit helper de log horodaté ---
const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- Appel générique à l'API HenrikDev ---
async function henrik(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: { Authorization: API_KEY },
  });
  if (res.status === 429) {
    log("⚠️  Rate limit atteint, on attend le prochain cycle.");
    return null;
  }
  if (!res.ok) {
    log(`⚠️  Erreur API ${res.status} sur ${endpoint}`);
    return null;
  }
  return res.json();
}

// --- Persistance du dernier match connu par joueur ---
async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Récupère le dernier match compétitif via l'historique MMR ---
// Renvoie { matchId, rrChange, rankPatched, rankInTier, map } ou null
async function getLastCompetitive(player) {
  const { name, tag, region } = player;
  const enc = (s) => encodeURIComponent(s);
  const data = await henrik(`/v1/mmr-history/${region}/${enc(name)}/${enc(tag)}`);
  if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;

  const last = data.data[0]; // le plus récent en premier
  return {
    matchId: last.match_id,
    rrChange: last.mmr_change_to_last_game, // + = victoire, - = défaite
    rankPatched: last.currenttier_patched,  // ex: "Diamond 2" (parfois absent)
    currenttier: last.currenttier,           // numéro de palier (secours)
    rankInTier: last.ranking_in_tier,        // RR actuel dans le palier (0-100)
    map: last.map?.name ?? "?",
  };
}

// --- Récupère les stats détaillées (KDA, agent, ACS) du dernier match compétitif ---
async function getMatchStats(player, matchId) {
  const { name, tag, region } = player;
  const enc = (s) => encodeURIComponent(s);
  const data = await henrik(
    `/v3/matches/${region}/${enc(name)}/${enc(tag)}?filter=competitive&size=1`
  );
  if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;

  const match = data.data[0];
  if (match.metadata?.matchid && match.metadata.matchid !== matchId) {
    // désynchro possible entre mmr-history et matches : on garde quand même
    log("ℹ️  match_id mmr-history ≠ matches, stats basées sur le dernier match dispo.");
  }

  const me = match.players?.all_players?.find(
    (p) => p.name?.toLowerCase() === name.toLowerCase() && p.tag?.toLowerCase() === tag.toLowerCase()
  );
  if (!me) return null;

  const rounds = match.metadata?.rounds_played || 1;
  const s = me.stats || {};
  const acs = Math.round((s.score || 0) / rounds);
  const kd = s.deaths ? (s.kills / s.deaths) : s.kills;

  return {
    agent: me.character ?? "?",
    kills: s.kills ?? 0,
    deaths: s.deaths ?? 0,
    assists: s.assists ?? 0,
    kd: kd.toFixed(2),
    acs,
    rank: me.currenttier_patched,            // rang du joueur d'après les détails du match
    currenttier: me.currenttier,             // numéro de palier (secours)
    map: match.metadata?.map ?? "?",
    mode: match.metadata?.mode ?? "Competitive",
  };
}

// --- Construit et envoie l'embed Discord ---
async function sendAlert(player, mmr, stats) {
  const win = mmr.rrChange >= 0;
  const rrText = win ? `+${mmr.rrChange} RR` : `${mmr.rrChange} RR`;

  const title = win
    ? `🟢 ${player.name}#${player.tag} a GAGNÉ`
    : `🔴 ${player.name}#${player.tag} a PERDU`;

  const description = win
    ? `Victoire sur **${stats?.map ?? mmr.map}** — beau boulot !`
    : `Défaite sur **${stats?.map ?? mmr.map}**... ça arrive.`;

  // Rang : on essaie plusieurs sources dans l'ordre, avec secours par la table des paliers
  const tierNum = stats?.currenttier ?? mmr.currenttier;
  const rankName =
    stats?.rank ||
    mmr.rankPatched ||
    TIER_NAMES[tierNum] ||
    "Rang inconnu";

  const fields = [
    { name: "RR", value: `${rrText}\n(${rankName} · ${mmr.rankInTier} RR)`, inline: true },
  ];

  if (stats) {
    fields.push(
      { name: "K/D/A", value: `${stats.kills} / ${stats.deaths} / ${stats.assists}`, inline: true },
      { name: "KD · ACS", value: `${stats.kd} · ${stats.acs}`, inline: true },
      { name: "Agent", value: stats.agent, inline: true }
    );
  }

  const embed = {
    title,
    description,
    color: win ? 0x2ecc71 : 0xe74c3c, // vert / rouge
    fields,
    footer: { text: `Valorant · ${stats?.mode ?? "Competitive"}` },
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (res.ok || res.status === 204) {
    log(`✅ Alerte envoyée pour ${player.name}#${player.tag} (${rrText})`);
  } else {
    log(`⚠️  Échec envoi webhook (${res.status})`);
  }
}

// --- Un cycle complet : check tous les joueurs ---
async function checkAll(players, state, firstRun) {
  log(`🔍 Check des ${players.length} joueur(s)...`);
  for (const player of players) {
    const key = `${player.region}:${player.name}#${player.tag}`.toLowerCase();
    const tag = `${player.name}#${player.tag}`;
    try {
      const mmr = await getLastCompetitive(player);
      if (!mmr) {
        log(`   ⚪ ${tag} : pas d'historique classé (jamais de ranked cet acte, ou match pas encore traité)`);
        continue;
      }

      const known = state[key];

      // Au tout premier lancement : on mémorise sans alerter (évite de spammer d'anciens matchs)
      if (firstRun && known === undefined) {
        state[key] = mmr.matchId;
        log(`📌 Seed ${tag} → ${mmr.matchId}`);
        continue;
      }

      if (mmr.matchId && mmr.matchId !== known) {
        log(`   🆕 ${tag} : NOUVEAU match détecté (${mmr.matchId.slice(0, 8)}...) → envoi alerte`);
        const stats = await getMatchStats(player, mmr.matchId);
        await sendAlert(player, mmr, stats);
        state[key] = mmr.matchId;
      } else {
        log(`   ⚪ ${tag} : rien de neuf (dernier: ${mmr.matchId.slice(0, 8)}...)`);
      }
    } catch (err) {
      log(`⚠️  Erreur sur ${tag}:`, err.message);
    }
    // petite pause entre joueurs pour rester loin du rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }
  await saveState(state);
  log(`✔️  Cycle terminé. Prochain check dans ${POLL_INTERVAL / 1000}s.`);
}

// --- Boucle principale ---
async function main() {
  const players = JSON.parse(await fs.readFile(PLAYERS_FILE, "utf8"));
  const state = await loadState();
  const firstRun = Object.keys(state).length === 0;

  log(`🚀 Démarrage · ${players.length} joueur(s) surveillé(s) · polling ${POLL_INTERVAL / 1000}s`);
  if (firstRun) log("ℹ️  Premier lancement : les matchs actuels sont mémorisés sans alerte.");

  await checkAll(players, state, firstRun);
  setInterval(() => checkAll(players, state, false), POLL_INTERVAL);

  // Mini serveur HTTP : requis pour tourner en Web Service gratuit sur Render.
  // Répond juste "OK" — sert aussi de cible au pinger UptimeRobot pour rester éveillé.
  const PORT = process.env.PORT || 3000;
  http
    .createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Valorant alert bot en ligne ✅");
    })
    .listen(PORT, () => log(`🌐 Serveur keep-alive sur le port ${PORT}`));

  // Auto-ping : le bot se réveille lui-même toutes les 10 min pour ne jamais
  // s'endormir sur le free-tier Render (indépendant d'UptimeRobot).
  const SELF_URL = process.env.SELF_URL;
  if (SELF_URL) {
    setInterval(async () => {
      try {
        await fetch(SELF_URL);
        log("💓 Auto-ping OK (anti-veille)");
      } catch (err) {
        log("⚠️  Auto-ping échoué:", err.message);
      }
    }, 10 * 60 * 1000); // toutes les 10 minutes
    log(`💓 Auto-ping activé vers ${SELF_URL}`);
  } else {
    log("ℹ️  SELF_URL non défini : auto-ping désactivé (ok en local).");
  }
}

main().catch((err) => {
  console.error("💥 Erreur fatale:", err);
  process.exit(1);
});
