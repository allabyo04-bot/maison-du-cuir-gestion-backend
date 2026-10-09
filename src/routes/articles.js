const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { BOUTIQUES, POINTURES, refBase } = require("../constants");
const { consignerAudit } = require("../journalAudit");
const cloudinary = require("../../config/cloudinary");
const uploadImage = require("../middleware/upload");
const router = express.Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage() });

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Seul l'administrateur peut effectuer des mouvements de stock." });
  }
  next();
}

async function generateReference(marqueNom, famille) {
  const base = refBase(marqueNom, famille);
  const existants = await prisma.article.findMany({ where: { reference: { startsWith: `${base}-` } }, select: { reference: true } });
  const used = new Set(existants.map((a) => parseInt(a.reference.split("-")[1], 10)).filter((n) => !isNaN(n)));
  let n = 1;
  while (used.has(n)) n++;
  return `${base}-${String(n).padStart(3, "0")}`;
}

// GET /api/articles/parametres-stock — seuils de l'alerte "stock bas" (voir schema.prisma)
router.get("/parametres-stock", async (req, res) => {
  let param = await prisma.parametreStock.findFirst();
  if (!param) param = await prisma.parametreStock.create({ data: {} });
  res.json(param);
});

// PUT /api/articles/parametres-stock   { seuilFixe, seuilPourcentage }
router.put("/parametres-stock", requireAdmin, async (req, res) => {
  const seuilFixe = parseInt(req.body.seuilFixe, 10);
  const seuilPourcentage = parseInt(req.body.seuilPourcentage, 10);
  if (!Number.isInteger(seuilFixe) || seuilFixe < 0) {
    return res.status(400).json({ error: "Le seuil fixe doit être un nombre entier positif ou nul." });
  }
  if (!Number.isInteger(seuilPourcentage) || seuilPourcentage < 0 || seuilPourcentage > 100) {
    return res.status(400).json({ error: "Le seuil en pourcentage doit être compris entre 0 et 100." });
  }
  let param = await prisma.parametreStock.findFirst();
  param = param
    ? await prisma.parametreStock.update({ where: { id: param.id }, data: { seuilFixe, seuilPourcentage } })
    : await prisma.parametreStock.create({ data: { seuilFixe, seuilPourcentage } });
  res.json(param);
});

// GET /api/articles/mouvements/historique?articleId=&boutique=&dateDebut=&dateFin=&type=
// historique des mouvements de stock — utile notamment pour vérifier ce qui a été ajouté
// (type=Ajout) sur une période précise, par ex. "qu'est-ce qui a été mis en stock hier".
router.get("/mouvements/historique", async (req, res) => {
  const { articleId, boutique, dateDebut, dateFin, type } = req.query;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  const mouvements = await prisma.mouvementStock.findMany({
    where: {
      articleId: articleId || undefined,
      type: type || undefined,
      date: plage,
      OR: boutique ? [{ boutique }, { boutiqueSource: boutique }] : undefined,
    },
    include: { article: true, effectuePar: true },
    orderBy: { date: "desc" },
    take: 500,
  });
  res.json(mouvements);
});

router.get("/", async (req, res) => {
  const articles = await prisma.article.findMany({
    include: { marque: true, stocks: true, photos: { orderBy: { ordre: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(articles);
});

router.post("/", requirePermission("stock"), async (req, res) => {
  const { designation, famille, marqueId, prixVente } = req.body;
  if (!designation?.trim() || !famille || !marqueId || !prixVente) {
    return res.status(400).json({ error: "Désignation, famille, marque et prix de vente sont obligatoires." });
  }
  const marque = await prisma.brand.findUnique({ where: { id: marqueId } });
  if (!marque) return res.status(400).json({ error: "Marque introuvable." });
  const reference = await generateReference(marque.nom, famille);
  const stocksData = famille === "Chaussure"
    ? BOUTIQUES.flatMap((b) => POINTURES.map((p) => ({ boutique: b, pointure: p, quantite: 0 })))
    : BOUTIQUES.map((b) => ({ boutique: b, pointure: "", quantite: 0 }));
  const article = await prisma.article.create({
    data: {
      reference, designation: designation.trim(), famille, marqueId, prixVente: Number(prixVente),
      stocks: { create: stocksData },
    },
    include: { marque: true, stocks: true },
  });
  res.status(201).json(article);
});

// PUT /api/articles/desactiver-tous  — réservé à l'administrateur
// Met en veille tout le catalogue d'un coup (les deux boutiques, l'article n'étant pas
// rattaché à une boutique précise) — pour repartir sur une base propre avant un nouvel
// inventaire complet. Ne supprime rien : l'historique des ventes passées reste intact,
// les articles redeviennent visibles automatiquement dès qu'ils sont réimportés (voir
// import/confirmer) ou réactivés manuellement.
router.put("/desactiver-tous", requireAdmin, async (req, res) => {
  const { count } = await prisma.article.updateMany({ where: { actif: true }, data: { actif: false } });
  res.json({ desactives: count });
});

router.put("/:id", requirePermission("stock"), async (req, res) => {
  const { designation, prixVente, actif } = req.body;
  const avant = await prisma.article.findUnique({ where: { id: req.params.id } });
  const article = await prisma.article.update({
    where: { id: req.params.id },
    data: { designation, prixVente: prixVente ? Number(prixVente) : undefined, actif },
    include: { marque: true, stocks: true },
  });
  if (avant && prixVente && Number(prixVente) !== avant.prixVente) {
    await consignerAudit({
      action: "PRIX_MODIFIE", cible: `Article : ${article.designation} (${article.reference})`,
      detail: `Prix : ${avant.prixVente} F -> ${Number(prixVente)} F`,
      utilisateurId: req.user.id, boutique: req.user.boutique,
    });
  }
  res.json(article);
});

router.delete("/:id", requirePermission("stock"), async (req, res) => {
  const article = await prisma.article.findUnique({ where: { id: req.params.id } });
  await prisma.article.delete({ where: { id: req.params.id } });
  if (article) {
    await consignerAudit({
      action: "SUPPRESSION", cible: `Article : ${article.designation} (${article.reference})`,
      utilisateurId: req.user.id, boutique: req.user.boutique,
    });
  }
  res.status(204).end();
});

router.put("/:id/stock", requirePermission("stock"), requireAdmin, async (req, res) => {
  const { boutique, pointure, quantite } = req.body;
  const qty = Math.max(0, parseInt(quantite, 10) || 0);
  const avant = await prisma.stockItem.findUnique({
    where: { articleId_boutique_pointure: { articleId: req.params.id, boutique, pointure: pointure || "" } },
  });
  const quantiteAvant = avant?.quantite || 0;
  // Une correction manuelle redéfinit le compte vrai — on en profite pour rafraîchir la
  // référence "stock initial" utilisée par l'alerte de stock bas en pourcentage.
  const item = await prisma.stockItem.upsert({
    where: { articleId_boutique_pointure: { articleId: req.params.id, boutique, pointure: pointure || "" } },
    update: { quantite: qty, quantiteInitiale: qty },
    create: { articleId: req.params.id, boutique, pointure: pointure || "", quantite: qty, quantiteInitiale: qty },
  });
  await prisma.mouvementStock.create({
    data: {
      articleId: req.params.id, type: "Correction", boutique, pointure: pointure || "",
      quantite: Math.abs(qty - quantiteAvant), quantiteAvant, quantiteApres: qty,
      effectueParId: req.user.id,
    },
  });
  res.json(item);
});

router.post("/:id/stock/ajouter", requirePermission("stock"), requireAdmin, async (req, res) => {
  const { boutique, pointure, quantite } = req.body;
  const qty = parseInt(quantite, 10);
  if (!boutique || !qty || qty <= 0) {
    return res.status(400).json({ error: "Boutique et quantité (positive) sont obligatoires." });
  }
  const avant = await prisma.stockItem.findUnique({
    where: { articleId_boutique_pointure: { articleId: req.params.id, boutique, pointure: pointure || "" } },
  });
  const quantiteAvant = avant?.quantite || 0;
  // Ajout manuel = un vrai réapprovisionnement (souvent une nouvelle collection qui arrive) :
  // la référence "stock initial" est portée au nouveau total.
  const item = await prisma.stockItem.upsert({
    where: { articleId_boutique_pointure: { articleId: req.params.id, boutique, pointure: pointure || "" } },
    update: { quantite: { increment: qty }, quantiteInitiale: quantiteAvant + qty },
    create: { articleId: req.params.id, boutique, pointure: pointure || "", quantite: qty, quantiteInitiale: qty },
  });
  await prisma.mouvementStock.create({
    data: {
      articleId: req.params.id, type: "Ajout", boutique, pointure: pointure || "",
      quantite: qty, quantiteAvant, quantiteApres: quantiteAvant + qty,
      effectueParId: req.user.id,
    },
  });
  res.json(item);
});

router.post("/:id/stock/virement", requirePermission("stock"), requireAdmin, async (req, res) => {
  const { boutiqueSource, boutiqueDestination, pointure, quantite } = req.body;
  const qty = parseInt(quantite, 10);
  if (!boutiqueSource || !boutiqueDestination || !qty || qty <= 0) {
    return res.status(400).json({ error: "Boutique source, boutique destination et quantité (positive) sont obligatoires." });
  }
  if (boutiqueSource === boutiqueDestination) {
    return res.status(400).json({ error: "Les boutiques source et destination doivent être différentes." });
  }
  try {
    const [source, destination] = await prisma.$transaction(async (tx) => {
      const stockSource = await tx.stockItem.findUnique({
        where: { articleId_boutique_pointure: { articleId: req.params.id, boutique: boutiqueSource, pointure: pointure || "" } },
      });
      const dispoSource = stockSource?.quantite || 0;
      if (qty > dispoSource) {
        throw { status: 409, message: `Stock insuffisant à ${boutiqueSource} (${dispoSource} disponible(s)).` };
      }
      const stockDestination = await tx.stockItem.findUnique({
        where: { articleId_boutique_pointure: { articleId: req.params.id, boutique: boutiqueDestination, pointure: pointure || "" } },
      });
      const dispoDestination = stockDestination?.quantite || 0;
      const nouvelleSource = await tx.stockItem.update({
        where: { articleId_boutique_pointure: { articleId: req.params.id, boutique: boutiqueSource, pointure: pointure || "" } },
        data: { quantite: dispoSource - qty },
      });
      // Un virement déplace du stock déjà existant, ce n'est pas un réapprovisionnement — la
      // référence "stock initial" n'est pas touchée (sauf si la destination n'avait encore
      // jamais eu de ligne de stock pour cet article, auquel cas on l'initialise).
      const nouvelleDestination = await tx.stockItem.upsert({
        where: { articleId_boutique_pointure: { articleId: req.params.id, boutique: boutiqueDestination, pointure: pointure || "" } },
        update: { quantite: { increment: qty } },
        create: { articleId: req.params.id, boutique: boutiqueDestination, pointure: pointure || "", quantite: qty, quantiteInitiale: qty },
      });
      await tx.mouvementStock.create({
        data: {
          articleId: req.params.id, type: "Virement", boutique: boutiqueDestination, boutiqueSource, pointure: pointure || "",
          quantite: qty, quantiteAvant: dispoDestination, quantiteApres: dispoDestination + qty,
          effectueParId: req.user.id,
        },
      });
      return [nouvelleSource, nouvelleDestination];
    });
    res.json({ source, destination });
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Erreur lors du virement de stock.";
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  }
});
function normaliserEnTete(valeur) {
  return String(valeur || "").trim().toUpperCase();
}

function lireFichierImport(buffer, modeQuantite) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const lignesBrutes = XLSX.utils.sheet_to_json(sheet, { defval: null });

  const lignes = [];
  for (const ligne of lignesBrutes) {
    const cles = {};
    for (const cle of Object.keys(ligne)) cles[normaliserEnTete(cle)] = ligne[cle];

    const designation = String(cles["REFERENCES"] || "").replace(/\s+/g, " ").trim();
    if (!designation) continue;

    const prixVente = parseInt(cles["PRIX DE VENTE"], 10);
    const quantites = {};

    if (modeQuantite === "pointure") {
      for (const p of POINTURES) {
        const q = parseInt(cles[`T${p}`], 10);
        if (!isNaN(q) && q > 0) quantites[p] = q;
      }
    } else {
      const q = parseInt(cles["QUANTITE"], 10);
      if (!isNaN(q) && q > 0) quantites[""] = q;
    }

    lignes.push({ designation, prixVente: isNaN(prixVente) ? null : prixVente, quantites });
  }
  return lignes;
}

router.post("/import/apercu", requirePermission("stock"), requireAdmin, upload.single("fichier"), async (req, res) => {
  const { marqueId, famille, boutique } = req.body;
  const modeQuantite = req.body.modeQuantite || (famille === "Chaussure" ? "pointure" : "simple"); // repli si non fourni
  if (!req.file || !marqueId || !famille || !boutique) {
    return res.status(400).json({ error: "Fichier, marque, famille et boutique sont obligatoires." });
  }
  const marque = await prisma.brand.findUnique({ where: { id: marqueId } });
  if (!marque) return res.status(400).json({ error: "Marque introuvable." });

  let lignesFichier;
  try {
    lignesFichier = lireFichierImport(req.file.buffer, modeQuantite);
  } catch (e) {
    return res.status(400).json({ error: "Impossible de lire ce fichier Excel. Vérifie le format." });
  }
  if (lignesFichier.length === 0) {
    return res.status(400).json({ error: "Aucune ligne exploitable trouvée dans le fichier." });
  }

  const resultat = [];
  for (const l of lignesFichier) {
    const articleExistant = await prisma.article.findFirst({
      where: { marqueId, famille, designation: { equals: l.designation, mode: "insensitive" } },
      include: { stocks: { where: { boutique } } },
    });

    const quantiteTotale = Object.values(l.quantites).reduce((s, q) => s + q, 0);

    if (articleExistant) {
      const stocksParPointure = {};
      for (const s of articleExistant.stocks) stocksParPointure[s.pointure] = s.quantite;

      resultat.push({
        designation: l.designation,
        existant: true,
        articleId: articleExistant.id,
        ancienPrix: articleExistant.prixVente,
        nouveauPrix: l.prixVente,
        ecartPrix: l.prixVente != null && l.prixVente !== articleExistant.prixVente,
        quantites: l.quantites,
        quantiteTotale,
        stockActuel: stocksParPointure,
      });
    } else {
      resultat.push({
        designation: l.designation,
        existant: false,
        articleId: null,
        ancienPrix: null,
        nouveauPrix: l.prixVente,
        ecartPrix: false,
        quantites: l.quantites,
        quantiteTotale,
        stockActuel: {},
      });
    }
  }

  const nbNouveaux = resultat.filter((r) => !r.existant).length;
  const nbExistants = resultat.filter((r) => r.existant).length;
  const nbEcartsPrix = resultat.filter((r) => r.ecartPrix).length;

  res.json({ marque: marque.nom, famille, boutique, lignes: resultat, nbNouveaux, nbExistants, nbEcartsPrix });
});

router.post("/import/confirmer", requirePermission("stock"), requireAdmin, async (req, res) => {
  const { marqueId, famille, boutique, lignes } = req.body;
  const modeQuantite = req.body.modeQuantite || (famille === "Chaussure" ? "pointure" : "simple"); // repli si non fourni
  if (!marqueId || !famille || !boutique || !Array.isArray(lignes) || lignes.length === 0) {
    return res.status(400).json({ error: "Marque, famille, boutique et lignes sont obligatoires." });
  }
  const marque = await prisma.brand.findUnique({ where: { id: marqueId } });
  if (!marque) return res.status(400).json({ error: "Marque introuvable." });

  const rapport = { articlesCreees: 0, articlesMisesAJour: 0, mouvements: 0 };

  try {
    for (const l of lignes) {
      const designation = String(l.designation || "").trim();
      if (!designation) continue;
      const quantites = l.quantites || {};
      const prixVente = l.prixVente != null ? Number(l.prixVente) : null;

      let articleId = l.articleId;

      if (!articleId) {
        if (!prixVente) throw { status: 400, message: `Prix de vente manquant pour "${designation}".` };
        const stocksData = modeQuantite === "pointure"
          ? BOUTIQUES.flatMap((b) => POINTURES.map((p) => ({ boutique: b, pointure: p, quantite: 0 })))
          : BOUTIQUES.map((b) => ({ boutique: b, pointure: "", quantite: 0 }));
        let nouvelArticle;
        for (let essai = 0; essai < 5; essai++) {
          const reference = await generateReference(marque.nom, famille);
          try {
            nouvelArticle = await prisma.article.create({
              data: { reference, designation, famille, marqueId, prixVente, stocks: { create: stocksData } },
            });
            break;
          } catch (e) {
            if (e.code === "P2002" && essai < 4) continue;
            throw e;
          }
        }
        articleId = nouvelArticle.id;
        rapport.articlesCreees += 1;
      } else if (prixVente != null) {
        await prisma.article.update({ where: { id: articleId }, data: { prixVente, actif: true } });
        rapport.articlesMisesAJour += 1;
      } else {
        // Pas de prix fourni dans cette ligne, mais l'article revient dans un import : on le
        // réactive quand même, sinon il resterait invisible à la vente malgré le nouveau stock.
        await prisma.article.update({ where: { id: articleId }, data: { actif: true } });
      }

      for (const [pointure, qte] of Object.entries(quantites)) {
        const qty = parseInt(qte, 10);
        if (!qty || qty <= 0) continue;

        const avant = await prisma.stockItem.findUnique({
          where: { articleId_boutique_pointure: { articleId, boutique, pointure } },
        });
        const quantiteAvant = avant?.quantite || 0;

        // Import = arrivage réel (souvent une nouvelle collection) — la référence "stock
        // initial" est portée au nouveau total, pour l'alerte de stock bas en pourcentage.
        await prisma.stockItem.upsert({
          where: { articleId_boutique_pointure: { articleId, boutique, pointure } },
          update: { quantite: { increment: qty }, quantiteInitiale: quantiteAvant + qty },
          create: { articleId, boutique, pointure, quantite: qty, quantiteInitiale: qty },
        });

        await prisma.mouvementStock.create({
          data: {
            articleId, type: "Ajout", boutique, pointure,
            quantite: qty, quantiteAvant, quantiteApres: quantiteAvant + qty,
            effectueParId: req.user.id,
          },
        });
        rapport.mouvements += 1;
      }
    }
    res.json(rapport);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Erreur lors de l'import.";
    if (status === 500) console.error(err);
    res.status(status).json({ error: message, partiel: rapport });
  }
});

// GET /api/articles/:id/historique-prix-achat — chaque prix d'achat connu pour cet article,
// dans l'ordre chronologique, avec le fournisseur et la date de la réception correspondante.
router.get("/:id/historique-prix-achat", async (req, res) => {
  const lignes = await prisma.ligneReception.findMany({
    where: { articleId: req.params.id, prixAchat: { not: null } },
    include: { reception: { include: { fournisseur: true } } },
    orderBy: { reception: { dateReception: "asc" } },
  });
  res.json(lignes.map((l) => ({
    prixAchat: l.prixAchat, quantite: l.quantite,
    date: l.reception.dateReception,
    fournisseur: l.reception.fournisseur?.nom || l.reception.fournisseurNomLibre || null,
  })));
});

// POST /api/articles/:id/photo — ajoute une photo à la galerie de l'article (n'écrase pas les
// photos existantes). La toute première photo ajoutée devient automatiquement la principale.
router.post("/:id/photo", requirePermission("stock"), uploadImage.single("photo"), async (req, res) => {
  const { id } = req.params;
  const article = await prisma.article.findUnique({ where: { id } });
  if (!article) return res.status(404).json({ error: "Article introuvable." });
  if (!req.file) return res.status(400).json({ error: "Aucune image reçue." });

  try {
    const resultat = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "maison-du-cuir/articles", resource_type: "image" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const nombrePhotosExistantes = await prisma.photoArticle.count({ where: { articleId: id } });
    const estPremierePhoto = nombrePhotosExistantes === 0;

    await prisma.photoArticle.create({
      data: {
        articleId: id, url: resultat.secure_url, ordre: nombrePhotosExistantes,
        estPrincipale: estPremierePhoto, ajouteParId: req.user.id,
      },
    });

    // Article.photoUrl reste synchronisé sur la photo principale pour un accès rapide sans
    // avoir à inclure la relation photos dans toutes les listes.
    const misAJour = await prisma.article.update({
      where: { id },
      data: estPremierePhoto ? { photoUrl: resultat.secure_url } : {},
      include: { photos: { orderBy: { ordre: "asc" } } },
    });

    res.json(misAJour);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Échec de l'upload de la photo." });
  }
});

// DELETE /api/articles/:id/photos/:photoId — supprime une photo de la galerie. Si c'était la
// photo principale, la suivante (par ordre) est promue automatiquement, sinon photoUrl repasse à null.
router.delete("/:id/photos/:photoId", requirePermission("stock"), async (req, res) => {
  const { id, photoId } = req.params;
  const photo = await prisma.photoArticle.findUnique({ where: { id: photoId } });
  if (!photo || photo.articleId !== id) return res.status(404).json({ error: "Photo introuvable pour cet article." });

  await prisma.photoArticle.delete({ where: { id: photoId } });

  let data = {};
  if (photo.estPrincipale) {
    const suivante = await prisma.photoArticle.findFirst({ where: { articleId: id }, orderBy: { ordre: "asc" } });
    if (suivante) await prisma.photoArticle.update({ where: { id: suivante.id }, data: { estPrincipale: true } });
    data = { photoUrl: suivante ? suivante.url : null };
  }

  const article = await prisma.article.update({
    where: { id }, data, include: { photos: { orderBy: { ordre: "asc" } } },
  });
  res.json(article);
});

// PUT /api/articles/:id/photos/:photoId/principale — définit une photo existante comme
// principale (vignette dans les listes et plus tard le catalogue du site).
router.put("/:id/photos/:photoId/principale", requirePermission("stock"), async (req, res) => {
  const { id, photoId } = req.params;
  const photo = await prisma.photoArticle.findUnique({ where: { id: photoId } });
  if (!photo || photo.articleId !== id) return res.status(404).json({ error: "Photo introuvable pour cet article." });

  await prisma.photoArticle.updateMany({ where: { articleId: id }, data: { estPrincipale: false } });
  await prisma.photoArticle.update({ where: { id: photoId }, data: { estPrincipale: true } });

  const article = await prisma.article.update({
    where: { id }, data: { photoUrl: photo.url }, include: { photos: { orderBy: { ordre: "asc" } } },
  });
  res.json(article);
});

module.exports = router;