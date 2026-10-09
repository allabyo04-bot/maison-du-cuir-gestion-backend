const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("stock"));

// Calcule le solde dû à un fournisseur : somme des réceptions à son nom (quantité × prix d'achat
// de chaque ligne) moins la somme de ses paiements enregistrés. Jamais stocké, toujours recalculé.
async function calculerSolde(fournisseurId) {
  const lignes = await prisma.ligneReception.findMany({
    where: { reception: { fournisseurId } },
    select: { quantite: true, prixAchat: true },
  });
  const totalReceptions = lignes.reduce((s, l) => s + l.quantite * (l.prixAchat || 0), 0);
  const paiements = await prisma.fournisseurPaiement.findMany({
    where: { fournisseurId },
    select: { montant: true },
  });
  const totalPaiements = paiements.reduce((s, p) => s + p.montant, 0);
  return { totalReceptions, totalPaiements, solde: totalReceptions - totalPaiements };
}

// GET /api/fournisseurs — liste avec solde dû de chacun
router.get("/", async (req, res) => {
  const { actif } = req.query;
  const fournisseurs = await prisma.fournisseur.findMany({
    where: actif != null ? { actif: actif === "true" } : undefined,
    orderBy: { nom: "asc" },
  });
  const avecSolde = await Promise.all(
    fournisseurs.map(async (f) => ({ ...f, ...(await calculerSolde(f.id)) }))
  );
  res.json(avecSolde);
});

// GET /api/fournisseurs/:id — fiche complète : solde, articles fournis, réceptions, paiements
router.get("/:id", async (req, res) => {
  const fournisseur = await prisma.fournisseur.findUnique({
    where: { id: req.params.id },
    include: {
      articles: { include: { article: true } },
      receptions: { include: { lignes: { include: { article: true } } }, orderBy: { dateReception: "desc" } },
      paiements: { include: { effectuePar: true, reception: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!fournisseur) return res.status(404).json({ error: "Fournisseur introuvable." });
  const solde = await calculerSolde(fournisseur.id);
  res.json({ ...fournisseur, ...solde });
});

// POST /api/fournisseurs — body: { nom, telephone?, email?, adresse?, notes? }
router.post("/", async (req, res) => {
  const { nom, telephone, email, adresse, notes } = req.body;
  if (!nom?.trim()) return res.status(400).json({ error: "Le nom est obligatoire." });
  try {
    const fournisseur = await prisma.fournisseur.create({
      data: {
        nom: nom.trim(), telephone: telephone?.trim() || null, email: email?.trim() || null,
        adresse: adresse?.trim() || null, notes: notes?.trim() || null,
      },
    });
    res.status(201).json(fournisseur);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Un fournisseur avec ce nom existe déjà." });
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du fournisseur." });
  }
});

// PATCH /api/fournisseurs/:id — body: tout ou partie de { nom, telephone, email, adresse, notes, actif }
router.patch("/:id", async (req, res) => {
  const { nom, telephone, email, adresse, notes, actif } = req.body;
  const data = {};
  if (nom !== undefined) data.nom = nom.trim();
  if (telephone !== undefined) data.telephone = telephone?.trim() || null;
  if (email !== undefined) data.email = email?.trim() || null;
  if (adresse !== undefined) data.adresse = adresse?.trim() || null;
  if (notes !== undefined) data.notes = notes?.trim() || null;
  if (actif !== undefined) data.actif = !!actif;
  try {
    const fournisseur = await prisma.fournisseur.update({ where: { id: req.params.id }, data });
    res.json(fournisseur);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Un fournisseur avec ce nom existe déjà." });
    res.status(404).json({ error: "Fournisseur introuvable." });
  }
});

// POST /api/fournisseurs/:id/articles — body: { articleId } — associer un article à ce fournisseur
router.post("/:id/articles", async (req, res) => {
  const { articleId } = req.body;
  if (!articleId) return res.status(400).json({ error: "articleId est obligatoire." });
  try {
    const lien = await prisma.fournisseurArticle.create({
      data: { fournisseurId: req.params.id, articleId },
      include: { article: true },
    });
    res.status(201).json(lien);
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ error: "Cet article est déjà associé à ce fournisseur." });
    res.status(500).json({ error: "Erreur lors de l'association." });
  }
});

// DELETE /api/fournisseurs/:id/articles/:articleId
router.delete("/:id/articles/:articleId", async (req, res) => {
  await prisma.fournisseurArticle.deleteMany({
    where: { fournisseurId: req.params.id, articleId: req.params.articleId },
  });
  res.json({ ok: true });
});

// POST /api/fournisseurs/:id/paiements — body: { montant, mode, reference?, receptionId?, note? }
// Enregistre un paiement fait à ce fournisseur, réduisant son solde dû.
router.post("/:id/paiements", async (req, res) => {
  const { montant, mode, reference, receptionId, note } = req.body;
  if (!montant || Number(montant) <= 0) return res.status(400).json({ error: "Montant invalide." });
  if (!mode) return res.status(400).json({ error: "Mode de paiement obligatoire." });

  const fournisseur = await prisma.fournisseur.findUnique({ where: { id: req.params.id } });
  if (!fournisseur) return res.status(404).json({ error: "Fournisseur introuvable." });

  const paiement = await prisma.fournisseurPaiement.create({
    data: {
      fournisseurId: req.params.id, montant: Number(montant), mode,
      reference: reference?.trim() || null, receptionId: receptionId || null,
      note: note?.trim() || null, effectueParId: req.user.id,
    },
    include: { effectuePar: true, reception: true },
  });
  res.status(201).json(paiement);
});

module.exports = router;
