const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

// GET /api/ventes-attente?boutique=Angré — liste des tickets en attente pour une boutique
router.get("/", async (req, res) => {
  const { boutique } = req.query;
  const attentes = await prisma.venteAttente.findMany({
    where: { boutique: boutique || undefined },
    orderBy: { createdAt: "asc" },
  });
  res.json(attentes);
});

// POST /api/ventes-attente — met de côté une vente en cours (panier + paiements déjà saisis)
router.post("/", async (req, res) => {
  const { boutique, label, clientId, vendeurId, modeVente, panier, paiements, cartesCadeaux } = req.body;
  if (!boutique || !vendeurId || !panier?.length) {
    return res.status(400).json({ error: "Boutique, vendeur et un panier non vide sont nécessaires pour mettre une vente en attente." });
  }
  const attente = await prisma.venteAttente.create({
    data: {
      boutique, vendeurId, clientId: clientId || null, modeVente,
      label: label?.trim() || `Ticket ${new Date().toLocaleTimeString("fr-FR")}`,
      panier, paiements: paiements || [], cartesCadeaux: cartesCadeaux || [],
    },
  });
  res.status(201).json(attente);
});

// DELETE /api/ventes-attente/:id — à appeler une fois le ticket repris (et finalisé ou annulé)
router.delete("/:id", async (req, res) => {
  await prisma.venteAttente.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
