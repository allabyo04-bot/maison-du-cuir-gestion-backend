const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prisma = require("../prisma");
const { requireAuth, requirePermission, requireCodeConfirmation } = require("../middleware/auth");

const router = express.Router();

// ------------------------------------------------------------------
// Partie ADMINISTRATION (créer/lister/désactiver des clés) — réservée à l'appli, avec le
// PIN + permission "configuration" habituels. La création exige EN PLUS le code de
// confirmation : donner un accès externe est une action sensible, comme créer un utilisateur.
// ------------------------------------------------------------------
router.get("/cles", requireAuth, requirePermission("configuration"), async (req, res) => {
  const cles = await prisma.cleApiPublique.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, nom: true, actif: true, derniereUtilisation: true, createdAt: true }, // jamais cleHash
  });
  res.json(cles);
});

router.post("/cles", requireAuth, requirePermission("configuration"), requireCodeConfirmation, async (req, res) => {
  const { nom } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: "Un nom (ex : nom de l'agence) est obligatoire." });

  const cleBrute = crypto.randomBytes(24).toString("hex"); // 48 caractères, imprévisible
  const cleHash = await bcrypt.hash(cleBrute, 10);
  const cle = await prisma.cleApiPublique.create({ data: { nom: nom.trim(), cleHash } });

  // La clé brute n'est renvoyée qu'ICI, une seule fois — jamais récupérable ensuite (comme un mot de passe).
  res.status(201).json({ id: cle.id, nom: cle.nom, cle: cleBrute });
});

router.put("/cles/:id", requireAuth, requirePermission("configuration"), async (req, res) => {
  const { actif } = req.body;
  const cle = await prisma.cleApiPublique.update({ where: { id: req.params.id }, data: { actif: !!actif } });
  res.json({ id: cle.id, nom: cle.nom, actif: cle.actif });
});

// ------------------------------------------------------------------
// Partie PUBLIQUE (consultée par le site e-commerce) — pas de PIN, juste la clé d'API en
// en-tête "x-api-key". Lecture seule, catalogue et stock uniquement — rien d'autre n'est
// exposé ici (pas de client, pas de vente, pas d'utilisateur).
// ------------------------------------------------------------------
async function requireApiKey(req, res, next) {
  const cleFournie = req.headers["x-api-key"];
  if (!cleFournie) return res.status(401).json({ error: "Clé d'API manquante (en-tête x-api-key)." });

  const clesActives = await prisma.cleApiPublique.findMany({ where: { actif: true } });
  for (const cle of clesActives) {
    if (await bcrypt.compare(cleFournie, cle.cleHash)) {
      prisma.cleApiPublique.update({ where: { id: cle.id }, data: { derniereUtilisation: new Date() } }).catch(() => {});
      return next();
    }
  }
  return res.status(403).json({ error: "Clé d'API invalide ou désactivée." });
}

// GET /api/api-publique/catalogue — catalogue + stock par boutique/pointure, articles actifs uniquement.
router.get("/catalogue", requireApiKey, async (req, res) => {
  const articles = await prisma.article.findMany({
    where: { actif: true },
    include: { marque: true, stocks: true },
    orderBy: { designation: "asc" },
  });

  res.json(articles.map((a) => ({
    reference: a.reference,
    designation: a.designation,
    famille: a.famille,
    marque: a.marque.nom,
    prixVente: a.prixVente,
    stock: a.stocks.map((s) => ({ boutique: s.boutique, pointure: s.pointure || null, quantite: s.quantite })),
  })));
});

module.exports = router;
