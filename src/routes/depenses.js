const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { consignerAudit } = require("../journalAudit");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Réservé à l'administrateur." });
  }
  next();
}

function estAdmin(req) {
  return !!req.user?.role?.systeme;
}

function estAujourdhui(date) {
  const d = new Date(date);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// --- Catégories de dépense ---------------------------------------------

// GET /api/depenses/categories — visible à tous (pour le menu déroulant de saisie),
// mais seules les catégories actives sont montrées aux non-admin.
router.get("/categories", async (req, res) => {
  const categories = await prisma.categorieDepense.findMany({
    where: estAdmin(req) ? undefined : { actif: true },
    orderBy: { nom: "asc" },
  });
  res.json(categories);
});

router.post("/categories", requireAdmin, async (req, res) => {
  const { nom } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: "Le nom de la catégorie est obligatoire." });
  try {
    const categorie = await prisma.categorieDepense.create({ data: { nom: nom.trim() } });
    res.status(201).json(categorie);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Cette catégorie existe déjà." });
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création de la catégorie." });
  }
});

router.put("/categories/:id", requireAdmin, async (req, res) => {
  const { nom, actif } = req.body;
  const categorie = await prisma.categorieDepense.update({
    where: { id: req.params.id },
    data: { nom: nom?.trim() || undefined, actif },
  });
  res.json(categorie);
});

// DELETE /api/depenses/categories/:id — uniquement si aucune dépense ni budget n'y est déjà
// rattaché (sinon la supprimer casserait l'historique) ; sinon utiliser "désactiver" à la place.
router.delete("/categories/:id", requireAdmin, async (req, res) => {
  const [nbDepenses, nbBudgets] = await Promise.all([
    prisma.depense.count({ where: { categorieId: req.params.id } }),
    prisma.budgetAnnuel.count({ where: { categorieId: req.params.id } }),
  ]);
  if (nbDepenses > 0 || nbBudgets > 0) {
    return res.status(409).json({
      error: `Impossible de supprimer : ${nbDepenses} dépense(s) et ${nbBudgets} budget(s) y sont déjà rattachés. Utilise "Désactiver" à la place pour la retirer des choix futurs sans perdre l'historique.`,
    });
  }
  const categorie = await prisma.categorieDepense.findUnique({ where: { id: req.params.id } });
  await prisma.categorieDepense.delete({ where: { id: req.params.id } });
  if (categorie) {
    await consignerAudit({
      action: "SUPPRESSION", cible: `Catégorie de dépense : ${categorie.nom}`,
      utilisateurId: req.user.id, boutique: req.user.boutique,
    });
  }
  res.json({ ok: true });
});

// --- Dépenses ------------------------------------------------------------

// POST /api/depenses — saisie d'une dépense.
// Une non-admin ne peut saisir que pour SA boutique et pour AUJOURD'HUI, quoi qu'elle envoie :
// ces deux champs sont ignorés venant d'elle et forcés côté serveur. Seule Djenie peut choisir
// une autre boutique ou (exceptionnellement) une autre date.
router.post("/", async (req, res) => {
  const { categorieId, montant, description, reference } = req.body;
  const montantNum = parseInt(montant, 10);
  if (!categorieId || !montantNum || montantNum <= 0) {
    return res.status(400).json({ error: "Catégorie et montant (positif) sont obligatoires." });
  }
  const categorie = await prisma.categorieDepense.findUnique({ where: { id: categorieId } });
  if (!categorie) return res.status(400).json({ error: "Catégorie introuvable." });

  const admin = estAdmin(req);
  const boutique = admin && req.body.boutique ? req.body.boutique : req.user.boutique;
  const date = admin && req.body.date ? new Date(req.body.date) : new Date();

  const depense = await prisma.depense.create({
    data: {
      date, boutique, categorieId, montant: montantNum,
      description: description?.trim() || null,
      reference: reference?.trim() || null,
      effectueParId: req.user.id,
    },
    include: { categorie: true, effectuePar: true },
  });
  res.status(201).json(depense);
});

// GET /api/depenses — Djenie voit tout (filtrable par boutique/catégorie/période) ;
// toute autre personne (Gérant, caissière) ne voit QUE les dépenses du jour même et de SA
// boutique — pas seulement ses propres saisies — même si elle tente de passer des filtres
// différents dans la requête. Même principe que la restriction déjà en place sur États.
router.get("/", async (req, res) => {
  const admin = estAdmin(req);
  if (!admin) {
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const fin = new Date();
    fin.setHours(23, 59, 59, 999);
    const depenses = await prisma.depense.findMany({
      where: { boutique: req.user.boutique, date: { gte: debut, lte: fin } },
      include: { categorie: true, effectuePar: true },
      orderBy: { date: "desc" },
    });
    return res.json(depenses);
  }

  const { boutique, categorieId, dateDebut, dateFin } = req.query;
  const where = {};
  if (boutique) where.boutique = boutique;
  if (categorieId) where.categorieId = categorieId;
  if (dateDebut || dateFin) {
    where.date = {};
    if (dateDebut) where.date.gte = new Date(`${dateDebut}T00:00:00`);
    if (dateFin) { const f = new Date(`${dateFin}T00:00:00`); f.setDate(f.getDate() + 1); where.date.lt = f; }
  }
  const depenses = await prisma.depense.findMany({
    where, include: { categorie: true, effectuePar: true }, orderBy: { date: "desc" },
  });
  res.json(depenses);
});

// --- Budget prévisionnel (Djenie uniquement) -----------------------------

// GET /api/depenses/budget/:annee — pour chaque catégorie active : montant prévisionnel + réalisé de l'année
router.get("/budget/:annee", requireAdmin, async (req, res) => {
  const annee = parseInt(req.params.annee, 10);
  if (!annee) return res.status(400).json({ error: "Année invalide." });
  const { boutique } = req.query; // "Angré" | "Koumassi" | absent = consolidé (les deux)

  const [categories, budgets] = await Promise.all([
    prisma.categorieDepense.findMany({ where: { actif: true }, orderBy: { nom: "asc" } }),
    prisma.budgetAnnuel.findMany({ where: { annee } }),
  ]);

  const debut = new Date(`${annee}-01-01T00:00:00`);
  const fin = new Date(`${annee + 1}-01-01T00:00:00`);

  const resultat = [];
  for (const cat of categories) {
    const budget = budgets.find((b) => b.categorieId === cat.id);
    const realise = await prisma.depense.aggregate({
      where: {
        categorieId: cat.id,
        date: { gte: debut, lt: fin },
        boutique: boutique || undefined,
      },
      _sum: { montant: true },
    });
    resultat.push({
      categorieId: cat.id, categorie: cat.nom,
      montantPrevisionnel: budget?.montantPrevisionnel || 0,
      montantRealise: realise._sum.montant || 0,
    });
  }
  res.json(resultat);
});

// POST /api/depenses/budget — { categorieId, annee, montantPrevisionnel }
router.post("/budget", requireAdmin, async (req, res) => {
  const { categorieId, annee, montantPrevisionnel } = req.body;
  const anneeNum = parseInt(annee, 10);
  const montantNum = parseInt(montantPrevisionnel, 10);
  if (!categorieId || !anneeNum || montantNum == null || montantNum < 0) {
    return res.status(400).json({ error: "Catégorie, année et montant sont obligatoires." });
  }
  const budget = await prisma.budgetAnnuel.upsert({
    where: { categorieId_annee: { categorieId, annee: anneeNum } },
    update: { montantPrevisionnel: montantNum },
    create: { categorieId, annee: anneeNum, montantPrevisionnel: montantNum },
  });
  res.json(budget);
});

module.exports = router;