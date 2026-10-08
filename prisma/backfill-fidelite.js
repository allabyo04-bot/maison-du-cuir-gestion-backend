// Script à lancer UNE SEULE FOIS, à la main, quand on est prêt à activer Cendrillon :
//   node prisma/backfill-fidelite.js
//
// 1) Crée les paliers de départ (bonus + statuts) définis avec Djenie, si aucun n'existe encore
//    (sans écraser des paliers déjà personnalisés par elle).
// 2) Reprend l'historique des ventes depuis le 13/07/2026 pour initialiser le cumul de chaque
//    cliente — mêmes règles que pour une vente en direct (voir src/fidelite.js) : seules les
//    ventes Comptant, sans la moindre remise (demandeRemiseId absent) et sans aucun article qui
//    était soldé au moment de cette vente-là, comptent. Comme aucun bonus n'a jamais existé avant
//    ce chantier, cumul courant = cumul total à vie au terme de cette reprise ; si une cliente
//    dépasse déjà un palier, son bonus sera automatiquement détecté et appliqué à son prochain
//    achat (rien à faire de spécial ici, c'est le même mécanisme que pour une vente normale).
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const DATE_DEPART = new Date("2026-07-13T00:00:00");

async function seedPaliers() {
  const nbBonus = await prisma.palierBonus.count();
  if (nbBonus === 0) {
    await prisma.palierBonus.createMany({
      data: [
        { seuilBas: 500000, seuilHaut: 995000, montantBonus: 15000 },
        { seuilBas: 996000, seuilHaut: null, montantBonus: 25000 },
      ],
    });
    console.log("Paliers de bonus créés (500 000-995 000 -> 15 000 F ; 996 000+ -> 25 000 F).");
  } else {
    console.log(`Paliers de bonus déjà présents (${nbBonus}) — non modifiés.`);
  }

  const nbStatuts = await prisma.palierStatut.count();
  if (nbStatuts === 0) {
    await prisma.palierStatut.createMany({
      data: [
        { nom: "Cendrillon Découverte", seuilBas: 0, seuilHaut: 249999 },
        { nom: "Cendrillon Fidèle", seuilBas: 250000, seuilHaut: 499999 },
        { nom: "Cendrillon Privilège", seuilBas: 500000, seuilHaut: 995000 },
        { nom: "Cendrillon VIP", seuilBas: 996000, seuilHaut: 1999999 },
        { nom: "Cendrillon Prestige", seuilBas: 2000000, seuilHaut: 4999999 },
        { nom: "Cendrillon Élite", seuilBas: 5000000, seuilHaut: null },
      ],
    });
    console.log("Paliers de statut créés (Découverte -> Élite).");
  } else {
    console.log(`Paliers de statut déjà présents (${nbStatuts}) — non modifiés.`);
  }
}

async function backfillCumuls() {
  const ventes = await prisma.vente.findMany({
    where: { date: { gte: DATE_DEPART }, typeVente: "Comptant", statut: "Validee", clientId: { not: null }, demandeRemiseId: null },
    include: { lignes: { select: { articleId: true } } },
    orderBy: { date: "asc" },
  });
  console.log(`${ventes.length} vente(s) comptant sans remise trouvée(s) depuis le ${DATE_DEPART.toLocaleDateString("fr-FR")}.`);

  // Toutes les lignes de campagnes soldées, avec les dates de la campagne — pour savoir si un
  // article donné était soldé à une date historique précise (pas seulement "en ce moment").
  const lignesSoldees = await prisma.ligneCampagneSolde.findMany({
    include: { campagne: { select: { dateDebut: true, dateFin: true } } },
  });
  const soldesParArticle = {};
  for (const l of lignesSoldees) {
    (soldesParArticle[l.articleId] ||= []).push({ debut: l.campagne.dateDebut, fin: l.campagne.dateFin });
  }
  function articleEtaitSolde(articleId, date) {
    const periodes = soldesParArticle[articleId];
    if (!periodes) return false;
    return periodes.some((p) => date >= p.debut && date <= p.fin);
  }

  const cumulParClient = {};
  let venteExclues = 0;
  for (const v of ventes) {
    const uneLigneSoldee = v.lignes.some((l) => articleEtaitSolde(l.articleId, v.date));
    if (uneLigneSoldee) { venteExclues++; continue; }
    cumulParClient[v.clientId] = (cumulParClient[v.clientId] || 0) + v.total;
  }
  console.log(`${venteExclues} vente(s) exclue(s) car elles contenaient un article soldé à l'époque.`);

  const paliersStatut = await prisma.palierStatut.findMany({ where: { actif: true }, orderBy: { seuilBas: "desc" } });
  function statutPour(cumul) {
    const p = paliersStatut.find((p) => cumul >= p.seuilBas && (p.seuilHaut == null || cumul <= p.seuilHaut));
    return p ? p.nom : null;
  }

  // On initialise dernierStatutNotifie pour TOUTES les clientes (y compris celles à 0 F,
  // "Découverte" par défaut) — sinon leur tout premier achat futur déclencherait à tort une
  // "alerte changement de statut" pour un statut de départ qui n'en est pas un.
  const tousLesClients = await prisma.client.findMany({ select: { id: true } });
  for (const c of tousLesClients) {
    const montant = cumulParClient[c.id] || 0;
    await prisma.client.update({
      where: { id: c.id },
      data: { cumulFideliteTotal: montant, cumulFideliteCourant: montant, dernierStatutNotifie: statutPour(montant) },
    });
  }
  console.log(`Cumul initialisé pour ${tousLesClients.length} cliente(s) au total (dont ${Object.keys(cumulParClient).length} avec un historique éligible).`);

  const eligiblesDepart = Object.keys(cumulParClient).filter((id) => cumulParClient[id] >= 500000).length;
  console.log(`Dont ${eligiblesDepart} cliente(s) ayant déjà un bonus disponible dès l'activation.`);
}

async function main() {
  await seedPaliers();
  await backfillCumuls();
}

main()
  .catch((e) => { console.error("Erreur pendant le rattrapage fidélité :", e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
