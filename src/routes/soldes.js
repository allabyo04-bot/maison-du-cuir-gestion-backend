const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("stock"));

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Seul l'administrateur peut gérer les soldes." });
  }
  next();
}

function calculerPrixSolde(type, valeur, prixOriginal) {
  if (type === "POURCENTAGE") {
    return Math.max(0, Math.round(prixOriginal - (prixOriginal * Number(valeur)) / 100));
  }
  return Math.max(0, prixOriginal - Number(valeur));
}

// Restaure les campagnes dont la dateFin est dépassée : remet prixVente à prixOriginal
// pour chaque ligne, et passe la campagne à TERMINEE. Appelé au démarrage du serveur puis
// périodiquement (voir server.js) — pas besoin d'un service Railway séparé.
async function restaurerCampagnesExpirees() {
  const expirees = await prisma.campagneSolde.findMany({
    where: { statut: "ACTIVE", dateFin: { lte: new Date() } },
    include: { lignes: true },
  });
  for (const campagne of expirees) {
    await prisma.$transaction(async (tx) => {
      for (const ligne of campagne.lignes) {
        await tx.article.update({ where: { id: ligne.articleId }, data: { prixVente: ligne.prixOriginal } });
      }
      await tx.campagneSolde.update({ where: { id: campagne.id }, data: { statut: "TERMINEE" } });
    });
  }
  return expirees.length;
}

// GET /api/soldes/articles?marqueId=&famille=  — liste des articles éligibles à une nouvelle
// campagne (actifs), avec indication de ceux déjà engagés dans une campagne active (exclus
// de la sélection côté frontend pour éviter les conflits de restauration).
router.get("/articles", async (req, res) => {
  const { marqueId, famille } = req.query;
  const where = { actif: true };
  if (marqueId) where.marqueId = marqueId;
  if (famille) where.famille = famille;

  const articles = await prisma.article.findMany({
    where,
    include: {
      marque: true,
      lignesCampagneSolde: { where: { campagne: { statut: "ACTIVE" } }, include: { campagne: true } },
    },
    orderBy: [{ marque: { nom: "asc" } }, { designation: "asc" }],
  });

  res.json(articles.map((a) => ({
    id: a.id, reference: a.reference, designation: a.designation, famille: a.famille,
    marque: a.marque.nom, prixVente: a.prixVente,
    dejaEnSolde: a.lignesCampagneSolde.length > 0,
    campagneActive: a.lignesCampagneSolde[0]?.campagne?.nom || a.lignesCampagneSolde[0]?.campagne?.numero || null,
  })));
});

// GET /api/soldes  — liste des campagnes (actives puis terminées), les plus récentes d'abord
router.get("/", async (req, res) => {
  await restaurerCampagnesExpirees();
  const campagnes = await prisma.campagneSolde.findMany({
    include: { creePar: true, lignes: { include: { article: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(campagnes.map((c) => ({
    id: c.id, numero: c.numero, nom: c.nom, type: c.type, valeur: c.valeur,
    dateDebut: c.dateDebut, dateFin: c.dateFin, statut: c.statut, terminaisonAnticipee: c.terminaisonAnticipee,
    creePar: `${c.creePar.prenom} ${c.creePar.nom}`,
    nombreArticles: c.lignes.length,
    lignes: c.lignes.map((l) => ({
      articleId: l.articleId, designation: l.article.designation, reference: l.article.reference,
      prixOriginal: l.prixOriginal, prixSolde: l.prixSolde,
    })),
  })));
});

// POST /api/soldes   { nom?, type, valeur, dateFin, articleIds: [...] }  — réservé à l'administrateur
// Crée la campagne et applique immédiatement le prix soldé à chaque article sélectionné.
router.post("/", requireAdmin, async (req, res) => {
  const { nom, type, valeur, dateFin, articleIds } = req.body;
  if (!type || !valeur || !dateFin || !Array.isArray(articleIds) || articleIds.length === 0) {
    return res.status(400).json({ error: "Type, valeur, date de fin et au moins un article sont obligatoires." });
  }
  if (type !== "MONTANT" && type !== "POURCENTAGE") {
    return res.status(400).json({ error: "Type de remise invalide." });
  }
  if (type === "POURCENTAGE" && Number(valeur) > 100) {
    return res.status(400).json({ error: "Un pourcentage ne peut pas dépasser 100." });
  }
  const finDate = new Date(dateFin);
  if (Number.isNaN(finDate.getTime()) || finDate <= new Date()) {
    return res.status(400).json({ error: "La date de fin doit être dans le futur." });
  }

  try {
    const campagne = await prisma.$transaction(async (tx) => {
      const articles = await tx.article.findMany({ where: { id: { in: articleIds } } });
      if (articles.length !== articleIds.length) throw { status: 404, message: "Un ou plusieurs articles sont introuvables." };

      // Empêche qu'un article déjà engagé dans une campagne active en rejoigne une seconde —
      // sinon la restauration automatique deviendrait ambiguë (quel prix d'origine restaurer ?).
      const dejaEnSolde = await tx.ligneCampagneSolde.findMany({
        where: { articleId: { in: articleIds }, campagne: { statut: "ACTIVE" } },
        include: { article: true },
      });
      if (dejaEnSolde.length > 0) {
        throw { status: 409, message: `Déjà en soldes : ${dejaEnSolde.map((l) => l.article.designation).join(", ")}.` };
      }

      const nb = await tx.campagneSolde.count();
      const numero = `SOLDE-${String(nb + 1).padStart(6, "0")}`;

      const lignesData = articles.map((a) => ({
        articleId: a.id, prixOriginal: a.prixVente, prixSolde: calculerPrixSolde(type, valeur, a.prixVente),
      }));

      const c = await tx.campagneSolde.create({
        data: {
          numero, nom: nom || null, type, valeur: Number(valeur), dateFin: finDate,
          creeParId: req.user.id, lignes: { create: lignesData },
        },
        include: { lignes: true },
      });

      for (const l of c.lignes) {
        await tx.article.update({ where: { id: l.articleId }, data: { prixVente: l.prixSolde } });
      }

      return c;
    });
    res.status(201).json(campagne);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Erreur lors de la création de la campagne." });
  }
});

// POST /api/soldes/:id/terminer  — réservé à l'administrateur : fin anticipée manuelle,
// restaure immédiatement les prix d'origine sans attendre la dateFin.
router.post("/:id/terminer", requireAdmin, async (req, res) => {
  try {
    const campagne = await prisma.campagneSolde.findUnique({
      where: { id: req.params.id }, include: { lignes: true },
    });
    if (!campagne) return res.status(404).json({ error: "Campagne introuvable." });
    if (campagne.statut !== "ACTIVE") return res.status(409).json({ error: "Cette campagne est déjà terminée." });

    await prisma.$transaction(async (tx) => {
      for (const ligne of campagne.lignes) {
        await tx.article.update({ where: { id: ligne.articleId }, data: { prixVente: ligne.prixOriginal } });
      }
      await tx.campagneSolde.update({ where: { id: campagne.id }, data: { statut: "TERMINEE", terminaisonAnticipee: true } });
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Erreur lors de la fin anticipée de la campagne." });
  }
});

module.exports = { router, restaurerCampagnesExpirees };
