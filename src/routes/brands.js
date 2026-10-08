const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const brands = await prisma.brand.findMany({ orderBy: { nom: "asc" } });
  res.json(brands);
});

router.post("/", requirePermission("stock"), async (req, res) => {
  const nom = (req.body.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "Le nom de la marque est obligatoire." });
  const existante = await prisma.brand.findUnique({ where: { nom } });
  if (existante) return res.status(409).json({ error: "Cette marque existe déjà." });
  const brand = await prisma.brand.create({ data: { nom } });
  res.status(201).json(brand);
});

router.delete("/:id", requirePermission("stock"), async (req, res) => {
  const articlesConcernes = await prisma.article.count({ where: { marqueId: req.params.id } });
  if (articlesConcernes > 0) return res.status(409).json({ error: "Impossible de supprimer : des articles utilisent encore cette marque." });
  await prisma.brand.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
