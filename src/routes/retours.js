const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

router.get("/", async (req, res) => {
  const { boutique } = req.query;
  const retours = await prisma.retour.findMany({
    where: { boutique: boutique || undefined },
    include: { ligneVente: true, vente: true, traitePar: true, bonValeurGenere: true, nouvelArticle: true, paiements: true, demandeRemise: true },
    orderBy: { date: "desc" },
  });
  res.json(retours);
});

// POST /api/retours
// body: { venteId, ligneVenteId, type: "Retour"|"Echange", quantite, motif, boutique,
//   -- pour un Retour --
//         montantRembourse?, dateValiditeAvoir?,
//   -- pour un Echange --
//         nouvellePointure? (même article, juste une autre taille),
//         nouvelArticleId? (échange vers un article différent — nouvellePointure sert alors pour CE nouvel article),
//         paiements? (si le nouvel article coûte plus cher : le supplément, jamais remboursé en espèces),
//         dateValiditeAvoir? (si le nouvel article coûte moins cher : avoir généré pour la différence) }
//
// Pour un "Retour" avec montantRembourse, ou un "Echange" vers un article moins cher, un Avoir
// (BonValeur) est généré automatiquement pour le client de la vente d'origine — le client est
// donc obligatoire dans ces deux cas, et la date de validité doit être fournie.
router.post("/", async (req, res) => {
  const {
    venteId, ligneVenteId, type, quantite, nouvellePointure, nouvelArticleId, motif, boutique,
    montantRembourse, dateValiditeAvoir, paiements, demandeRemiseId,
  } = req.body;

  if (!venteId || !ligneVenteId || !type || !quantite || !boutique) {
    return res.status(400).json({ error: "Vente, ligne concernée, type, quantité et boutique sont obligatoires." });
  }
  if (type === "Echange" && !nouvellePointure) {
    return res.status(400).json({ error: "Précise la nouvelle pointure pour un échange." });
  }
  if (type === "Retour" && montantRembourse) {
    if (!dateValiditeAvoir) return res.status(400).json({ error: "La date de validité de l'avoir est obligatoire." });
  }

  try {
    const retour = await prisma.$transaction(async (tx) => {
      const ligne = await tx.ligneVente.findUnique({ where: { id: ligneVenteId } });
      if (!ligne) throw { status: 404, message: "Ligne de vente introuvable." };
      if (Number(quantite) > ligne.quantite) throw { status: 400, message: "La quantité retournée dépasse la quantité vendue sur cette ligne." };

      const venteOrigine = await tx.vente.findUnique({ where: { id: venteId } });

      // Un échange peut se faire vers un article différent (nouvelArticleId) ou juste une autre
      // pointure du même article (nouvelArticleId absent) — dans ce dernier cas, prix identique,
      // donc jamais de différence à gérer, comme c'était déjà le cas avant.
      const estEchangeVersAutreArticle = type === "Echange" && nouvelArticleId && nouvelArticleId !== ligne.articleId;
      let nouvelArticle = null;
      let difference = 0;
      let supplementReel = 0;
      if (estEchangeVersAutreArticle) {
        nouvelArticle = await tx.article.findUnique({ where: { id: nouvelArticleId } });
        if (!nouvelArticle) throw { status: 404, message: "Le nouvel article choisi est introuvable." };
        const ancienneValeur = ligne.prixUnitaire * Number(quantite);
        const nouvelleValeur = nouvelArticle.prixVente * Number(quantite);
        difference = nouvelleValeur - ancienneValeur;
        supplementReel = difference;

        if (difference > 0) {
          // Remise immédiate sur le supplément (ex: Djenie a oublié de baisser un prix) — même
          // principe que pour une vente : la cliente paie moins tout de suite, régularisé après
          // coup par Djenie via le même circuit que les demandes de remise classiques.
          if (demandeRemiseId) {
            const demande = await tx.demandeRemise.findUnique({ where: { id: demandeRemiseId } });
            if (!demande) throw { status: 404, message: "Demande de remise introuvable." };
            if (demande.statut === "REFUSEE") throw { status: 409, message: "Cette remise a été refusée." };
            if (demande.utilisee) throw { status: 409, message: "Cette remise a déjà été utilisée." };
            if (demande.boutique !== boutique) throw { status: 409, message: "Cette remise ne correspond pas à cette boutique." };
            if (demande.totalVente !== difference) throw { status: 409, message: "Le supplément a changé depuis la demande de remise — refais une nouvelle demande." };
            supplementReel = difference - demande.montantRemise;
          }
          const totalPaye = (paiements || []).reduce((s, p) => s + Number(p.montant || 0), 0);
          if (totalPaye !== supplementReel) {
            throw { status: 400, message: `Le supplément dû est de ${supplementReel} F — le paiement doit couvrir exactement ce montant.` };
          }
        } else if (difference < 0) {
          if (!venteOrigine?.clientId) throw { status: 400, message: "Un client doit être associé à la vente pour générer un avoir." };
          if (!dateValiditeAvoir) throw { status: 400, message: "La date de validité de l'avoir est obligatoire." };
        }
      }

      // La marchandise vendue revient en stock, à son ancienne pointure, dans la boutique où le retour est traité
      const stockAvantRetour = await tx.stockItem.findUnique({
        where: { articleId_boutique_pointure: { articleId: ligne.articleId, boutique, pointure: ligne.pointure } },
      });
      const dispoAvantRetour = stockAvantRetour?.quantite || 0;
      await tx.stockItem.upsert({
        where: { articleId_boutique_pointure: { articleId: ligne.articleId, boutique, pointure: ligne.pointure } },
        update: { quantite: { increment: Number(quantite) } },
        create: { articleId: ligne.articleId, boutique, pointure: ligne.pointure, quantite: Number(quantite), quantiteInitiale: Number(quantite) },
      });

      const mouvementsAVenir = [{
        articleId: ligne.articleId, boutique, pointure: ligne.pointure,
        quantite: Number(quantite), quantiteAvant: dispoAvantRetour, quantiteApres: dispoAvantRetour + Number(quantite),
      }];

      if (type === "Echange") {
        const articleSortant = estEchangeVersAutreArticle ? nouvelArticleId : ligne.articleId;
        const stockNouvelle = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId: articleSortant, boutique, pointure: nouvellePointure } },
        });
        const dispo = stockNouvelle?.quantite || 0;
        if (dispo < Number(quantite)) {
          throw { status: 409, message: `Stock insuffisant en T${nouvellePointure} pour l'échange (${dispo} disponible(s)).` };
        }
        await tx.stockItem.update({
          where: { articleId_boutique_pointure: { articleId: articleSortant, boutique, pointure: nouvellePointure } },
          data: { quantite: { decrement: Number(quantite) } },
        });
        mouvementsAVenir.push({
          articleId: articleSortant, boutique, pointure: nouvellePointure,
          quantite: Number(quantite), quantiteAvant: dispo, quantiteApres: dispo - Number(quantite),
        });
      }

      const retourCree = await tx.retour.create({
        data: {
          venteId, ligneVenteId, type, quantite: Number(quantite),
          nouvellePointure: type === "Echange" ? nouvellePointure : null,
          nouvelArticleId: estEchangeVersAutreArticle ? nouvelArticleId : null,
          supplementPaye: estEchangeVersAutreArticle && difference > 0 ? supplementReel : null,
          demandeRemiseId: estEchangeVersAutreArticle && difference > 0 && demandeRemiseId ? demandeRemiseId : null,
          motif, boutique, traiteParId: req.user.id,
          montantRembourse: type === "Retour" && montantRembourse ? Number(montantRembourse) : null,
        },
        include: { ligneVente: true, traitePar: true },
      });

      if (estEchangeVersAutreArticle && difference > 0) {
        if (demandeRemiseId) {
          await tx.demandeRemise.update({ where: { id: demandeRemiseId }, data: { utilisee: true } });
        }
        await tx.paiement.createMany({
          data: (paiements || []).map((p) => ({ retourId: retourCree.id, mode: p.mode, montant: Number(p.montant) })),
        });
      }

      const montantAvoir = type === "Retour" && montantRembourse
        ? Number(montantRembourse)
        : (estEchangeVersAutreArticle && difference < 0 ? -difference : null);
      if (montantAvoir) {
        const nb = await tx.bonValeur.count({ where: { type: "AVOIR" } });
        const numeroAvoir = `AV-${String(nb + 1).padStart(4, "0")}`;
        await tx.bonValeur.create({
          data: {
            numero: numeroAvoir, type: "AVOIR", montant: montantAvoir,
            dateValidite: new Date(dateValiditeAvoir),
            clientId: venteOrigine.clientId,
            retourOrigineId: retourCree.id,
          },
        });
      }

      await tx.mouvementStock.createMany({
        data: mouvementsAVenir.map((m) => ({ ...m, type, retourId: retourCree.id, effectueParId: req.user.id })),
      });

      return tx.retour.findUnique({
        where: { id: retourCree.id },
        include: { ligneVente: true, traitePar: true, bonValeurGenere: true, nouvelArticle: true, paiements: true, demandeRemise: true },
      });
    });

    res.status(201).json(retour);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Erreur lors de l'enregistrement du retour." });
  }
});

module.exports = router;
