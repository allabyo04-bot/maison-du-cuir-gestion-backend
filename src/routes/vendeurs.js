const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

// GET /api/vendeurs?boutique=  — liste des vendeurs (actifs et inactifs)
router.get("/", async (req, res) => {
  const { boutique } = req.query;
  const vendeurs = await prisma.vendeur.findMany({
    where: { boutique: boutique || undefined },
    orderBy: { nom: "asc" },
  });
  res.json(vendeurs);
});

// POST /api/vendeurs  { nom, boutique }
router.post("/", async (req, res) => {
  const { nom, boutique } = req.body;
  if (!nom || !boutique) return res.status(400).json({ error: "Nom et boutique sont obligatoires." });
  try {
    const vendeur = await prisma.vendeur.create({ data: { nom: nom.trim(), boutique } });
    res.status(201).json(vendeur);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la création du vendeur." });
  }
});

// PATCH /api/vendeurs/:id  { actif }
router.patch("/:id", async (req, res) => {
  const { actif } = req.body;
  try {
    const vendeur = await prisma.vendeur.update({ where: { id: req.params.id }, data: { actif } });
    res.json(vendeur);
  } catch (err) {
    res.status(404).json({ error: "Vendeur introuvable." });
  }
});

module.exports = router;