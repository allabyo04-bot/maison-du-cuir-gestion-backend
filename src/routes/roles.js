const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission, requireCodeConfirmation } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

// Tout le monde connecté peut LIRE les rôles (nécessaire pour afficher les listes déroulantes),
// mais seule la permission "utilisateurs" permet de les modifier.
router.get("/", async (req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  res.json(roles);
});

router.post("/", requirePermission("utilisateurs"), requireCodeConfirmation, async (req, res) => {
  const { nom, permissions } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: "Le nom du rôle est obligatoire." });
  const role = await prisma.role.create({ data: { nom: nom.trim(), systeme: false, permissions: permissions || {} } });
  res.status(201).json(role);
});

router.put("/:id", requirePermission("utilisateurs"), requireCodeConfirmation, async (req, res) => {
  const role = await prisma.role.findUnique({ where: { id: req.params.id } });
  if (role.systeme) return res.status(403).json({ error: "Le rôle Administrateur ne peut pas être modifié." });
  const updated = await prisma.role.update({ where: { id: req.params.id }, data: { permissions: req.body.permissions } });
  res.json(updated);
});

router.delete("/:id", requirePermission("utilisateurs"), requireCodeConfirmation, async (req, res) => {
  const role = await prisma.role.findUnique({ where: { id: req.params.id } });
  if (role.systeme) return res.status(403).json({ error: "Le rôle Administrateur ne peut pas être supprimé." });
  const employesConcernes = await prisma.user.count({ where: { roleId: req.params.id } });
  if (employesConcernes > 0) return res.status(409).json({ error: "Impossible de supprimer : des employés sont encore rattachés à ce rôle." });
  await prisma.role.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
