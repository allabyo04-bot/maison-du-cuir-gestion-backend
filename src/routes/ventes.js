const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { bonusDisponible, venteEligibleCumul, detecterChangementStatut } = require("../fidelite");
const { FIDELITE_ACTIF } = require("../constants");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function estAdmin(req) {
  return !!req.user?.role?.systeme;
}
function estAujourdhui(date) {
  const d = new Date(date);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// GET /api/ventes?boutique=&vendeurId=&clientId=  — historique / rapports
// Djenie voit tout, filtrable ; une caissière ne voit QUE les ventes du jour même de SA
// boutique, même si elle tente de passer d'autres filtres dans la requête — même principe
// que la restriction déjà en place sur Dépenses et États.
router.get("/", async (req, res) => {
  const { boutique, vendeurId, clientId } = req.query;
  const admin = estAdmin(req);

  if (!admin) {
    const debut = new Date(); debut.setHours(0, 0, 0, 0);
    const fin = new Date(); fin.setHours(23, 59, 59, 999);
    const ventes = await prisma.vente.findMany({
      where: { boutique: req.user.boutique, date: { gte: debut, lte: fin } },
      include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, annuleePar: true, cartesCadeauxEmises: true },
      orderBy: { date: "desc" },
    });
    return res.json(ventes);
  }

  const ventes = await prisma.vente.findMany({
    where: {
      boutique: boutique || undefined,
      caissierId: vendeurId || undefined,
      clientId: clientId || undefined,
    },
    include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, annuleePar: true, cartesCadeauxEmises: true },
    orderBy: { date: "desc" },
  });
  res.json(ventes);
});
// GET /api/ventes/credit?boutique=  — liste des ventes à crédit avec solde restant, non soldées en tête
router.get("/credit/liste", async (req, res) => {
  const { boutique } = req.query;
  const boutiqueFiltre = req.user.role.systeme ? (boutique || undefined) : req.user.boutique;
  const ventes = await prisma.vente.findMany({
    where: { typeVente: "Credit", boutique: boutiqueFiltre },
    include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, cartesCadeauxEmises: true },
    orderBy: { date: "desc" },
  });
  const avecSolde = ventes.map((v) => {
    const totalPaye = v.paiements.reduce((s, p) => s + p.montant, 0);
    return { ...v, totalPaye, resteAPayer: v.total - totalPaye };
  });
  res.json(avecSolde);
});

// POST /api/ventes/:id/reglement  { mode, montant, carteNumero? }
// Enregistre un paiement supplémentaire sur une vente à crédit déjà existante.
router.post("/:id/reglement", async (req, res) => {
  const { mode, montant, carteNumero } = req.body;
  const montantNum = Number(montant);
  if (!mode || !montantNum || montantNum <= 0) {
    return res.status(400).json({ error: "Mode de paiement et montant (positif) sont obligatoires." });
  }
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const vente = await tx.vente.findUnique({
        where: { id: req.params.id },
        include: { paiements: true, client: true, vendeur: true },
      });
      if (!vente) throw { status: 404, message: "Vente introuvable." };
      if (vente.typeVente !== "Credit") throw { status: 400, message: "Cette vente n'est pas une vente à crédit." };

      const totalPaye = vente.paiements.reduce((s, p) => s + p.montant, 0);
      const reste = vente.total - totalPaye;
      if (montantNum > reste) {
        throw { status: 400, message: `Le montant dépasse le solde restant (${reste} F CFA).` };
      }

      let paiementData = { venteId: vente.id, mode, montant: montantNum, viaReglement: true };

      if (mode === "bon_achat" || mode === "avoir") {
        if (!carteNumero) throw { status: 400, message: "Numéro du bon manquant." };
        const bon = await tx.bonValeur.findUnique({ where: { numero: carteNumero } });
        if (!bon) throw { status: 404, message: `Aucun bon ne correspond au numéro ${carteNumero}.` };
        if (bon.enStock) throw { status: 409, message: `La carte ${carteNumero} n'a pas encore été vendue à une cliente.` };
        if (bon.utilisee) throw { status: 409, message: `Le bon ${carteNumero} a déjà été utilisé.` };
        if (bon.dateValidite && new Date(bon.dateValidite) < new Date()) {
          throw { status: 409, message: `Le bon ${carteNumero} a expiré.` };
        }
        if (montantNum > bon.montant) {
          throw { status: 400, message: `Le bon ${carteNumero} vaut ${bon.montant} F, tu ne peux pas appliquer plus que ça.` };
        }
        await tx.bonValeur.update({ where: { id: bon.id }, data: { utilisee: true, utiliseeVenteId: vente.id } });
        paiementData.bonValeurId = bon.id;
      }

      const paiement = await tx.paiement.create({ data: paiementData });
      return {
        paiement,
        venteNumero: vente.numero,
        venteBoutique: vente.boutique,
        clientNom: vente.client?.nomPrenoms || null,
        resteApres: reste - montantNum,
        totalVente: vente.total,
      };
    });
    res.status(201).json(resultat);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Erreur lors de l'enregistrement du règlement." });
  }
});

// GET /api/ventes/recherche/:numero
// Retrouve UNE vente précise par son numéro exact de reçu (ex : REC-001234), quel que soit son
// âge — nécessaire pour un retour/échange qui peut arriver plusieurs jours après la vente,
// contrairement à l'historique général qui reste limité à aujourd'hui pour une caissière.
// Une caissière ne peut retrouver qu'une vente de SA propre boutique, jamais celle de l'autre.
router.get("/recherche/:numero", async (req, res) => {
  const admin = estAdmin(req);
  const vente = await prisma.vente.findUnique({
    where: { numero: req.params.numero.trim() },
    include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, annuleePar: true, cartesCadeauxEmises: true },
  });
  if (!vente) return res.status(404).json({ error: "Aucune vente ne correspond à ce numéro de reçu." });
  if (!admin && vente.boutique !== req.user.boutique) {
    return res.status(403).json({ error: "Cette vente ne concerne pas ta boutique." });
  }
  res.json(vente);
});

router.get("/:id", async (req, res) => {
  const vente = await prisma.vente.findUnique({
    where: { id: req.params.id },
    include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, annuleePar: true, cartesCadeauxEmises: true },
  });
  if (!vente) return res.status(404).json({ error: "Vente introuvable." });
  res.json(vente);
});

router.post("/", async (req, res) => {
  const { boutique, vendeurId, modeVente, clientId, lignes, paiements, typeVente, demandeRemiseId, cartesCadeauxAEmettre } = req.body;
  const caissierId = req.user.id;
  const type = typeVente === "Credit" ? "Credit" : "Comptant";

  if (!boutique || !caissierId || !modeVente) return res.status(400).json({ error: "Boutique et mode de vente sont obligatoires." });
  if (modeVente === "Boutique" && !vendeurId) return res.status(400).json({ error: "Le vendeur est obligatoire pour une vente en boutique." });
  if (type === "Credit" && !clientId) return res.status(400).json({ error: "Un client est obligatoire pour une vente à crédit." });
  try {
    const vente = await prisma.$transaction(async (tx) => {
      // Regrouper les lignes identiques (même article + même pointure) pour vérifier le stock une seule fois
      const cles = {};
      for (const l of lignes) {
        const cle = `${l.articleId}__${l.pointure || ""}`;
        cles[cle] = (cles[cle] || 0) + Number(l.quantite);
      }

      const articlesUtilises = {};
      let total = 0;
      const lignesData = [];

      for (const l of lignes) {
        const article = articlesUtilises[l.articleId] || await tx.article.findUnique({ where: { id: l.articleId }, include: { marque: true } });
        articlesUtilises[l.articleId] = article;
        if (!article) throw { status: 400, message: `Article introuvable (${l.articleId}).` };

        const sousTotal = Number(l.quantite) * article.prixVente;
        total += sousTotal;
        lignesData.push({
          articleId: article.id, designation: article.designation, marque: article.marque.nom,
          famille: article.famille, pointure: l.pointure || "", quantite: Number(l.quantite),
          prixUnitaire: article.prixVente, sousTotal,
        });
      }

      // Vérification + déduction du stock, cumulée par clé article+pointure — on garde une trace
      // de chaque mouvement pour l'historique (créé une fois la vente elle-même enregistrée, plus bas)
      const mouvementsAVenir = [];
      for (const cle of Object.keys(cles)) {
        const [articleId, pointure] = cle.split("__");
        const stockItem = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId, boutique, pointure: pointure || "" } },
        });
        const dispo = stockItem?.quantite || 0;
        if (cles[cle] > dispo) {
          const article = articlesUtilises[articleId];
          throw { status: 409, message: `Stock insuffisant pour ${article?.designation}${pointure ? " T" + pointure : ""} (${dispo} disponible(s)).` };
        }
        await tx.stockItem.update({
          where: { articleId_boutique_pointure: { articleId, boutique, pointure: pointure || "" } },
          data: { quantite: dispo - cles[cle] },
        });
        mouvementsAVenir.push({
          articleId, boutique, pointure: pointure || "",
          quantite: cles[cle], quantiteAvant: dispo, quantiteApres: dispo - cles[cle],
        });
      }

      // Validation de la remise, si une demande est fournie — impossible de la falsifier depuis le frontend :
      // on relit la demande en base et on vérifie sa boutique, qu'elle n'a pas déjà servi, et que le panier
      // n'a pas changé depuis la demande (montant identique à celui soumis à Djenie).
      //
      // La vente n'attend plus l'approbation de Djenie pour se valider (EN_ATTENTE est désormais accepté,
      // seule une remise déjà REFUSEE bloque). Le client paie toujours le montant réduit à la caisse.
      // En revanche, le CA (vente.total) ne reflète la remise que si elle est déjà APPROUVEE : tant qu'elle
      // reste EN_ATTENTE, le CA reste au plein tarif (montantRemise = 0) — l'écart avec l'encaissement réel
      // est volontaire et se résorbe automatiquement dès que Djenie tranche (cf. PATCH /api/remises/:id).
      let montantRemise = 0;       // impact sur le CA — uniquement si déjà approuvée
      let montantRemiseAttendu = 0; // ce que le client paie en moins, que ce soit approuvé ou en attente
      if (demandeRemiseId) {
        const demande = await tx.demandeRemise.findUnique({ where: { id: demandeRemiseId } });
        if (!demande) throw { status: 404, message: "Demande de remise introuvable." };
        if (demande.statut === "REFUSEE") throw { status: 409, message: "Cette remise a été refusée." };
        if (demande.utilisee) throw { status: 409, message: "Cette remise a déjà été utilisée." };
        if (demande.boutique !== boutique) throw { status: 409, message: "Cette remise ne correspond pas à cette boutique." };
        if (demande.totalVente !== total) throw { status: 409, message: "Le panier a changé depuis la demande de remise — refais une nouvelle demande." };
        montantRemiseAttendu = demande.montantRemise;
        if (demande.statut === "APPROUVEE") montantRemise = demande.montantRemise;
      }
      const totalCA = total - montantRemise;           // ce qui compte dans le chiffre d'affaires
      const totalEncaisseAttendu = total - montantRemiseAttendu; // ce que le client doit réellement payer

      // Bonus fidélité "Cendrillon" — indépendant de la remise ci-dessus : une cliente peut très
      // bien utiliser un bonus déjà acquis sur une vente qui a par ailleurs sa propre remise.
      // Ne s'applique que si le panier (après remise) couvre au moins le montant du bonus, sinon
      // il reste intact pour un achat futur (jamais perdu ni fractionné).
      let montantBonusFidelite = 0;
      let clientAvantVente = null;
      if (type === "Comptant" && clientId) {
        clientAvantVente = await tx.client.findUnique({ where: { id: clientId } });
        // Tant que Djenie n'a pas donné le feu vert (FIDELITE_ACTIF), on ne DÉDUIT jamais de
        // bonus — un encaissement réel ne doit jamais bouger silencieusement. Le cumul, lui,
        // continue d'être mis à jour plus bas (voir clientAvantVente), sans effet sur l'argent.
        if (FIDELITE_ACTIF && clientAvantVente) {
          const bonus = await bonusDisponible(clientAvantVente.cumulFideliteCourant, tx);
          if (bonus > 0 && totalCA >= bonus) montantBonusFidelite = bonus;
        }
      }
      const totalCAApresBonus = totalCA - montantBonusFidelite;
      const totalEncaisseApresBonus = totalEncaisseAttendu - montantBonusFidelite;

      // Cartes cadeaux vendues depuis ce panier — chaque carte existe déjà en stock (Djenie l'a
      // réceptionnée avec son numéro imprimé par le fournisseur) ; on la retrouve par son numéro
      // et on la marque vendue, on ne crée jamais de nouvelle carte ici.
      const cartesCadeauxData = [];
      if (Array.isArray(cartesCadeauxAEmettre) && cartesCadeauxAEmettre.length > 0) {
        const numerosVus = new Set();

        for (const c of cartesCadeauxAEmettre) {
          const numero = String(c.numero || "").trim();
          if (!numero) throw { status: 400, message: "Numéro de carte cadeau manquant." };
          if (numerosVus.has(numero)) throw { status: 400, message: `Le numéro de carte ${numero} est utilisé deux fois dans ce panier.` };
          numerosVus.add(numero);

          const carte = await tx.bonValeur.findUnique({ where: { numero } });
          if (!carte || carte.type !== "CADEAU") throw { status: 404, message: `Aucune carte cadeau ne correspond au numéro ${numero}.` };
          if (!carte.enStock) throw { status: 409, message: `La carte ${numero} a déjà été vendue ou n'est plus en stock.` };
          if (carte.boutique !== boutique) throw { status: 409, message: `La carte ${numero} est en stock à ${carte.boutique}, pas ici.` };

          cartesCadeauxData.push({ id: carte.id, numero, montant: carte.montant });
        }
      }
      const totalCartesCadeaux = cartesCadeauxData.reduce((s, c) => s + c.montant, 0);
      const totalCAAvecCartes = totalCAApresBonus + totalCartesCadeaux;
      const totalEncaisseAttenduAvecCartes = totalEncaisseApresBonus + totalCartesCadeaux;

     const totalPaye = paiements.reduce((s, p) => s + Number(p.montant || 0), 0);
      if (type === "Comptant" && totalPaye < totalEncaisseAttenduAvecCartes) {
        throw { status: 400, message: "Le total payé est inférieur au total de la vente." };
      }
      if (type === "Credit" && totalPaye > totalEncaisseAttenduAvecCartes) {
        throw { status: 400, message: "Le montant payé ne peut pas dépasser le total pour une vente à crédit." };
      }
      // Validation + consommation des paiements par bon de valeur (avoir ou carte cadeau)
      const paiementsData = [];
      for (const p of paiements) {
        if (p.mode !== "bon_achat" && p.mode !== "avoir") { paiementsData.push({ mode: p.mode, montant: Number(p.montant) }); continue; }

        if (!p.carteNumero) throw { status: 400, message: "Numéro du bon manquant pour ce paiement." };
        const bon = await tx.bonValeur.findUnique({ where: { numero: p.carteNumero } });
        if (!bon) throw { status: 404, message: `Aucun bon ne correspond au numéro ${p.carteNumero}.` };
        if (bon.enStock) throw { status: 409, message: `La carte ${p.carteNumero} n'a pas encore été vendue à une cliente.` };
        if (bon.utilisee) throw { status: 409, message: `Le bon ${p.carteNumero} a déjà été utilisé.` };
        if (bon.dateValidite && new Date(bon.dateValidite) < new Date()) {
          throw { status: 409, message: `Le bon ${p.carteNumero} a expiré.` };
        }
        if (Number(p.montant) > bon.montant) {
          throw { status: 400, message: `Le bon ${p.carteNumero} vaut ${bon.montant} F, tu ne peux pas appliquer plus que ça.` };
        }
        // Un bon de valeur est à usage unique : il est marqué utilisé intégralement,
        // même si le montant de la vente couvert est inférieur à sa valeur (le reliquat n'est pas reporté).
        await tx.bonValeur.update({ where: { id: bon.id }, data: { utilisee: true, utiliseeVenteId: null } });
        paiementsData.push({ mode: p.mode, montant: Number(p.montant), bonValeurId: bon.id });
      }

      const nbVentes = await tx.vente.count();
      const numero = `REC-${String(nbVentes + 1).padStart(6, "0")}`;

     const venteCreee = await tx.vente.create({
        data: {
          numero, boutique, modeVente, typeVente: type, caissierId, vendeurId: vendeurId || null, clientId: clientId || null,
          total: totalCAAvecCartes, montantRemise, demandeRemiseId: demandeRemiseId || null,
          montantBonusFidelite,
          monnaieRendue: Math.max(0, totalPaye - totalEncaisseAttenduAvecCartes),
          lignes: { create: lignesData },
          paiements: { create: paiementsData },
        },
        include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, demandeRemise: true },
      });

      // Les cartes existaient déjà en stock (Djenie les a réceptionnées) — on les marque
      // vendues, en les rattachant à cette vente. Si un client est renseigné sur la vente, on le
      // rattache aussi à la carte — utile pour la relancer avant l'échéance. C'est ICI, à la
      // vente, que la carte est réellement "activée" : sa validité de 3 mois démarre maintenant,
      // jamais au moment où elle a simplement été réceptionnée en stock.
      if (cartesCadeauxData.length > 0) {
        const dateValiditeActivation = new Date();
        dateValiditeActivation.setMonth(dateValiditeActivation.getMonth() + 3);
        for (const c of cartesCadeauxData) {
          await tx.bonValeur.update({
            where: { id: c.id },
            data: { enStock: false, origineVenteId: venteCreee.id, clientId: clientId || null, dateValidite: dateValiditeActivation },
          });
        }
      }

      // On relie a posteriori les bons de valeur utilisés à la vente qui vient d'être créée
      const bonsUtilises = paiementsData.filter((p) => p.bonValeurId).map((p) => p.bonValeurId);
      if (bonsUtilises.length > 0) {
        await tx.bonValeur.updateMany({ where: { id: { in: bonsUtilises } }, data: { utiliseeVenteId: venteCreee.id } });
      }

      // La demande de remise est marquée utilisée pour empêcher toute réutilisation
      if (demandeRemiseId) {
        await tx.demandeRemise.update({ where: { id: demandeRemiseId }, data: { utilisee: true } });
      }

      // Fidélité Cendrillon : si un bonus a été déduit ci-dessus, on le trace et on remet le
      // cumul courant à zéro. Séparément, si CETTE vente est elle-même éligible (comptant, sans
      // la moindre remise, sans article soldé), elle alimente les deux cumuls — les deux peuvent
      // se produire sur la même vente (utiliser un bonus déjà acquis n'empêche pas d'accumuler
      // pour le suivant, tant que cette vente-ci n'a elle-même aucune remise).
      if (clientAvantVente) {
        const data = {};
        if (montantBonusFidelite > 0) {
          await tx.bonusFideliteUtilise.create({
            data: { clientId: clientAvantVente.id, venteId: venteCreee.id, montant: montantBonusFidelite },
          });
          data.cumulFideliteCourant = 0;
        }
        const eligible = await venteEligibleCumul({
          demandeRemiseId: demandeRemiseId || null,
          articleIds: [...new Set(lignesData.map((l) => l.articleId))],
          tx,
        });
        if (eligible) {
          data.cumulFideliteTotal = clientAvantVente.cumulFideliteTotal + totalCAAvecCartes;
          data.cumulFideliteCourant = (data.cumulFideliteCourant ?? clientAvantVente.cumulFideliteCourant) + totalCAAvecCartes;
        }
        if (Object.keys(data).length > 0) {
          await tx.client.update({ where: { id: clientAvantVente.id }, data });
        }
        if (data.cumulFideliteTotal != null) {
          await detecterChangementStatut(clientAvantVente, data.cumulFideliteTotal, tx);
        }
      }

      // Historique de stock : un mouvement "Vente" par article/pointure déduit
      if (mouvementsAVenir.length > 0) {
        await tx.mouvementStock.createMany({
          data: mouvementsAVenir.map((m) => ({ ...m, type: "Vente", venteId: venteCreee.id, effectueParId: caissierId })),
        });
      }

      return tx.vente.findUnique({
        where: { id: venteCreee.id },
        include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, demandeRemise: true, cartesCadeauxEmises: true },
      });
    });

    res.status(201).json(vente);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Erreur lors de l'enregistrement de la vente.";
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  }
});

// POST /api/ventes/:id/annuler  { motif }
// Annule une vente : remet le stock, libère les bons de valeur et la remise éventuelle,
// marque la vente comme annulée avec motif et auteur pour traçabilité (Djenie voit tout).
router.post("/:id/annuler", async (req, res) => {
  const { motif } = req.body;
  if (!motif || !motif.trim()) {
    return res.status(400).json({ error: "Le motif d'annulation est obligatoire." });
  }

  try {
    const vente = await prisma.$transaction(async (tx) => {
      const venteExistante = await tx.vente.findUnique({
        where: { id: req.params.id },
        include: { lignes: true, paiements: true, retours: true, cartesCadeauxEmises: true },
      });
      if (!venteExistante) throw { status: 404, message: "Vente introuvable." };
      if (!estAdmin(req)) {
        if (venteExistante.boutique !== req.user.boutique) {
          throw { status: 403, message: "Tu ne peux annuler que les ventes de ta propre boutique." };
        }
        if (!estAujourdhui(venteExistante.date)) {
          throw { status: 403, message: "Impossible d'annuler une vente d'un jour précédent — contacte l'administrateur." };
        }
      }
      if (venteExistante.statut === "Annulee") {
        throw { status: 409, message: "Cette vente est déjà annulée." };
      }
      if (venteExistante.retours.length > 0) {
        throw { status: 409, message: "Impossible d'annuler : cette vente a déjà un retour ou échange enregistré." };
      }
      if (venteExistante.paiements.some((p) => p.viaReglement)) {
        throw { status: 409, message: "Impossible d'annuler : des règlements ont déjà été enregistrés sur cette vente à crédit." };
      }
      const carteDejaUtilisee = venteExistante.cartesCadeauxEmises.find((c) => c.utilisee);
      if (carteDejaUtilisee) {
        throw { status: 409, message: `Impossible d'annuler : la carte cadeau ${carteDejaUtilisee.numero} émise par cette vente a déjà été utilisée.` };
      }

      // Réversion du stock, regroupée par article+pointure comme à la création
      const cles = {};
      for (const l of venteExistante.lignes) {
        const cle = `${l.articleId}__${l.pointure || ""}`;
        cles[cle] = (cles[cle] || 0) + l.quantite;
      }

      const mouvementsAVenir = [];
      for (const cle of Object.keys(cles)) {
        const [articleId, pointure] = cle.split("__");
        const stockItem = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId, boutique: venteExistante.boutique, pointure: pointure || "" } },
        });
        const avant = stockItem?.quantite || 0;
        const apres = avant + cles[cle];

        if (stockItem) {
          await tx.stockItem.update({
            where: { articleId_boutique_pointure: { articleId, boutique: venteExistante.boutique, pointure: pointure || "" } },
            data: { quantite: apres },
          });
        } else {
          await tx.stockItem.create({
            data: { articleId, boutique: venteExistante.boutique, pointure: pointure || "", quantite: cles[cle], quantiteInitiale: cles[cle] },
          });
        }

        mouvementsAVenir.push({
          articleId, boutique: venteExistante.boutique, pointure: pointure || "",
          quantite: cles[cle], quantiteAvant: avant, quantiteApres: apres,
        });
      }

      if (mouvementsAVenir.length > 0) {
        await tx.mouvementStock.createMany({
          data: mouvementsAVenir.map((m) => ({ ...m, type: "Annulation", venteId: venteExistante.id, effectueParId: req.user.id })),
        });
      }

      // Libération des bons de valeur utilisés en paiement initial
      const bonsUtilises = venteExistante.paiements.filter((p) => p.bonValeurId).map((p) => p.bonValeurId);
      if (bonsUtilises.length > 0) {
        await tx.bonValeur.updateMany({
          where: { id: { in: bonsUtilises } },
          data: { utilisee: false, utiliseeVenteId: null },
        });
      }

      // Libération de la demande de remise, si applicable
      if (venteExistante.demandeRemiseId) {
        await tx.demandeRemise.update({
          where: { id: venteExistante.demandeRemiseId },
          data: { utilisee: false },
        });
      }

      // Les cartes cadeaux émises par cette vente redeviennent disponibles en stock (aucune
      // n'est utilisée, vérifié plus haut) — elles existaient déjà avant cette vente, on ne les
      // supprime jamais, on les libère juste. La validité repart à zéro (plus de date) puisque
      // la vente qui l'avait "activée" est annulée — elle sera réactivée à sa prochaine vraie vente.
      if (venteExistante.cartesCadeauxEmises.length > 0) {
        await tx.bonValeur.updateMany({
          where: { origineVenteId: venteExistante.id },
          data: { enStock: true, origineVenteId: null, dateValidite: null },
        });
      }

      return tx.vente.update({
        where: { id: venteExistante.id },
        data: {
          statut: "Annulee",
          motifAnnulation: motif.trim(),
          annuleeParId: req.user.id,
          dateAnnulation: new Date(),
        },
        include: { lignes: true, paiements: true, caissier: true, vendeur: true, client: true, annuleePar: true, cartesCadeauxEmises: true },
      });
    });

    res.json(vente);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Erreur lors de l'annulation de la vente.";
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  }
});

module.exports = router;