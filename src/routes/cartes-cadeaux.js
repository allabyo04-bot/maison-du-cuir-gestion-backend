const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

router.get("/", async (req, res) => {
  const cartes = await prisma.carteCadeau.findMany({ orderBy: { createdAt: "desc" } });
  res.json(cartes);
});

// GET /api/cartes-cadeaux/:numero/verifier — utilisé au moment du paiement pour valider une carte avant de l'accepter
router.get("/:numero/verifier", async (req, res) => {
  const carte = await prisma.carteCadeau.findUnique({ where: { numero: req.params.numero } });
  if (!carte) return res.status(404).json({ error: "Aucune carte cadeau ne correspond à ce numéro." });
  if (carte.utilisee) return res.status(409).json({ error: "Cette carte cadeau a déjà été utilisée." });
  if (carte.dateExpiration && new Date(carte.dateExpiration) < new Date()) {
    return res.status(409).json({ error: "Cette carte cadeau est expirée." });
  }
  res.json(carte);
});

// POST /api/cartes-cadeaux — création d'une nouvelle carte vendue en boutique
router.post("/", async (req, res) => {
  const { numero, montant, dateExpiration } = req.body;
  if (!numero?.trim() || !montant) return res.status(400).json({ error: "Numéro et montant sont obligatoires." });

  const existante = await prisma.carteCadeau.findUnique({ where: { numero: numero.trim() } });
  if (existante) return res.status(409).json({ error: "Ce numéro de carte cadeau existe déjà." });

  const carte = await prisma.carteCadeau.create({
    data: { numero: numero.trim(), montant: Number(montant), dateExpiration: dateExpiration ? new Date(dateExpiration) : null },
  });
  res.status(201).json(carte);
});

module.exports = router;
