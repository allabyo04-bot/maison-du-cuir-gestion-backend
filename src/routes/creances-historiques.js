const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function avecReste(c) {
  const totalRegle = c.montantDejaPaye + c.reglements.reduce((s, r) => s + r.montant, 0);
  return { ...c, totalRegle, resteAPayer: c.montantTotal - totalRegle };
}

// GET /api/creances-historiques?boutique=
router.get("/", async (req, res) => {
  const { boutique } = req.query;
  const creances = await prisma.creanceHistorique.findMany({
    where: { boutique: boutique || undefined },
    include: { client: true, reglements: { orderBy: { createdAt: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(creances.map(avecReste));
});

// POST /api/creances-historiques — création manuelle d'une créance (admin)
router.post("/", async (req, res) => {
  const { clientId, boutique, montantTotal, montantDejaPaye, note } = req.body;
  if (!clientId || !boutique || !montantTotal) {
    return res.status(400).json({ error: "Client, boutique et montant total sont obligatoires." });
  }
  const creance = await prisma.creanceHistorique.create({
    data: {
      clientId, boutique, montantTotal: Number(montantTotal),
      montantDejaPaye: Number(montantDejaPaye) || 0, note,
    },
    include: { client: true, reglements: true },
  });
  res.status(201).json(avecReste(creance));
});

// POST /api/creances-historiques/:id/reglement — enregistrer un nouveau règlement
router.post("/:id/reglement", async (req, res) => {
  const { montant, mode, boutique } = req.body;
  const montantNum = Number(montant);
  if (!montantNum || montantNum <= 0 || !mode || !boutique) {
    return res.status(400).json({ error: "Montant, mode de paiement et boutique sont obligatoires." });
  }
  try {
    const resultat = await prisma.$transaction(async (tx) => {
      const creance = await tx.creanceHistorique.findUnique({
        where: { id: req.params.id },
        include: { client: true, reglements: true },
      });
      if (!creance) throw { status: 404, message: "Créance introuvable." };

      const totalRegle = creance.montantDejaPaye + creance.reglements.reduce((s, r) => s + r.montant, 0);
      const reste = creance.montantTotal - totalRegle;
      if (montantNum > reste) {
        throw { status: 400, message: `Le montant dépasse le reste à payer (${reste} F CFA).` };
      }

      const reglement = await tx.creanceReglement.create({
        data: { creanceId: creance.id, montant: montantNum, mode, boutique, effectueParId: req.user.id },
      });

      return {
        reglement, clientNom: creance.client.nomPrenoms,
        montantTotal: creance.montantTotal, resteApres: reste - montantNum,
      };
    });
    res.status(201).json(resultat);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Erreur lors de l'enregistrement du règlement." });
  }
});

module.exports = router;