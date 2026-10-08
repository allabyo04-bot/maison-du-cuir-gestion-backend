const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { consignerAudit } = require("../journalAudit");

const router = express.Router();

// POST /api/auth/login  { login, pin }
router.post("/login", async (req, res) => {
  const { login, pin } = req.body;
  if (!login || !pin) return res.status(400).json({ error: "Identifiant et code PIN requis." });

  const user = await prisma.user.findUnique({ where: { login }, include: { role: true } });
  if (!user || !user.actif) return res.status(401).json({ error: "Identifiant ou PIN incorrect." });

  const pinValide = await bcrypt.compare(pin, user.pinHash);
  if (!pinValide) return res.status(401).json({ error: "Identifiant ou PIN incorrect." });

  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "12h" });
  await consignerAudit({
    action: "CONNEXION", cible: `${user.prenom} ${user.nom} (${user.login})`,
    utilisateurId: user.id, boutique: user.boutique,
  });
  res.json({
    token,
    user: {
      id: user.id, nom: user.nom, prenom: user.prenom, boutique: user.boutique,
      role: { id: user.role.id, nom: user.role.nom, permissions: user.role.permissions, systeme: user.role.systeme },
    },
  });
});

// GET /api/auth/me — pratique pour vérifier la session au chargement de l'appli
router.get("/me", requireAuth, (req, res) => {
  const { id, nom, prenom, boutique, role } = req.user;
  res.json({ id, nom, prenom, boutique, role: { id: role.id, nom: role.nom, permissions: role.permissions, systeme: role.systeme } });
});

// GET /api/auth/question-secrete/:login — première étape du "PIN oublié"
router.get("/question-secrete/:login", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { login: req.params.login } });
  if (!user || !user.actif || !user.questionSecrete) {
    return res.status(404).json({ error: "Aucune question secrète configurée pour cet identifiant. Contacte l'administrateur." });
  }
  res.json({ questionSecrete: user.questionSecrete });
});

// POST /api/auth/reinitialiser-pin  { login, reponseSecrete, nouveauPin } — deuxième étape
router.post("/reinitialiser-pin", async (req, res) => {
  const { login, reponseSecrete, nouveauPin } = req.body;
  if (!login || !reponseSecrete || !/^\d{4,6}$/.test(nouveauPin || "")) {
    return res.status(400).json({ error: "Identifiant, réponse secrète et nouveau PIN (4 à 6 chiffres) sont obligatoires." });
  }
  const user = await prisma.user.findUnique({ where: { login } });
  if (!user || !user.actif || !user.reponseSecreteHash) {
    return res.status(404).json({ error: "Aucune question secrète configurée pour cet identifiant. Contacte l'administrateur." });
  }
  const reponseValide = await bcrypt.compare(reponseSecrete.trim().toLowerCase(), user.reponseSecreteHash);
  if (!reponseValide) return res.status(401).json({ error: "Réponse incorrecte." });

  const pinHash = await bcrypt.hash(nouveauPin, 10);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash } });
  await consignerAudit({
    action: "PIN_MODIFIE", cible: `${user.prenom} ${user.nom} (${user.login})`,
    detail: "Réinitialisé via la question secrète", utilisateurId: user.id, boutique: user.boutique,
  });
  res.json({ ok: true });
});
module.exports = router;
