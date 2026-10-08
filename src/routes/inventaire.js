const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("stock"));

const upload = multer({ storage: multer.memoryStorage() });

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Seul l'administrateur peut effectuer un inventaire." });
  }
  next();
}

// GET /api/inventaire/export?boutique=&marqueId=&famille=
// Génère la feuille de comptage Excel : une ligne par (article, pointure) avec le stock
// système actuel, et une colonne "Stock Compté" vide à remplir sur le terrain.
// La colonne "Référence" (code article, unique) sert de clé de correspondance au réimport —
// on demande de ne pas la modifier dans le fichier.
router.get("/export", async (req, res) => {
  const { boutique, marqueId, famille } = req.query;
  if (!boutique) return res.status(400).json({ error: "Boutique obligatoire." });

  const where = { actif: true };
  if (marqueId) where.marqueId = marqueId;
  if (famille) where.famille = famille;

  const articles = await prisma.article.findMany({
    where,
    include: { marque: true, stocks: { where: { boutique } } },
    orderBy: [{ marque: { nom: "asc" } }, { designation: "asc" }],
  });

  const lignes = [];
  for (const a of articles) {
    if (a.stocks.length === 0) {
      // Article sans ligne de stock dans cette boutique (jamais approvisionné ici) — on
      // l'inclut quand même avec 0, au cas où le comptage physique en trouverait.
      lignes.push({
        "Référence": a.reference, "Désignation": a.designation, "Marque": a.marque.nom,
        "Famille": a.famille, "Pointure": "", "Stock Théorique": 0, "Stock Compté": "",
      });
      continue;
    }
    for (const s of a.stocks) {
      lignes.push({
        "Référence": a.reference, "Désignation": a.designation, "Marque": a.marque.nom,
        "Famille": a.famille, "Pointure": s.pointure || "", "Stock Théorique": s.quantite, "Stock Compté": "",
      });
    }
  }

  const feuille = XLSX.utils.json_to_sheet(lignes);
  feuille["!cols"] = [{ wch: 14 }, { wch: 40 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 }];
  const classeur = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(classeur, feuille, "Inventaire");
  const buffer = XLSX.write(classeur, { type: "buffer", bookType: "xlsx" });

  const nomFichier = `inventaire-${boutique.replace(/\s+/g, "_")}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${nomFichier}"`);
  res.send(buffer);
});

// POST /api/inventaire/apercu   (multipart, champ "fichier")  body: boutique
// Ne modifie rien en base : lit le fichier reimporte, fait correspondre chaque ligne à un
// article existant par sa Référence (+ Pointure), et calcule l'écart avec le stock système.
router.post("/apercu", requireAdmin, upload.single("fichier"), async (req, res) => {
  const { boutique } = req.body;
  if (!req.file || !boutique) {
    return res.status(400).json({ error: "Fichier et boutique sont obligatoires." });
  }

  let lignesFichier;
  try {
    const classeur = XLSX.read(req.file.buffer, { type: "buffer" });
    const feuille = classeur.Sheets[classeur.SheetNames[0]];
    lignesFichier = XLSX.utils.sheet_to_json(feuille, { defval: null });
  } catch (e) {
    return res.status(400).json({ error: "Impossible de lire ce fichier Excel. Vérifie le format." });
  }
  if (lignesFichier.length === 0) {
    return res.status(400).json({ error: "Aucune ligne exploitable trouvée dans le fichier." });
  }

  const resultat = [];
  for (const l of lignesFichier) {
    const reference = String(l["Référence"] || l["Reference"] || "").trim();
    const pointure = String(l["Pointure"] || "").trim();
    const stockCompteBrut = l["Stock Compté"] ?? l["Stock Compte"];

    if (!reference) {
      resultat.push({ statut: "ERREUR", erreur: "Référence manquante sur cette ligne.", ligneBrute: l });
      continue;
    }
    if (stockCompteBrut === null || stockCompteBrut === undefined || stockCompteBrut === "") {
      resultat.push({ statut: "IGNOREE", reference, pointure, erreur: "Stock compté laissé vide — ligne ignorée." });
      continue;
    }
    const quantiteComptee = Number(stockCompteBrut);
    if (Number.isNaN(quantiteComptee) || quantiteComptee < 0) {
      resultat.push({ statut: "ERREUR", reference, pointure, erreur: "Stock compté invalide." });
      continue;
    }

    const article = await prisma.article.findUnique({ where: { reference } });
    if (!article) {
      resultat.push({ statut: "INTROUVABLE", reference, pointure, erreur: "Aucun article ne correspond à cette référence." });
      continue;
    }

    const stockItem = await prisma.stockItem.findUnique({
      where: { articleId_boutique_pointure: { articleId: article.id, boutique, pointure } },
    });
    const stockActuel = stockItem?.quantite || 0;
    const ecart = quantiteComptee - stockActuel;

    resultat.push({
      statut: "OK", articleId: article.id, reference, designation: article.designation,
      pointure, stockActuel, quantiteComptee, ecart,
    });
  }

  const lignesOk = resultat.filter((r) => r.statut === "OK");
  res.json({
    lignes: resultat,
    nombreLignes: resultat.length,
    nombreOk: lignesOk.length,
    nombreEcarts: lignesOk.filter((r) => r.ecart !== 0).length,
    nombreIntrouvables: resultat.filter((r) => r.statut === "INTROUVABLE").length,
    nombreErreurs: resultat.filter((r) => r.statut === "ERREUR").length,
  });
});

// POST /api/inventaire/confirmer
// body: { boutique, notes?, lignes: [{ articleId, pointure, quantiteComptee }] }
// Applique la correction pour chaque ligne dont la quantité comptée diffère du stock système —
// trace chaque écart dans l'historique des mouvements (type "Correction"), comme pour une
// correction manuelle. Les lignes sans écart sont ignorées.
router.post("/confirmer", requireAdmin, async (req, res) => {
  const { boutique, notes, lignes } = req.body;
  if (!boutique || !Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: "Boutique et au moins une ligne sont obligatoires." });
  }

  let corrections = 0;
  let inchanges = 0;
  const erreurs = [];

  for (const l of lignes) {
    const { articleId, pointure } = l;
    const quantiteComptee = Number(l.quantiteComptee);
    if (!articleId || Number.isNaN(quantiteComptee) || quantiteComptee < 0) {
      erreurs.push({ articleId, pointure, error: "Ligne invalide." });
      continue;
    }
    try {
      const avant = await prisma.stockItem.findUnique({
        where: { articleId_boutique_pointure: { articleId, boutique, pointure: pointure || "" } },
      });
      const quantiteAvant = avant?.quantite || 0;
      if (quantiteComptee === quantiteAvant) { inchanges++; continue; }

      await prisma.stockItem.upsert({
        where: { articleId_boutique_pointure: { articleId, boutique, pointure: pointure || "" } },
        update: { quantite: quantiteComptee },
        create: { articleId, boutique, pointure: pointure || "", quantite: quantiteComptee, quantiteInitiale: quantiteComptee },
      });
      await prisma.mouvementStock.create({
        data: {
          articleId, type: "Correction", boutique, pointure: pointure || "",
          quantite: Math.abs(quantiteComptee - quantiteAvant), quantiteAvant, quantiteApres: quantiteComptee,
          effectueParId: req.user.id,
        },
      });
      corrections++;
    } catch (err) {
      erreurs.push({ articleId, pointure, error: err.message });
    }
  }

  res.json({ corrections, inchanges, erreurs, notes: notes || null });
});

module.exports = router;
