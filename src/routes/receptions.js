const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("stock"));

// GET /api/receptions?boutique=
router.get("/", async (req, res) => {
  const { boutique } = req.query;
  const receptions = await prisma.reception.findMany({
    where: { boutique: boutique || undefined },
    include: { lignes: { include: { article: true } }, effectuePar: true },
    orderBy: { dateReception: "desc" },
  });
  res.json(receptions);
});

// POST /api/receptions
// body: { fournisseur?, reference?, boutique, notes?, lignes: [{ articleId, pointure?, quantite, prixAchat? }] }
// Chaque ligne augmente le stock de la boutique concernée et met à jour le prix d'achat de
// l'article (dernier prix connu). Un mouvement "Ajout" est tracé pour chaque ligne, comme pour
// tout autre ajout de stock.
router.post("/", async (req, res) => {
  const { fournisseur, reference, boutique, notes, lignes } = req.body;
  const utilisateurId = req.user.id;

  if (!boutique || !Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: "Boutique et au moins une ligne sont obligatoires." });
  }
  for (const l of lignes) {
    if (!l.articleId || !l.quantite || Number(l.quantite) <= 0) {
      return res.status(400).json({ error: "Chaque ligne doit avoir un article et une quantité positive." });
    }
  }

  try {
    const reception = await prisma.$transaction(async (tx) => {
      const rec = await tx.reception.create({
        data: {
          fournisseur: fournisseur?.trim() || null,
          reference: reference?.trim() || null,
          boutique, notes: notes?.trim() || null,
          effectueParId: utilisateurId,
          lignes: {
            create: lignes.map((l) => ({
              articleId: l.articleId, pointure: l.pointure || "",
              quantite: Number(l.quantite), prixAchat: l.prixAchat != null ? Number(l.prixAchat) : null,
            })),
          },
        },
        include: { lignes: true },
      });

      for (const ligne of rec.lignes) {
        if (ligne.prixAchat != null) {
          await tx.article.update({ where: { id: ligne.articleId }, data: { prixAchat: ligne.prixAchat } });
        }

        const stockItem = await tx.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId: ligne.articleId, boutique, pointure: ligne.pointure || "" } },
        });
        const avant = stockItem?.quantite || 0;
        const apres = avant + ligne.quantite;

        // Une réception fournisseur est un vrai arrivage — la référence "stock initial" (pour
        // l'alerte de stock bas en pourcentage) est portée au nouveau total.
        if (stockItem) {
          await tx.stockItem.update({
            where: { articleId_boutique_pointure: { articleId: ligne.articleId, boutique, pointure: ligne.pointure || "" } },
            data: { quantite: apres, quantiteInitiale: apres },
          });
        } else {
          await tx.stockItem.create({
            data: { articleId: ligne.articleId, boutique, pointure: ligne.pointure || "", quantite: apres, quantiteInitiale: apres },
          });
        }

        await tx.mouvementStock.create({
          data: {
            articleId: ligne.articleId, type: "Ajout", boutique, pointure: ligne.pointure || "",
            quantite: ligne.quantite, quantiteAvant: avant, quantiteApres: apres,
            effectueParId: utilisateurId,
          },
        });
      }

      return tx.reception.findUnique({
        where: { id: rec.id },
        include: { lignes: { include: { article: true } }, effectuePar: true },
      });
    });
    res.status(201).json(reception);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l'enregistrement de la réception." });
  }
});

module.exports = router;
