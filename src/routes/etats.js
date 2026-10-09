const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { BOUTIQUES } = require("../constants");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function parseDateRange(dateDebut, dateFin) {
  const where = {};
  if (dateDebut) where.gte = new Date(`${dateDebut}T00:00:00`);
  if (dateFin) {
    const fin = new Date(`${dateFin}T00:00:00`);
    fin.setDate(fin.getDate() + 1);
    where.lt = fin;
  }
  return Object.keys(where).length ? where : undefined;
}

// Djenie (Administrateur) voit toutes les boutiques ; tout autre rôle est
// automatiquement restreint à sa propre boutique, quoi qu'il demande en filtre.
function scopedBoutique(req, requested) {
  if (req.user.role.systeme) return requested || undefined;
  return req.user.boutique;
}

// Djenie peut consulter n'importe quelle période ; tout autre rôle (caissière) est
// automatiquement restreint au jour même, quoi qu'il envoie en paramètre (y compris
// en modifiant l'URL directement) — la restriction se fait donc bien côté serveur.
function scopedDateRange(req, dateDebut, dateFin) {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  if (req.user.role.systeme) return { dateDebut, dateFin };
  return { dateDebut: aujourdhui, dateFin: aujourdhui };
}

function scopedDate(req, date) {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  if (req.user.role.systeme) return date || aujourdhui;
  return aujourdhui;
}

// Total des retours (avoirs générés) traités sur la période/boutique donnée.
// On se base sur la date du retour (pas la date de la vente d'origine) : c'est le jour
// où le retour est traité qui doit voir son CA net diminuer, pas le jour de la vente initiale.
async function totalRetoursPeriode(dateField, boutique) {
  const retours = await prisma.retour.findMany({
    where: { date: dateField, boutique, type: "Retour", montantRembourse: { not: null } },
  });
  return retours.reduce((s, r) => s + (r.montantRembourse || 0), 0);
}

// Cartes cadeaux VENDUES (créées) sur la période/boutique donnée — c'est un véritable
// encaissement au moment de la vente de la carte, distinct de son utilisation ultérieure
// comme mode de paiement (qui elle est déjà déduite du CA des ventes pour éviter le doublon).
// Exclut les cartes émises depuis le panier d'une vente (origineVenteId renseigné) : leur
// montant est déjà inclus dans vente.total via cette vente-là — les compter ici doublonnerait.
async function cartesCadeauxVenduesPeriode(dateField, boutique) {
  const cartes = await prisma.bonValeur.findMany({
    // modePaiement absent = carte "historique" enregistrée pour une carte vendue avant tout
    // logiciel : ce n'est jamais un encaissement du jour, à exclure du total comme du détail.
    where: { type: "CADEAU", createdAt: dateField, boutique, origineVenteId: null, enStock: false, modePaiement: { not: null } },
  });
  const total = cartes.reduce((s, c) => s + c.montant, 0);
  return { cartes, total };
}

// Supplément payé lors d'un échange vers un article plus cher — un vrai encaissement du jour,
// à ajouter partout où on additionne les paiements d'une vente normale (voir routes/retours.js).
async function echangesSupplementPeriode(dateField, boutique) {
  const echanges = await prisma.retour.findMany({
    where: { date: dateField, boutique, supplementPaye: { not: null } },
    include: { paiements: true },
  });
  const paiements = echanges.flatMap((e) => e.paiements);
  const total = paiements.reduce((s, p) => s + p.montant, 0);
  return { echanges, paiements, total };
}

// Règlements reçus sur des créances historiques (anciennes dettes Abigescom) sur la période/boutique.
// Comme pour les règlements de crédit, c'est un vrai encaissement du jour, à ajouter au total.
async function reglementsCreancesPeriode(dateField, boutique) {
  const reglements = await prisma.creanceReglement.findMany({
    where: { createdAt: dateField, boutique },
    include: { creance: { include: { client: true } } },
  });
  const total = reglements.reduce((s, r) => s + r.montant, 0);
  return { reglements, total };
}

// Avances de livraison réellement encaissées sur la période/boutique (au départ du livreur),
// quelle que soit la date de clôture du bon (qui peut tomber bien plus tard, voire jamais si le
// bon est encore en cours) — voir routes/bons-livraison.js. Comme pour les règlements de crédit,
// c'est un vrai encaissement du jour, à compter sur SA propre date, jamais sur celle de la vente
// que la clôture finira par générer.
async function avancesLivraisonPeriode(dateField, boutique) {
  const avances = await prisma.paiement.findMany({
    where: { viaAvanceLivraison: true, createdAt: dateField, bonLivraison: { boutique } },
    include: { bonLivraison: true },
  });
  const total = avances.reduce((s, p) => s + p.montant, 0);
  return { avances, total };
}

// GET /api/etats/par-date?dateDebut=&dateFin=&boutique=
router.get("/par-date", async (req, res) => {
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = parseDateRange(dateDebut, dateFin);

  const ventes = await prisma.vente.findMany({
    where: { date: plage, boutique: boutiqueFiltre, statut: "Validee" },
    include: { lignes: true, paiements: true, vendeur: true, client: true, caissier: true },
    orderBy: { date: "asc" },
  });
  const totalBrut = ventes.reduce((s, v) => s + v.total, 0);
  const totalCartesCadeauxUtilisees = ventes.reduce((s, v) => s + v.paiements.filter((p) => p.mode === "bon_achat").reduce((s2, p) => s2 + p.montant, 0), 0);
  const totalRetours = await totalRetoursPeriode(plage, boutiqueFiltre);
  const total = totalBrut - totalCartesCadeauxUtilisees - totalRetours;

  const { total: totalCartesCadeauxVendues } = await cartesCadeauxVenduesPeriode(plage, boutiqueFiltre);
  const { total: totalEchangesSupplement } = await echangesSupplementPeriode(plage, boutiqueFiltre);
  const totalAvecEchanges = total + totalEchangesSupplement;

  res.json({
    ventes, total: totalAvecEchanges, totalCartesCadeauxUtilisees, totalRetours, nombre: ventes.length,
    totalCartesCadeauxVendues, totalEchangesSupplement,
    totalEncaisseGlobal: totalAvecEchanges + totalCartesCadeauxVendues,
  });
});

// GET /api/etats/par-mode-paiement?dateDebut=&dateFin=&boutique=
router.get("/par-mode-paiement", async (req, res) => {
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = parseDateRange(dateDebut, dateFin);

  const ventes = await prisma.vente.findMany({
    where: { date: plage, boutique: boutiqueFiltre, statut: "Validee" },
    include: { paiements: true, client: true },
  });
  const parMode = {};
  const ajouterDetail = (mode, montant, ligne) => {
    if (!parMode[mode]) parMode[mode] = { montant: 0, nombre: 0, detail: [] };
    parMode[mode].montant += montant;
    parMode[mode].nombre += 1;
    parMode[mode].detail.push(ligne);
  };
  for (const v of ventes) {
    for (const p of v.paiements) {
      // L'avance d'une livraison est comptée séparément, sur sa vraie date d'encaissement (voir
      // avancesLivraisonPeriode ci-dessous) — jamais ici, sous peine de la compter deux fois ou
      // de la faire apparaître au mauvais jour.
      if (p.viaAvanceLivraison) continue;
      ajouterDetail(p.mode, p.montant, { venteNumero: v.numero, clientNom: v.client?.nomPrenoms || "Client de passage", montant: p.montant, heure: v.date });
    }
  }

  const { cartes: cartesVendues } = await cartesCadeauxVenduesPeriode(plage, boutiqueFiltre);
  for (const c of cartesVendues) {
    if (!c.modePaiement) continue;
    ajouterDetail(c.modePaiement, c.montant, { venteNumero: `Carte ${c.numero}`, clientNom: "Vente de carte cadeau", montant: c.montant, heure: c.createdAt });
  }

  // Supplément payé lors d'un échange vers un article plus cher — un vrai encaissement du jour,
  // à ajouter comme n'importe quel autre paiement (voir routes/retours.js).
  const { echanges: echangesAvecSupplement } = await echangesSupplementPeriode(plage, boutiqueFiltre);
  for (const e of echangesAvecSupplement) {
    for (const p of e.paiements) {
      ajouterDetail(p.mode, p.montant, { venteNumero: "Échange (supplément)", clientNom: "Article échangé", montant: p.montant, heure: e.date });
    }
  }

  // Avance perçue au départ d'une livraison — encaissée aujourd'hui même si le bon n'est pas
  // encore (ou pas du tout) clôturé.
  const { avances: avancesLivraison } = await avancesLivraisonPeriode(plage, boutiqueFiltre);
  for (const a of avancesLivraison) {
    ajouterDetail(a.mode, a.montant, { venteNumero: `Livraison ${a.bonLivraison.numero}`, clientNom: a.bonLivraison.clientNom, montant: a.montant, heure: a.createdAt });
  }

  const totalMonnaieRendue = ventes.reduce((s, v) => s + v.monnaieRendue, 0);
  if (parMode.especes) parMode.especes.montant -= totalMonnaieRendue;
  const recap = Object.entries(parMode).map(([mode, r]) => ({
    mode, montant: r.montant, nombre: r.nombre,
    detail: r.detail.sort((a, b) => new Date(b.heure) - new Date(a.heure)),
  }));
  const total = recap.reduce((s, r) => s + r.montant, 0);

  // Part des ventes à crédit d'aujourd'hui pas encore réellement payée — ce n'est pas un "mode
  // de paiement" à proprement parler, mais Djenie veut la voir ici : c'est de la marchandise
  // sortie aujourd'hui sans encaissement immédiat, à recouvrer plus tard.
  const ventesCredit = ventes.filter((v) => v.typeVente === "Credit");
  const creditDetail = [];
  const totalCredit = ventesCredit.reduce((s, v) => {
    const paye = v.paiements.reduce((s2, p) => s2 + p.montant, 0);
    const reste = Math.max(0, v.total - paye);
    if (reste > 0) creditDetail.push({ venteNumero: v.numero, clientNom: v.client?.nomPrenoms || "Client de passage", montant: reste, heure: v.date });
    return s + reste;
  }, 0);

  res.json({ recap, total, totalMonnaieRendue, totalCredit, creditDetail: creditDetail.sort((a, b) => new Date(b.heure) - new Date(a.heure)) });
});

// GET /api/etats/par-type?dateDebut=&dateFin=&boutique=  (Boutique / Livraison / Expédition)
router.get("/par-type", async (req, res) => {
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const recap = await prisma.vente.groupBy({
    by: ["modeVente"],
    where: {
      date: parseDateRange(dateDebut, dateFin),
      boutique: scopedBoutique(req, boutique),
      statut: "Validee",
    },
    _sum: { total: true },
    _count: { _all: true },
  });
  const total = recap.reduce((s, r) => s + (r._sum.total || 0), 0);
  res.json({
    recap: recap.map((r) => ({ modeVente: r.modeVente, montant: r._sum.total || 0, nombre: r._count._all })),
    total,
  });
});

// GET /api/etats/fermeture-caisse?date=&boutique=
router.get("/fermeture-caisse", async (req, res) => {
  const { boutique } = req.query;
  const jour = scopedDate(req, req.query.date);
  const debut = new Date(`${jour}T00:00:00`);
  const fin = new Date(debut);
  fin.setDate(fin.getDate() + 1);

  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = { gte: debut, lt: fin };

  // Ventes du jour (encaissement initial), quel que soit leur type
  const ventes = await prisma.vente.findMany({
    where: { date: plage, boutique: boutiqueFiltre, statut: "Validee" },
    include: { paiements: true },
  });

  // Règlements de crédit reçus AUJOURD'HUI, même si la vente d'origine date d'avant —
  // c'est la correction clé : ces montants entrent bien en caisse ce jour-là.
  const reglementsRecus = await prisma.paiement.findMany({
    where: {
      viaReglement: true,
      createdAt: plage,
      vente: { boutique: boutiqueFiltre, statut: "Validee" },
    },
    include: { vente: { include: { client: true } } },
  });

  // Cartes cadeaux vendues aujourd'hui — encaissement à part entière, distinct des ventes d'articles.
  const { cartes: cartesVendues, total: totalCartesCadeauxVendues } = await cartesCadeauxVenduesPeriode(plage, boutiqueFiltre);

  // Supplément payé lors d'un échange vers un article plus cher — même principe.
  const { paiements: paiementsEchanges, total: totalEchangesSupplement } = await echangesSupplementPeriode(plage, boutiqueFiltre);

  // Règlements reçus aujourd'hui sur des créances historiques (anciennes dettes Abigescom).
  const { reglements: reglementsCreances, total: totalReglementsCreances } = await reglementsCreancesPeriode(plage, boutiqueFiltre);

  // Avances de livraison réellement perçues aujourd'hui (départ du livreur) — voir plus haut.
  const { avances: avancesLivraison, total: totalAvancesLivraison } = await avancesLivraisonPeriode(plage, boutiqueFiltre);

  const totalCartesCadeauxUtilisees = ventes.reduce((s, v) => s + v.paiements.filter((p) => p.mode === "bon_achat").reduce((s2, p) => s2 + p.montant, 0), 0);
  const totalRetours = await totalRetoursPeriode(plage, boutiqueFiltre);
  const totalVentesNet = ventes.reduce((s, v) => s + v.total, 0) - totalCartesCadeauxUtilisees - totalRetours + totalEchangesSupplement;
  const totalMonnaieRendue = ventes.reduce((s, v) => s + v.monnaieRendue, 0);
  const totalReglementsRecus = reglementsRecus.reduce((s, p) => s + p.montant, 0);

  const parMode = {};
  for (const v of ventes) {
    for (const p of v.paiements) {
      // Comptée séparément plus bas, sur sa vraie date d'encaissement — jamais ici (voir
      // avancesLivraisonPeriode : elle serait sinon comptée au jour de la clôture, à tort).
      if (p.viaAvanceLivraison) continue;
      parMode[p.mode] = (parMode[p.mode] || 0) + p.montant;
    }
  }
  for (const p of reglementsRecus) {
    parMode[p.mode] = (parMode[p.mode] || 0) + p.montant;
  }
 for (const c of cartesVendues) {
    if (!c.modePaiement) continue;
    parMode[c.modePaiement] = (parMode[c.modePaiement] || 0) + c.montant;
  }
  for (const r of reglementsCreances) {
    parMode[r.mode] = (parMode[r.mode] || 0) + r.montant;
  }
  for (const p of paiementsEchanges) {
    parMode[p.mode] = (parMode[p.mode] || 0) + p.montant;
  }
  for (const a of avancesLivraison) {
    parMode[a.mode] = (parMode[a.mode] || 0) + a.montant;
  }

  // Remises encore EN_ATTENTE mais déjà rattachées à une vente (donc déjà encaissées au tarif réduit
  // par la caissière) — elles expliquent un écart en caisse tant que Djenie ne les a pas tranchées.
  // Non limité au jour consulté : une remise en attente depuis plusieurs jours continue d'expliquer
  // l'écart tant qu'elle n'est pas traitée.
  const remisesEnAttente = await prisma.demandeRemise.findMany({
    where: { statut: "EN_ATTENTE", boutique: boutiqueFiltre, utilisee: true },
    include: { vente: true, demandePar: true },
    orderBy: { createdAt: "asc" },
  });
  const totalRemisesEnAttente = remisesEnAttente.reduce((s, d) => s + d.montantRemise, 0);

  res.json({    date: jour,
    boutique: boutiqueFiltre || "Toutes",
    remisesEnAttente: remisesEnAttente.map((d) => ({
      numero: d.numero,
      venteNumero: d.vente?.numero || null,
      montantRemise: d.montantRemise,
      demandePar: d.demandePar ? `${d.demandePar.prenom} ${d.demandePar.nom}` : null,
      date: d.createdAt,
    })),
    totalRemisesEnAttente,
    nombreVentes: ventes.length,
    totalVentes: totalVentesNet,
    totalCartesCadeauxUtilisees,
    totalRetours,
    totalMonnaieRendue,
    totalReglementsRecus,
    totalCartesCadeauxVendues,
    totalEchangesSupplement,
    totalReglementsCreancesHistoriques: totalReglementsCreances,
    totalAvancesLivraison,
    totalEncaisseGlobal: totalVentesNet + totalReglementsRecus + totalCartesCadeauxVendues + totalReglementsCreances + totalAvancesLivraison,
    parMode: Object.entries(parMode).map(([mode, montant]) => ({ mode, montant })),
    reglementsDetail: reglementsRecus.map((p) => ({
      venteNumero: p.vente.numero,
      clientNom: p.vente.client?.nomPrenoms || "Client inconnu",
      mode: p.mode,
      montant: p.montant,
      heure: p.createdAt,
    })),
    cartesCadeauxVenduesDetail: cartesVendues.map((c) => ({
      numero: c.numero,
      montant: c.montant,
      mode: c.modePaiement,
      heure: c.createdAt,
    })),
    reglementsCreancesDetail: reglementsCreances.map((r) => ({
      clientNom: r.creance.client?.nomPrenoms || "Client inconnu",
      mode: r.mode,
      montant: r.montant,
      heure: r.createdAt,
    })),
    avancesLivraisonDetail: avancesLivraison.map((a) => ({
      bonNumero: a.bonLivraison.numero,
      clientNom: a.bonLivraison.clientNom,
      mode: a.mode,
      montant: a.montant,
      heure: a.createdAt,
    })),
  });
});

// GET /api/etats/recap-boutiques?dateDebut=&dateFin=  — réservé à l'administrateur (Djenie) :
// ventes et règlements réellement encaissés, par boutique, avec le cumul des deux.
router.get("/recap-boutiques", async (req, res) => {
  if (!req.user.role.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  const { dateDebut, dateFin } = req.query;
  const plage = parseDateRange(dateDebut, dateFin);

  const { BOUTIQUES } = require("../constants");
  const boutiques = BOUTIQUES;
  const parBoutique = [];

  for (const boutique of boutiques) {
    const ventes = await prisma.vente.findMany({
      where: { date: plage, boutique, statut: "Validee" },
      include: { paiements: true },
    });
    const totalVentes = ventes.reduce((s, v) => s + v.total, 0);
    const totalCartesCadeauxUtilisees = ventes.reduce((s, v) => s + v.paiements.filter((p) => p.mode === "bon_achat").reduce((s2, p) => s2 + p.montant, 0), 0);
    const totalRetours = await totalRetoursPeriode(plage, boutique);
    const totalMonnaieRendue = ventes.reduce((s, v) => s + v.monnaieRendue, 0);
    const totalPaiements = ventes.reduce((s, v) => s + v.paiements.reduce((s2, p) => s2 + p.montant, 0), 0) - totalMonnaieRendue;
    const { total: totalCartesCadeauxVendues } = await cartesCadeauxVenduesPeriode(plage, boutique);
    const { total: totalReglementsCreances } = await reglementsCreancesPeriode(plage, boutique);
    const { total: totalEchangesSupplement } = await echangesSupplementPeriode(plage, boutique);
    parBoutique.push({
      boutique, nombreVentes: ventes.length,
      totalVentes: totalVentes - totalCartesCadeauxUtilisees - totalRetours + totalEchangesSupplement,
      totalRetours,
      totalReglements: totalPaiements,
      totalCartesCadeauxVendues,
      totalEchangesSupplement,
      totalReglementsCreancesHistoriques: totalReglementsCreances,
    });
  }

  const cumul = {
    nombreVentes: parBoutique.reduce((s, b) => s + b.nombreVentes, 0),
    totalVentes: parBoutique.reduce((s, b) => s + b.totalVentes, 0),
    totalRetours: parBoutique.reduce((s, b) => s + b.totalRetours, 0),
    totalReglements: parBoutique.reduce((s, b) => s + b.totalReglements, 0),
    totalCartesCadeauxVendues: parBoutique.reduce((s, b) => s + b.totalCartesCadeauxVendues, 0),
    totalReglementsCreancesHistoriques: parBoutique.reduce((s, b) => s + b.totalReglementsCreancesHistoriques, 0),
  };

  res.json({ parBoutique, cumul });
});

// GET /api/etats/audit-remises?dateDebut=&dateFin=  — réservé à l'administrateur (Djenie) :
// vérifie que chaque vente avec remise correspond bien à une demande APPROUVEE par elle.
router.get("/audit-remises", async (req, res) => {
  if (!req.user.role.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  const { dateDebut, dateFin } = req.query;
  const plage = parseDateRange(dateDebut, dateFin);

  const ventes = await prisma.vente.findMany({
    where: { date: plage, montantRemise: { gt: 0 } },
    include: {
      demandeRemise: { include: { traitePar: true, demandePar: true } },
      caissier: true,
    },
    orderBy: { date: "desc" },
  });

  const lignes = ventes.map((v) => {
    const d = v.demandeRemise;
    const problemes = [];
    if (!d) problemes.push("Aucune demande liée");
    else {
      if (d.statut !== "APPROUVEE") problemes.push(`Statut = ${d.statut}`);
      if (!d.traiteParId) problemes.push("Aucun administrateur ayant traité");
      if (d.montantRemise !== v.montantRemise) problemes.push("Montant demande ≠ montant vente");
    }
    return {
      venteId: v.id, venteNumero: v.numero, date: v.date, boutique: v.boutique,
      montantRemise: v.montantRemise,
      caissier: v.caissier ? `${v.caissier.prenom} ${v.caissier.nom}` : null,
      demandeNumero: d?.numero || null,
      demandeStatut: d?.statut || null,
      traitePar: d?.traitePar ? `${d.traitePar.prenom} ${d.traitePar.nom}` : null,
      demandePar: d?.demandePar ? `${d.demandePar.prenom} ${d.demandePar.nom}` : null,
      suspecte: problemes.length > 0,
      problemes,
    };
  });

  res.json({
    lignes,
    total: lignes.length,
    nbSuspectes: lignes.filter((l) => l.suspecte).length,
  });
});

// GET /api/etats/par-vendeur?dateDebut=&dateFin=&boutique=
// Performance de chaque vendeuse : montant total vendu, nombre de ventes, panier moyen.
// Classement du meilleur au moins bon vendeur sur la période.
router.get("/par-vendeur", async (req, res) => {
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);

  const ventes = await prisma.vente.findMany({
    where: { date: parseDateRange(dateDebut, dateFin), boutique: boutiqueFiltre, statut: "Validee" },
    include: { vendeur: true },
  });

  const parVendeur = {};
  for (const v of ventes) {
    if (!v.vendeur) continue;
    if (!parVendeur[v.vendeurId]) {
      parVendeur[v.vendeurId] = { vendeurId: v.vendeurId, nom: v.vendeur.nom, boutique: v.vendeur.boutique, montant: 0, nombre: 0 };
    }
    parVendeur[v.vendeurId].montant += v.total;
    parVendeur[v.vendeurId].nombre += 1;
  }

  const classement = Object.values(parVendeur)
    .map((v) => ({ ...v, panierMoyen: v.nombre ? Math.round(v.montant / v.nombre) : 0 }))
    .sort((a, b) => b.montant - a.montant);

  res.json({ classement, meilleur: classement[0] || null });
});

// GET /api/etats/par-client?dateDebut=&dateFin=&boutique=&limite=
// Classement des clientes par montant cumulé d'achats sur la période — pour identifier les
// meilleures clientes en vue d'offres commerciales ciblées. Ventes sans client (passage anonyme)
// exclues du classement, car aucune fiche à créditer.
router.get("/par-client", async (req, res) => {
  const { boutique, limite } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);

  const ventes = await prisma.vente.findMany({
    where: { date: parseDateRange(dateDebut, dateFin), boutique: boutiqueFiltre, statut: "Validee", clientId: { not: null } },
    include: { client: true },
  });

  const parClient = {};
  for (const v of ventes) {
    if (!v.client) continue;
    if (!parClient[v.clientId]) {
      parClient[v.clientId] = {
        clientId: v.clientId, nomPrenoms: v.client.nomPrenoms, telephone: v.client.telephone,
        carteFidelite: v.client.carteFidelite, montant: 0, nombre: 0,
      };
    }
    parClient[v.clientId].montant += v.total;
    parClient[v.clientId].nombre += 1;
  }

  const classementComplet = Object.values(parClient)
    .map((c) => ({ ...c, panierMoyen: c.nombre ? Math.round(c.montant / c.nombre) : 0 }))
    .sort((a, b) => b.montant - a.montant);

  const classement = limite ? classementComplet.slice(0, Number(limite)) : classementComplet;
  res.json({ classement, meilleure: classement[0] || null });
});

// GET /api/etats/livraison-jour?boutique=  — pour le tableau de bord : nombre de paires de
// chaussures parties avec un livreur aujourd'hui, et nombre revenues (rendues) le même jour,
// détaillé par boutique (comme pour le chiffre d'affaires du jour) — pas juste un total mélangé.
// Ne compte que la famille "Chaussure", conformément à la demande ("nombre de chaussures").
router.get("/livraison-jour", async (req, res) => {
  const { boutique } = req.query;
  const jour = scopedDate(req, req.query.date);
  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = parseDateRange(jour, jour);

  const [sorties, retours] = await Promise.all([
    prisma.mouvementStock.findMany({
      where: { type: "SortieLivraison", date: plage, boutique: boutiqueFiltre, article: { famille: "Chaussure" } },
      select: { quantite: true, boutique: true },
    }),
    prisma.mouvementStock.findMany({
      where: { type: "RetourLivraison", date: plage, boutique: boutiqueFiltre, article: { famille: "Chaussure" } },
      select: { quantite: true, boutique: true },
    }),
  ]);

  const parBoutique = BOUTIQUES.map((b) => ({
    boutique: b,
    parties: sorties.filter((m) => m.boutique === b).reduce((s, m) => s + m.quantite, 0),
    retournees: retours.filter((m) => m.boutique === b).reduce((s, m) => s + m.quantite, 0),
  }));

  res.json({
    parties: sorties.reduce((s, m) => s + m.quantite, 0),
    retournees: retours.reduce((s, m) => s + m.quantite, 0),
    parBoutique,
  });
});

// GET /api/etats/livraisons?dateDebut=&dateFin=&boutique=
// État complet des bons de livraison sur une période — pour que Djenie sache ce qui s'y passe
// au-delà du seul aperçu "aujourd'hui" du tableau de bord. Filtré sur famille "Chaussure",
// comme le reste du suivi livraison (le cas d'usage cité par Djenie).
router.get("/livraisons", async (req, res) => {
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = parseDateRange(dateDebut, dateFin);

  const bons = await prisma.bonLivraison.findMany({
    where: { dateCreation: plage, boutique: boutiqueFiltre },
    include: {
      lignes: { include: { article: true } },
      creePar: true, cloturePar: true,
      venteGeneree: { select: { numero: true, total: true } },
    },
    orderBy: { dateCreation: "desc" },
  });

  const chaussureSeulement = (l) => l.article.famille === "Chaussure";

  const paires = { parties: 0, vendues: 0, retournees: 0, perdues: 0 };
  let valeurPertes = 0;
  let totalVenteGeneree = 0;
  const parBoutiqueMap = {};

  for (const b of bons) {
    if (!parBoutiqueMap[b.boutique]) parBoutiqueMap[b.boutique] = { boutique: b.boutique, nombreBons: 0, parties: 0, vendues: 0, retournees: 0, perdues: 0 };
    parBoutiqueMap[b.boutique].nombreBons++;

    for (const l of b.lignes.filter(chaussureSeulement)) {
      paires.parties += l.quantite;
      parBoutiqueMap[b.boutique].parties += l.quantite;
      if (l.statut === "VENDU") { paires.vendues += l.quantite; parBoutiqueMap[b.boutique].vendues += l.quantite; }
      if (l.statut === "RETOURNE") { paires.retournees += l.quantite; parBoutiqueMap[b.boutique].retournees += l.quantite; }
      if (l.statut === "PERDU") { paires.perdues += l.quantite; parBoutiqueMap[b.boutique].perdues += l.quantite; valeurPertes += l.quantite * l.prixUnitaire; }
    }
    if (b.venteGeneree) totalVenteGeneree += b.venteGeneree.total;
  }

  res.json({
    nombreBons: bons.length,
    nombreEnCours: bons.filter((b) => b.statut === "EN_COURS").length,
    nombreClotures: bons.filter((b) => b.statut === "CLOTURE").length,
    nombreAnnules: bons.filter((b) => b.statut === "ANNULE").length,
    paires, valeurPertes, totalVenteGeneree,
    parBoutique: Object.values(parBoutiqueMap),
    bons: bons.map((b) => ({
      numero: b.numero, clientNom: b.clientNom, boutique: b.boutique, statut: b.statut,
      dateCreation: b.dateCreation, dateCloture: b.dateCloture,
      creePar: b.creePar ? `${b.creePar.prenom} ${b.creePar.nom}` : null,
      venteGeneree: b.venteGeneree,
      lignes: b.lignes.map((l) => ({ designation: l.article.designation, pointure: l.pointure, quantite: l.quantite, statut: l.statut })),
    })),
  });
});

// GET /api/etats/marge?dateDebut=&dateFin=&boutique= — réservé à l'administrateur :
// marge = prix de vente - prix d'achat figé au moment de chaque vente (LigneVente.coutUnitaire),
// jamais le prix d'achat courant de l'article (qui peut avoir changé depuis). Les lignes dont le
// coût était inconnu à la vente (coutUnitaire null, article jamais reçu via une réception avec
// prix) sont comptées à part, pour ne pas fausser la marge affichée avec un coût de 0.
router.get("/marge", async (req, res) => {
  if (!req.user.role.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  const { boutique } = req.query;
  const { dateDebut, dateFin } = scopedDateRange(req, req.query.dateDebut, req.query.dateFin);
  const boutiqueFiltre = scopedBoutique(req, boutique);
  const plage = parseDateRange(dateDebut, dateFin);

  const lignes = await prisma.ligneVente.findMany({
    where: { vente: { date: plage, boutique: boutiqueFiltre, statut: "Validee" } },
    include: { article: true },
  });

  let chiffreAffaires = 0, coutTotal = 0, nombreLignesCoutInconnu = 0, quantiteCoutInconnu = 0;
  const parArticle = {};

  for (const l of lignes) {
    chiffreAffaires += l.sousTotal;
    if (l.coutUnitaire == null) {
      nombreLignesCoutInconnu += 1;
      quantiteCoutInconnu += l.quantite;
      continue;
    }
    const cout = l.coutUnitaire * l.quantite;
    coutTotal += cout;

    const cle = l.articleId;
    if (!parArticle[cle]) {
      parArticle[cle] = { articleId: l.articleId, designation: l.designation, marque: l.marque, quantite: 0, chiffreAffaires: 0, cout: 0 };
    }
    parArticle[cle].quantite += l.quantite;
    parArticle[cle].chiffreAffaires += l.sousTotal;
    parArticle[cle].cout += cout;
  }

  const parArticleListe = Object.values(parArticle)
    .map((a) => ({ ...a, marge: a.chiffreAffaires - a.cout, margePourcent: a.chiffreAffaires ? Math.round(((a.chiffreAffaires - a.cout) / a.chiffreAffaires) * 100) : null }))
    .sort((a, b) => b.marge - a.marge);

  const marge = chiffreAffaires - coutTotal;
  res.json({
    chiffreAffaires, coutTotal, marge,
    margePourcent: chiffreAffaires ? Math.round((marge / chiffreAffaires) * 100) : null,
    nombreLignesCoutInconnu, quantiteCoutInconnu,
    parArticle: parArticleListe,
  });
});

module.exports = router;
