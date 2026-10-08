const express = require("express");
const bcrypt = require("bcryptjs");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("utilisateurs"));

// POST /api/securite/changer-code   { codeActuel, nouveauCode }
// Change le code de confirmation exigé pour les actions sensibles (utilisateurs, rôles).
// Exige l'ancien code — pas juste la permission "utilisateurs" — pour qu'une personne qui a
// seulement le PIN (sans connaître le code) ne puisse pas le changer à son propre profit.
router.post("/changer-code", async (req, res) => {
  const { codeActuel, nouveauCode } = req.body;
  if (!nouveauCode || nouveauCode.length < 6) {
    return res.status(400).json({ error: "Le nouveau code doit contenir au moins 6 caractères." });
  }
  const parametre = await prisma.parametreSecurite.findFirst();
  if (!parametre) {
    return res.status(500).json({ error: "Code de confirmation non configuré. Contacte le développeur." });
  }
  const valide = await bcrypt.compare(codeActuel || "", parametre.codeConfirmationHash);
  if (!valide) return res.status(403).json({ error: "Code actuel incorrect." });

  const codeConfirmationHash = await bcrypt.hash(nouveauCode, 10);
  await prisma.parametreSecurite.update({ where: { id: parametre.id }, data: { codeConfirmationHash } });
  res.json({ ok: true });
});

module.exports = router;
