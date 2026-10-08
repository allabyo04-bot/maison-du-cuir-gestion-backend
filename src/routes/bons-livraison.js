const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requireAnyPermission } = require("../middleware/auth");

const router = express.Router();
// Accessible à qui a la permission "ventes" (comme avant, pour les rôles existants Vendeuse/
// Gérant/Administrateur) OU juste "livraison" (nouveau rôle Livreur, sans accès au reste de Ventes).
router.use(requireAuth, requireAnyPermission("ventes", "livraison"));

// GET /api/bons-livraison?statut=EN_COURS&boutique=
// GET /api/bons-livraison?statut=EN_COURS&boutique=
// Djenie voit toutes les boutiques (filtrable) ; une caissière ne voit QUE les bons de sa
// propre boutique, même si elle tente de passer un autre filtre — même principe déjà en place
// sur Ventes et Dépenses.
router.get("/", async (req, res) => {
  const { statut, boutique, dateDebut, dateFin } = req.query;
  const estAdmin = !!req.user?.role?.systeme;
  const boutiqueFiltre = estAdmin ? (boutique || undefined) : req.user.boutique;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  const bons = await prisma.bonLivraison.findMany({
    where: { statut: statut || undefined, boutique: boutiqueFiltre, dateCreation: plage },
    include: {
      lignes: { include: { article: true } },
      cartesLignes: { include: { bonValeur: true } },
      creePar: true, cloturePar: true, client: true,
      venteGeneree: { select: { numero: true, total: true } },
    },
    orderBy: { dateCreation: "desc" },
  });
  res.json(bons);
});

// GET /api/bons-livraison/:id
router.get("/:id", async (req, res) => {
  const bon = await prisma.bonLivraison.findUnique({
    where: { id: req.params.id },
    include: {
      lignes: { include: { article: true } },
      cartesLignes: { include: { bonValeur: true } },
      creePar: true, cloturePar: true, client: true,
      venteGeneree: true,
    },
  });
  if (!bon) return res.status(404).json({ error: "Bon de livraison introuvable." });
  const estAdmin = !!req.user?.role?.systeme;
  if (!estAdmin && bon.boutique !== req.user.boutique) {
    return res.status(403).json({ error: "Ce bon de livraison ne concerne pas ta boutique." });
  }
  res.json(bon);
});

// POST /api/bons-livraison   { boutique, clientNom, clientTelephone, clientId?, livreurNom?, notes?,
//                              lignes: [{ articleId, pointure?, quantite }] }
// Décrémente le stock IMMÉDIATEMENT — c'est le départ du livreur qui est enregistré ici, pas la vente.
router.post("/", async (req, res) => {
  const { boutique, clientNom, clientTelephone, clientId, lieuLivraison, livreurNom, notes, lignes, cartesCadeaux, avance, avanceModePaiement } = req.body;
  const utilisateurId = req.user.id;
  const avanceNum = Number(avance) || 0;
  const lignesArr = Array.isArray(lignes) ? lignes : [];
  const cartesArr = Array.isArray(cartesCadeaux) ? cartesCadeaux : [];

  if (!boutique || !clientTelephone?.trim() || (lignesArr.length === 0 && cartesArr.length === 0)) {
    return res.status(400).json({ error: "Boutique, numéro de téléphone de la cliente et au moins un article ou une carte cadeau sont obligatoires." });
  }
  if (!livreurNom?.trim()) {
    return res.status(400).json({ error: "Le nom du livreur est obligatoire." });
  }
  if (avanceNum < 0) {
    return res.status(400).json({ error: "L'avance ne peut pas être négative." });
  }
  if (avanceNum > 0 && !avanceModePaiement) {
    return res.status(400).json({ error: "Choisis le mode de paiement de l'avance." });
  }
  for (const l of lignesArr) {
    if (!l.articleId || !l.quantite || Number(l.quantite) <= 0) {
      return res.status(400).json({ error: "Chaque ligne doit avoir un article et une quantité positive." });
    }
  }

  try {
    const bon = await prisma.$transaction(async (tx) => {
      const articles = await tx.article.findMany({ where: { id: { in: lignesArr.map((l) => l.articleId) } } });
      const parId = Object.fromEntries(articles.map((a) => [a.id, a]));

      const lignesData = [];
      for (const l of lignesArr) {
        const article = parId[l.articleId];
        if (!article) throw { status: 404, message: "Un article de la liste est introuvable." };
        const pointure = l.pointure || "";
        const quantite = Number(l.quantite);

        const stockItem = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId: l.articleId, boutique, pointure } },
        });
        const avant = stockItem?.quantite || 0;
        if (avant < quantite) {
          throw { status: 409, message: `Stock insuffisant pour ${article.designation}${pointure ? ` (T${pointure})` : ""} : ${avant} disponible(s), ${quantite} demandé(s).` };
        }
        lignesData.push({ articleId: l.articleId, pointure, quantite, prixUnitaire: article.prixVente, avant });
      }

      // Cartes cadeaux réservées pour cette livraison — même principe qu'un article : la carte
      // passe indisponible (enStock:false) dès le départ, comme si elle venait d'être vendue,
      // pour qu'aucune caissière ne puisse la vendre en boutique pendant ce temps.
      const cartesData = [];
      for (const c of cartesArr) {
        const numero = String(c.numero || "").trim();
        if (!numero) throw { status: 400, message: "Numéro de carte cadeau manquant." };
        const carte = await tx.bonValeur.findUnique({ where: { numero } });
        if (!carte || carte.type !== "CADEAU") throw { status: 404, message: `Aucune carte cadeau ne correspond au numéro ${numero}.` };
        if (!carte.enStock) throw { status: 409, message: `La carte ${numero} n'est pas disponible (déjà vendue, réservée ou pas encore en stock).` };
        if (carte.boutique !== boutique) throw { status: 409, message: `La carte ${numero} est en stock à ${carte.boutique}, pas ici.` };
        cartesData.push(carte);
      }

      const nb = await tx.bonLivraison.count();
      const numero = `BL-${String(nb + 1).padStart(6, "0")}`;

      const bonCree = await tx.bonLivraison.create({
        data: {
          numero, boutique, clientNom: clientNom?.trim() || "Cliente", clientTelephone: clientTelephone || null,
          clientId: clientId || null, lieuLivraison: lieuLivraison?.trim() || null, livreurNom: livreurNom || null, notes: notes || null,
          avance: avanceNum, avanceModePaiement: avanceNum > 0 ? avanceModePaiement : null,
          creeParId: utilisateurId,
          lignes: { create: lignesData.map(({ articleId, pointure, quantite, prixUnitaire }) => ({ articleId, pointure, quantite, prixUnitaire })) },
          cartesLignes: { create: cartesData.map((c) => ({ bonValeurId: c.id })) },
        },
        include: { lignes: { include: { article: true } }, cartesLignes: { include: { bonValeur: true } } },
      });

      for (const l of lignesData) {
        const apres = l.avant - l.quantite;
        await tx.stockItem.update({
          where: { articleId_boutique_pointure: { articleId: l.articleId, boutique, pointure: l.pointure } },
          data: { quantite: apres },
        });
        await tx.mouvementStock.create({
          data: {
            articleId: l.articleId, type: "SortieLivraison", boutique, pointure: l.pointure,
            quantite: l.quantite, quantiteAvant: l.avant, quantiteApres: apres,
            bonLivraisonId: bonCree.id, effectueParId: utilisateurId,
          },
        });
      }

      for (const c of cartesData) {
        await tx.bonValeur.update({ where: { id: c.id }, data: { enStock: false } });
      }

      // L'avance est un vrai encaissement du jour du départ — on l'enregistre tout de suite
      // comme un paiement à part (pas encore rattaché à une vente, qui n'existe pas tant que le
      // bon n'est pas clôturé), avec sa vraie date. La fermeture de caisse et le récap par mode
      // de paiement du jour du départ la compteront ainsi correctement, même si la clôture (et
      // la vente qu'elle génère) a lieu plusieurs jours plus tard.
      if (avanceNum > 0) {
        await tx.paiement.create({
          data: { bonLivraisonId: bonCree.id, mode: avanceModePaiement, montant: avanceNum, viaAvanceLivraison: true },
        });
      }

      return bonCree;
    });
    res.status(201).json(bon);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erreur lors de la création du bon de livraison." });
  }
});

// POST /api/bons-livraison/:id/cloturer
// body: { clientId?, typeVente, paiements, lignes: [{ ligneId, statut: "VENDU"|"RETOURNE"|"PERDU" }] }
// Réconciliation au retour du livreur, article par article :
//  - VENDU    → entre dans une vraie vente (encaissement, reçu), au prix figé au départ
//  - RETOURNE → remis en stock immédiatement
//  - PERDU    → reste hors stock (perte/casse), tracé mais jamais réintégré automatiquement
router.post("/:id/cloturer", async (req, res) => {
  const { clientId, typeVente, paiements, lignes, cartes } = req.body;
  const utilisateurId = req.user.id;
  const type = typeVente === "Credit" ? "Credit" : "Comptant";
  const lignesArr = Array.isArray(lignes) ? lignes : [];
  const cartesArr = Array.isArray(cartes) ? cartes : [];

  if (lignesArr.length === 0 && cartesArr.length === 0) {
    return res.status(400).json({ error: "Le détail de la réconciliation (ligne par ligne) est obligatoire." });
  }

  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const bon = await tx.bonLivraison.findUnique({
        where: { id: req.params.id },
        include: { lignes: { include: { article: true } }, cartesLignes: { include: { bonValeur: true } } },
      });
      if (!bon) throw { status: 404, message: "Bon de livraison introuvable." };
      if (!req.user.role?.systeme && bon.boutique !== req.user.boutique) {
        throw { status: 403, message: "Ce bon de livraison ne concerne pas ta boutique." };
      }
      if (bon.statut !== "EN_COURS") throw { status: 409, message: "Ce bon de livraison a déjà été clôturé." };

      const parLigneId = Object.fromEntries(bon.lignes.map((l) => [l.id, l]));
      if (lignesArr.length !== bon.lignes.length || !lignesArr.every((l) => parLigneId[l.ligneId])) {
        throw { status: 400, message: "Le détail de réconciliation ne correspond pas exactement aux lignes du bon." };
      }
      const parLigneCarteId = Object.fromEntries(bon.cartesLignes.map((l) => [l.id, l]));
      if (cartesArr.length !== bon.cartesLignes.length || !cartesArr.every((c) => parLigneCarteId[c.ligneCarteId])) {
        throw { status: 400, message: "Le détail de réconciliation des cartes cadeaux ne correspond pas exactement aux cartes du bon." };
      }

      const lignesVendues = [];
      for (const l of lignesArr) {
        const ligneBon = parLigneId[l.ligneId];
        if (!["VENDU", "RETOURNE", "PERDU"].includes(l.statut)) {
          throw { status: 400, message: "Statut de ligne invalide (VENDU, RETOURNE ou PERDU attendu)." };
        }
        await tx.ligneBonLivraison.update({ where: { id: l.ligneId }, data: { statut: l.statut } });

        if (l.statut === "RETOURNE") {
          const stockItem = await tx.stockItem.findUnique({
            where: { articleId_boutique_pointure: { articleId: ligneBon.articleId, boutique: bon.boutique, pointure: ligneBon.pointure || "" } },
          });
          const avant = stockItem?.quantite || 0;
          const apres = avant + ligneBon.quantite;
          if (stockItem) {
            await tx.stockItem.update({
              where: { articleId_boutique_pointure: { articleId: ligneBon.articleId, boutique: bon.boutique, pointure: ligneBon.pointure || "" } },
              data: { quantite: apres },
            });
          } else {
            await tx.stockItem.create({ data: { articleId: ligneBon.articleId, boutique: bon.boutique, pointure: ligneBon.pointure || "", quantite: apres, quantiteInitiale: apres } });
          }
          await tx.mouvementStock.create({
            data: {
              articleId: ligneBon.articleId, type: "RetourLivraison", boutique: bon.boutique, pointure: ligneBon.pointure || "",
              quantite: ligneBon.quantite, quantiteAvant: avant, quantiteApres: apres,
              bonLivraisonId: bon.id, effectueParId: utilisateurId,
            },
          });
        } else if (l.statut === "VENDU") {
          lignesVendues.push(ligneBon);
        }
        // PERDU : rien à faire sur le stock — il est déjà décrémenté depuis le départ, ça reste ainsi.
      }

      const cartesVendues = [];
      for (const c of cartesArr) {
        const ligneCarte = parLigneCarteId[c.ligneCarteId];
        if (!["VENDU", "RETOURNE", "PERDUE"].includes(c.statut)) {
          throw { status: 400, message: "Statut de carte invalide (VENDU, RETOURNE ou PERDUE attendu)." };
        }
        await tx.ligneBonLivraisonCarte.update({ where: { id: c.ligneCarteId }, data: { statut: c.statut } });

        if (c.statut === "RETOURNE") {
          await tx.bonValeur.update({ where: { id: ligneCarte.bonValeurId }, data: { enStock: true } });
        } else if (c.statut === "VENDU") {
          cartesVendues.push(ligneCarte.bonValeur);
        }
        // PERDUE : la carte reste hors stock (enStock:false, déjà décrémentée au départ) et ne
        // rentre dans aucune vente — exactement comme un article "PERDU". Djenie statue ensuite
        // manuellement (remplacement, perte sèche...).
      }

      let venteCreee = null;
      let avanceARembourser = 0;
      if (lignesVendues.length > 0 || cartesVendues.length > 0) {
        const totalArticles = lignesVendues.reduce((s, l) => s + l.prixUnitaire * l.quantite, 0);
        const totalCartes = cartesVendues.reduce((s, c) => s + c.montant, 0);
        const total = totalArticles + totalCartes;
        // L'avance perçue au départ compte comme un paiement déjà fait — la caissière n'a plus
        // qu'à encaisser la différence (ou rendre la monnaie si l'avance dépassait le total final).
        // Elle a déjà été enregistrée comme paiement à la création du bon (voir POST /), avec sa
        // vraie date d'encaissement — on ne la recrée surtout pas ici, sinon elle serait comptée
        // deux fois (une fois à sa vraie date, une fois à la date de cette clôture).
        const paiementsSaisis = (paiements || []).map((p) => ({ mode: p.mode, montant: Number(p.montant) }));
        const totalPaye = paiementsSaisis.reduce((s, p) => s + p.montant, 0) + bon.avance;
        if (type === "Comptant" && totalPaye < total) {
          throw { status: 400, message: `Le total payé (avance comprise) est inférieur au total des articles et cartes vendus. Il manque ${total - totalPaye} F.` };
        }
        if (type === "Credit" && totalPaye > total) {
          throw { status: 400, message: "Le montant payé (avance comprise) ne peut pas dépasser le total pour une vente à crédit." };
        }

        const nbVentes = await tx.vente.count();
        const numero = `REC-${String(nbVentes + 1).padStart(6, "0")}`;

        venteCreee = await tx.vente.create({
          data: {
            numero, boutique: bon.boutique, modeVente: "Livraison", typeVente: type,
            caissierId: utilisateurId, clientId: clientId || bon.clientId || null,
            total, bonLivraisonOrigineId: bon.id,
            monnaieRendue: Math.max(0, totalPaye - total),
            lignes: {
              create: lignesVendues.map((l) => ({
                articleId: l.articleId, designation: l.article.designation, marque: l.article.marque?.nom || "",
                famille: l.article.famille, pointure: l.pointure || null,
                quantite: l.quantite, prixUnitaire: l.prixUnitaire, sousTotal: l.prixUnitaire * l.quantite,
              })),
            },
            paiements: { create: paiementsSaisis },
          },
          include: { lignes: true, paiements: true, caissier: true, client: true, cartesCadeauxEmises: true },
        });

        // Rattache le paiement d'avance déjà existant (créé au départ, voir POST /) à la vente
        // qui vient de naître — sans toucher à son createdAt, qui reste sa vraie date d'encaissement.
        if (bon.avance > 0) {
          await tx.paiement.updateMany({
            where: { bonLivraisonId: bon.id, viaAvanceLivraison: true, venteId: null },
            data: { venteId: venteCreee.id },
          });
          // Recharge la vente pour que la réponse (reçu, etc.) inclue bien la ligne d'avance,
          // rattachée juste au-dessus sans passer par le "create" initial.
          venteCreee = await tx.vente.findUnique({
            where: { id: venteCreee.id },
            include: { lignes: true, paiements: true, caissier: true, client: true, cartesCadeauxEmises: true },
          });
        }

        for (const c of cartesVendues) {
          await tx.bonValeur.update({ where: { id: c.id }, data: { origineVenteId: venteCreee.id, clientId: clientId || bon.clientId || null } });
        }

        for (const l of lignesVendues) {
          await tx.mouvementStock.create({
            data: {
              articleId: l.articleId, type: "Vente", boutique: bon.boutique, pointure: l.pointure || "",
              quantite: l.quantite, quantiteAvant: 0, quantiteApres: 0, // déjà décrémenté au départ, ceci ne fait que tracer la vente elle-même
              venteId: venteCreee.id, effectueParId: utilisateurId,
            },
          });
        }
      } else if (bon.avance > 0) {
        // Rien n'a finalement été vendu (tout rendu ou perdu) alors qu'une avance avait été
        // perçue au départ — personne ne peut le deviner automatiquement, il faut la rembourser
        // à la cliente à la main. On le signale clairement dans la réponse.
        avanceARembourser = bon.avance;
      }

      const bonMisAJour = await tx.bonLivraison.update({
        where: { id: bon.id },
        data: { statut: "CLOTURE", clotureParId: utilisateurId, dateCloture: new Date() },
        include: { lignes: { include: { article: true } }, venteGeneree: true },
      });

      return { bon: bonMisAJour, vente: venteCreee, avanceARembourser };
    });
    res.json(resultat);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erreur lors de la clôture du bon de livraison." });
  }
});

// POST /api/bons-livraison/:id/annuler
// Annule un bon AVANT le départ (erreur de saisie, par ex.) — remet tout le stock, sans passer
// par une vente ni un article "perdu". Impossible une fois le bon déjà clôturé.
router.post("/:id/annuler", async (req, res) => {
  const utilisateurId = req.user.id;
  try {
    const avanceARembourser = await prisma.$transaction(async (tx) => {
      const bon = await tx.bonLivraison.findUnique({ where: { id: req.params.id }, include: { lignes: true, cartesLignes: true } });
      if (!bon) throw { status: 404, message: "Bon de livraison introuvable." };
      if (!req.user.role?.systeme && bon.boutique !== req.user.boutique) {
        throw { status: 403, message: "Ce bon de livraison ne concerne pas ta boutique." };
      }
      if (bon.statut !== "EN_COURS") throw { status: 409, message: "Ce bon de livraison n'est plus annulable (déjà clôturé)." };

      for (const l of bon.lignes) {
        const stockItem = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: bon.boutique, pointure: l.pointure || "" } },
        });
        const avant = stockItem?.quantite || 0;
        const apres = avant + l.quantite;
        await tx.stockItem.update({
          where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: bon.boutique, pointure: l.pointure || "" } },
          data: { quantite: apres },
        });
        await tx.mouvementStock.create({
          data: {
            articleId: l.articleId, type: "RetourLivraison", boutique: bon.boutique, pointure: l.pointure || "",
            quantite: l.quantite, quantiteAvant: avant, quantiteApres: apres,
            bonLivraisonId: bon.id, effectueParId: utilisateurId,
          },
        });
      }

      for (const c of bon.cartesLignes) {
        await tx.bonValeur.update({ where: { id: c.bonValeurId }, data: { enStock: true } });
      }

      await tx.bonLivraison.update({ where: { id: bon.id }, data: { statut: "ANNULE" } });
      return bon.avance; // signalé au frontend, pour rappeler qu'un remboursement manuel est dû
    });
    res.json({ ok: true, avanceARembourser });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erreur lors de l'annulation du bon de livraison." });
  }
});

module.exports = router;
