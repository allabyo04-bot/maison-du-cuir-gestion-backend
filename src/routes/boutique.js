const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { consignerAudit } = require("../journalAudit");
const { BOUTIQUES } = require("../constants");

const router = express.Router();

function genererNumeroCommande() {
  return `CMD-${Date.now()}`;
}

function stockTotal(article) {
  return (article.stocks || []).reduce((s, l) => s + l.quantite, 0);
}

// ------------------------------------------------------------
// CATALOGUE — public, aucune authentification requise
// ------------------------------------------------------------

// GET /api/boutique/produits?q=&famille=&marqueId=&tri=&page=
router.get("/produits", async (req, res) => {
  const { q, famille, marqueId, tri } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const parPage = 24;

  const where = { actif: true };
  if (q) where.OR = [
    { designation: { contains: q, mode: "insensitive" } },
    { reference: { contains: q, mode: "insensitive" } },
  ];
  if (famille) where.famille = famille;
  if (marqueId) where.marqueId = marqueId;

  const orderBy =
    tri === "prix-asc" ? { prixVente: "asc" } :
    tri === "prix-desc" ? { prixVente: "desc" } :
    tri === "nom" ? { designation: "asc" } :
    { createdAt: "desc" }; // "nouveaute" par défaut

  const [total, articles] = await Promise.all([
    prisma.article.count({ where }),
    prisma.article.findMany({
      where, orderBy, skip: (page - 1) * parPage, take: parPage,
      include: { marque: true, stocks: true },
    }),
  ]);

  res.json({
    produits: articles.map((a) => ({
      id: a.id, designation: a.designation, reference: a.reference, photoUrl: a.photoUrl,
      famille: a.famille, marque: a.marque.nom, prixVente: a.prixVente,
      enStock: stockTotal(a) > 0,
    })),
    page, totalPages: Math.max(1, Math.ceil(total / parPage)), total,
  });
});

// GET /api/boutique/produits/:id
router.get("/produits/:id", async (req, res) => {
  const article = await prisma.article.findUnique({
    where: { id: req.params.id },
    include: { marque: true, stocks: true, photos: { orderBy: { ordre: "asc" } } },
  });
  if (!article || !article.actif) return res.status(404).json({ error: "Produit introuvable." });
  res.json({
    id: article.id, designation: article.designation, reference: article.reference,
    famille: article.famille, marque: article.marque.nom, prixVente: article.prixVente,
    photos: article.photos, photoUrl: article.photoUrl,
    pointuresDisponibles: article.stocks.filter((s) => s.quantite > 0).map((s) => ({ pointure: s.pointure, boutique: s.boutique, quantite: s.quantite })),
    enStock: stockTotal(article) > 0,
  });
});

// GET /api/boutique/marques — pour les filtres du catalogue
router.get("/marques", async (req, res) => {
  const marques = await prisma.brand.findMany({ orderBy: { nom: "asc" } });
  res.json(marques);
});

// ------------------------------------------------------------
// COMMANDES — en mode invité (pas de compte client avec mot de passe pour l'instant)
// ------------------------------------------------------------

// POST /api/boutique/commandes
// body: { nomClient, telephoneClient, emailClient?, modeLivraison, adresseLivraison?, boutique,
//         notes?, lignes: [{ articleId, pointure?, quantite }] }
router.post("/commandes", async (req, res) => {
  const { nomClient, telephoneClient, emailClient, modeLivraison, adresseLivraison, boutique, notes, lignes } = req.body;

  if (!nomClient?.trim() || !telephoneClient?.trim()) return res.status(400).json({ error: "Nom et téléphone sont obligatoires." });
  if (!["Retrait", "Livraison"].includes(modeLivraison)) return res.status(400).json({ error: "Mode de livraison invalide." });
  if (modeLivraison === "Livraison" && !adresseLivraison?.trim()) return res.status(400).json({ error: "Adresse de livraison obligatoire pour ce mode." });
  if (!boutique || !BOUTIQUES.includes(boutique)) return res.status(400).json({ error: "Boutique invalide." });
  if (!Array.isArray(lignes) || lignes.length === 0) return res.status(400).json({ error: "Le panier est vide." });

  const articleIds = [...new Set(lignes.map((l) => l.articleId))];
  const articles = await prisma.article.findMany({ where: { id: { in: articleIds }, actif: true } });
  const parId = Object.fromEntries(articles.map((a) => [a.id, a]));

  const lignesData = [];
  let total = 0;
  for (const l of lignes) {
    const article = parId[l.articleId];
    if (!article) return res.status(400).json({ error: "Un article du panier n'existe plus." });
    const quantite = Number(l.quantite);
    if (!quantite || quantite <= 0) return res.status(400).json({ error: `Quantité invalide pour ${article.designation}.` });
    const sousTotal = article.prixVente * quantite;
    total += sousTotal;
    lignesData.push({
      articleId: article.id, designation: article.designation, pointure: l.pointure || null,
      prixUnitaire: article.prixVente, quantite, sousTotal,
    });
  }

  const commande = await prisma.commandeEnLigne.create({
    data: {
      numero: genererNumeroCommande(), nomClient: nomClient.trim(), telephoneClient: telephoneClient.trim(),
      emailClient: emailClient?.trim() || null, modeLivraison, adresseLivraison: adresseLivraison?.trim() || null,
      boutique, notes: notes?.trim() || null, total, lignes: { create: lignesData },
    },
    include: { lignes: true },
  });

  res.status(201).json(commande);
});

// GET /api/boutique/commandes/:numero — pour que la cliente suive sa commande (lien envoyé après coup)
router.get("/commandes/:numero", async (req, res) => {
  const commande = await prisma.commandeEnLigne.findUnique({
    where: { numero: req.params.numero }, include: { lignes: true },
  });
  if (!commande) return res.status(404).json({ error: "Commande introuvable." });
  res.json(commande);
});

// ------------------------------------------------------------
// ADMIN — réservé au personnel connecté (gestion), onglet "Commandes en ligne"
// ------------------------------------------------------------

router.get("/admin/commandes", requireAuth, requirePermission("ventes"), async (req, res) => {
  const { statut } = req.query;
  const commandes = await prisma.commandeEnLigne.findMany({
    where: statut ? { statut } : undefined,
    include: { lignes: true, traiteePar: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(commandes);
});

// PUT /api/boutique/admin/commandes/:id — body: { statut }
// Confirmee décrémente le stock (une seule fois — protégé contre un double-clic par la
// vérification du statut courant) ; Annulee depuis Confirmee restaure le stock.
router.put("/admin/commandes/:id", requireAuth, requirePermission("ventes"), async (req, res) => {
  const { statut } = req.body;
  const valides = ["EnAttente", "Confirmee", "Preparee", "Livree", "Annulee"];
  if (!valides.includes(statut)) return res.status(400).json({ error: "Statut invalide." });

  const commande = await prisma.commandeEnLigne.findUnique({ where: { id: req.params.id }, include: { lignes: true } });
  if (!commande) return res.status(404).json({ error: "Commande introuvable." });

  try {
    await prisma.$transaction(async (tx) => {
      // Passage à Confirmee (pour la première fois) : décrémenter le stock.
      if (statut === "Confirmee" && commande.statut !== "Confirmee") {
        for (const l of commande.lignes) {
          const item = await tx.stockItem.findUnique({
            where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "" } },
          });
          const quantiteAvant = item?.quantite || 0;
          const quantiteApres = Math.max(0, quantiteAvant - l.quantite);
          await tx.stockItem.upsert({
            where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "" } },
            update: { quantite: quantiteApres },
            create: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "", quantite: 0 },
          });
          await tx.mouvementStock.create({
            data: {
              articleId: l.articleId, type: "Vente", boutique: commande.boutique, pointure: l.pointure || "",
              quantite: l.quantite, quantiteAvant, quantiteApres, effectueParId: req.user.id,
            },
          });
        }
      }
      // Annulation d'une commande déjà confirmée : restaurer le stock.
      if (statut === "Annulee" && commande.statut === "Confirmee") {
        for (const l of commande.lignes) {
          const item = await tx.stockItem.findUnique({
            where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "" } },
          });
          const quantiteAvant = item?.quantite || 0;
          const quantiteApres = quantiteAvant + l.quantite;
          await tx.stockItem.upsert({
            where: { articleId_boutique_pointure: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "" } },
            update: { quantite: quantiteApres },
            create: { articleId: l.articleId, boutique: commande.boutique, pointure: l.pointure || "", quantite: quantiteApres },
          });
          await tx.mouvementStock.create({
            data: {
              articleId: l.articleId, type: "Correction", boutique: commande.boutique, pointure: l.pointure || "",
              quantite: l.quantite, quantiteAvant, quantiteApres, effectueParId: req.user.id,
            },
          });
        }
      }
      await tx.commandeEnLigne.update({ where: { id: commande.id }, data: { statut, traiteeParId: req.user.id } });
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erreur lors de la mise à jour de la commande." });
  }

  await consignerAudit({
    action: "COMMANDE_EN_LIGNE", cible: `Commande ${commande.numero} → ${statut}`,
    utilisateurId: req.user.id, boutique: req.user.boutique,
  });

  const misAJour = await prisma.commandeEnLigne.findUnique({ where: { id: commande.id }, include: { lignes: true, traiteePar: true } });
  res.json(misAJour);
});

module.exports = router;
