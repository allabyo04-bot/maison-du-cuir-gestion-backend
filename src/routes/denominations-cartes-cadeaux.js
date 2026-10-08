const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { BOUTIQUES } = require("../constants");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Seul l'administrateur peut gérer les cartes cadeaux." });
  }
  next();
}

// GET /api/denominations-cartes-cadeaux?tous=1
// Par défaut, ne renvoie que les montants actifs (utilisé dans le panier de vente).
router.get("/", async (req, res) => {
  const seulementActifs = req.query.tous !== "1";
  const denominations = await prisma.denominationCarteCadeau.findMany({
    where: seulementActifs ? { actif: true } : undefined,
    orderBy: { montant: "asc" },
  });
  res.json(denominations);
});

// POST /api/denominations-cartes-cadeaux   { montant }  — réservé à l'administrateur
router.post("/", requireAdmin, async (req, res) => {
  const montant = Number(req.body.montant);
  if (!montant || montant <= 0) return res.status(400).json({ error: "Montant invalide." });
  try {
    const denomination = await prisma.denominationCarteCadeau.create({ data: { montant } });
    res.status(201).json(denomination);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Ce montant existe déjà." });
    res.status(500).json({ error: "Erreur lors de la création." });
  }
});

// PUT /api/denominations-cartes-cadeaux/:id   { actif }  — réservé à l'administrateur
router.put("/:id", requireAdmin, async (req, res) => {
  const { actif } = req.body;
  const denomination = await prisma.denominationCarteCadeau.update({
    where: { id: req.params.id }, data: { actif: !!actif },
  });
  res.json(denomination);
});

// DELETE /api/denominations-cartes-cadeaux/:id — réservé à l'administrateur
// Supprime un montant créé par erreur ou pour un essai — bloqué si au moins une vraie carte
// (en stock, déjà vendue, ou historique) existe sous ce montant, pour ne jamais rien casser.
router.delete("/:id", requireAdmin, async (req, res) => {
  const denomination = await prisma.denominationCarteCadeau.findUnique({ where: { id: req.params.id } });
  if (!denomination) return res.status(404).json({ error: "Montant introuvable." });
  const nbCartes = await prisma.bonValeur.count({ where: { type: "CADEAU", montant: denomination.montant } });
  if (nbCartes > 0) {
    return res.status(409).json({ error: `${nbCartes} carte(s) existent avec ce montant — impossible de le supprimer. Désactive-le plutôt si tu ne veux plus l'utiliser.` });
  }
  await prisma.denominationCarteCadeau.delete({ where: { id: denomination.id } });
  res.json({ ok: true });
});

// POST /api/denominations-cartes-cadeaux/:id/stocker-numeros   { boutique, numeros }
// Djenie réceptionne un lot de cartes physiques (montant et numéro déjà imprimés par le
// fournisseur) et colle la liste des numéros d'un coup — un numéro par ligne (les virgules et
// espaces multiples sont aussi acceptés). Chaque numéro devient une carte "en stock", prête à
// être vendue — c'est ce même numéro que la caissière retapera au moment de la vente.
router.post("/:id/stocker-numeros", requireAdmin, async (req, res) => {
  const { boutique, numeros } = req.body;
  if (!boutique || !BOUTIQUES.includes(boutique)) {
    return res.status(400).json({ error: "Boutique invalide." });
  }
  const denomination = await prisma.denominationCarteCadeau.findUnique({ where: { id: req.params.id } });
  if (!denomination) return res.status(404).json({ error: "Montant introuvable." });

  const liste = String(numeros || "")
    .split(/[\n,;]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  const uniques = [...new Set(liste)];
  if (uniques.length === 0) return res.status(400).json({ error: "Aucun numéro valide dans la liste collée." });

  const doublonsSaisie = liste.length - uniques.length;
  const dejaExistants = await prisma.bonValeur.findMany({ where: { numero: { in: uniques } }, select: { numero: true } });
  const dejaExistantsSet = new Set(dejaExistants.map((b) => b.numero));
  const aCreer = uniques.filter((n) => !dejaExistantsSet.has(n));

  if (aCreer.length > 0) {
    // Pas de date de validité à ce stade : la carte n'est encore qu'un stock physique, pas
    // encore vendue à une cliente. Le compte à rebours des 3 mois ne démarre qu'à la vente
    // (voir routes/ventes.js) — sinon une carte qui reste un moment en stock perdrait déjà une
    // partie de sa validité avant même d'avoir été achetée.
    await prisma.bonValeur.createMany({
      data: aCreer.map((numero) => ({ numero, type: "CADEAU", montant: denomination.montant, boutique, enStock: true })),
    });
  }

  res.json({
    creees: aCreer.length,
    dejaExistants: dejaExistants.map((b) => b.numero),
    doublonsDansLaListe: doublonsSaisie,
  });
});

// GET /api/denominations-cartes-cadeaux/verifier/:numero?boutique=
// Utilisé par le panier de vente : la caissière tape juste le numéro, on retrouve le montant
// et on vérifie que cette carte est bien en stock dans cette boutique, jamais vendue.
router.get("/verifier/:numero", async (req, res) => {
  const { boutique } = req.query;
  const bon = await prisma.bonValeur.findUnique({ where: { numero: req.params.numero.trim() } });
  if (!bon || bon.type !== "CADEAU") return res.status(404).json({ error: "Aucune carte cadeau ne correspond à ce numéro." });
  if (!bon.enStock) return res.status(409).json({ error: "Cette carte a déjà été vendue ou n'est plus en stock." });
  if (boutique && bon.boutique !== boutique) {
    return res.status(409).json({ error: `Cette carte est en stock à ${bon.boutique}, pas dans cette boutique.` });
  }
  res.json({ montant: bon.montant, boutique: bon.boutique });
});

// GET /api/denominations-cartes-cadeaux/resume  — réservé à l'administrateur
// Pour chaque montant, le détail par boutique : combien en stock (prêtes à vendre) et combien
// déjà vendues (historique). Sert au tableau de bord et à l'écran d'administration.
router.get("/resume", requireAdmin, async (req, res) => {
  const denominations = await prisma.denominationCarteCadeau.findMany({ orderBy: { montant: "asc" } });
  const resume = await Promise.all(denominations.map(async (d) => {
    const cartes = await prisma.bonValeur.findMany({ where: { type: "CADEAU", montant: d.montant }, select: { boutique: true, enStock: true } });
    const parBoutique = BOUTIQUES.map((b) => ({
      boutique: b,
      enStock: cartes.filter((c) => c.boutique === b && c.enStock).length,
      vendues: cartes.filter((c) => c.boutique === b && !c.enStock).length,
    }));
    return { id: d.id, montant: d.montant, actif: d.actif, parBoutique };
  }));
  res.json(resume);
});

module.exports = router;
