const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Réservé à l'administrateur." });
  }
  next();
}

// GET /api/bons-valeur?type=AVOIR|CADEAU
router.get("/", async (req, res) => {
  const { type } = req.query;
  const bons = await prisma.bonValeur.findMany({
    where: { type: type || undefined },
    include: { client: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(bons);
});

// GET /api/bons-valeur/:numero/verifier — utilisé au moment du paiement pour valider un bon avant de l'accepter
router.get("/:numero/verifier", async (req, res) => {
  const bon = await prisma.bonValeur.findUnique({ where: { numero: req.params.numero }, include: { client: true } });
  if (!bon) return res.status(404).json({ error: "Aucun bon ne correspond à ce numéro." });
  if (bon.enStock) return res.status(409).json({ error: "Cette carte n'a pas encore été vendue à une cliente." });
  if (bon.utilisee) return res.status(409).json({ error: "Ce bon a déjà été utilisé." });
  if (bon.dateValidite && new Date(bon.dateValidite) < new Date()) {
    return res.status(409).json({ error: "Ce bon a expiré." });
  }
  res.json(bon);
});

// POST /api/bons-valeur — création manuelle d'une carte cadeau (numéro auto ou saisi)
// La carte est payée à sa création : boutique et mode de paiement obligatoires,
// pour que ce montant apparaisse comme un vrai encaissement du jour dans les États.
// La création décrémente aussi le stock de l'article générique "CARTES CADEAUX" (si créé).
router.post("/", requireAdmin, async (req, res) => {
  const { numero, montant, dateValidite, boutique, modePaiement, historique } = req.body;
  if (!montant) return res.status(400).json({ error: "Le montant est obligatoire." });
  if (!boutique) return res.status(400).json({ error: "La boutique est obligatoire." });
  // Une carte "historique" (vendue avant tout logiciel, jamais suivie nulle part) ne représente
  // aucun encaissement du jour ni aucune sortie de stock compté — on ne demande donc pas de mode
  // de paiement pour elle, et son numéro n'entrera jamais dans le chiffre d'affaires.
  if (!historique && !modePaiement) return res.status(400).json({ error: "Le mode de paiement est obligatoire." });

  let numeroFinal = numero?.trim();
  if (!numeroFinal) {
    const nb = await prisma.bonValeur.count({ where: { type: "CADEAU" } });
    numeroFinal = `CG-${String(nb + 1).padStart(4, "0")}`;
  }

  const existant = await prisma.bonValeur.findUnique({ where: { numero: numeroFinal } });
  if (existant) return res.status(409).json({ error: "Ce numéro existe déjà." });

  try {
    const bon = await prisma.$transaction(async (tx) => {
      if (!historique) {
        const articleCarte = await tx.article.findFirst({ where: { designation: "CARTES CADEAUX" } });
        if (articleCarte) {
          const stockItem = await tx.stockItem.findUnique({
            where: { articleId_boutique_pointure: { articleId: articleCarte.id, boutique, pointure: "" } },
          });
          const dispo = stockItem?.quantite || 0;
          if (dispo <= 0) throw { status: 409, message: `Aucune carte cadeau en stock à ${boutique}. Fais d'abord une réception de stock.` };

          await tx.stockItem.update({
            where: { articleId_boutique_pointure: { articleId: articleCarte.id, boutique, pointure: "" } },
            data: { quantite: dispo - 1 },
          });

          await tx.mouvementStock.create({
            data: {
              articleId: articleCarte.id, type: "Correction", boutique, pointure: "",
              quantite: 1, quantiteAvant: dispo, quantiteApres: dispo - 1,
              effectueParId: req.user.id,
            },
          });
        }
      }

      const bonCree = await tx.bonValeur.create({
        data: {
          numero: numeroFinal, type: "CADEAU", montant: Number(montant),
          dateValidite: dateValidite ? new Date(dateValidite) : (historique ? null : (() => { const d = new Date(); d.setMonth(d.getMonth() + 3); return d; })()),
          boutique, modePaiement: historique ? null : modePaiement,
        },
      });

      if (!historique) {
        const denomination = await tx.denominationCarteCadeau.findUnique({ where: { montant: Number(montant) } });
        if (denomination) {
          await tx.denominationCarteCadeau.update({
            where: { id: denomination.id },
            data: { stockRestant: Math.max(0, denomination.stockRestant - 1) },
          });
        }
      }

      return bonCree;
    });
    res.status(201).json(bon);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "Erreur lors de la création de la carte cadeau.";
    if (status === 500) console.error(err);
    res.status(status).json({ error: message });
  }
});

// PUT /api/bons-valeur/:id/marquer-historique — réservé à l'administrateur
// Corrige une carte créée par erreur avec un mode de paiement (donc comptée dans le chiffre
// d'affaires du jour), alors qu'elle aurait dû être enregistrée comme "historique" — retire
// le mode de paiement, ce qui l'exclut immédiatement de tous les rapports de caisse.
router.put("/:id/marquer-historique", requireAdmin, async (req, res) => {
  const bon = await prisma.bonValeur.findUnique({ where: { id: req.params.id } });
  if (!bon) return res.status(404).json({ error: "Carte introuvable." });
  if (bon.type !== "CADEAU") return res.status(400).json({ error: "Seule une carte cadeau peut être marquée historique." });
  const misAJour = await prisma.bonValeur.update({ where: { id: bon.id }, data: { modePaiement: null } });
  res.json(misAJour);
});

// DELETE /api/bons-valeur/:id — réservé à l'administrateur
// Supprime une carte créée par erreur (mauvais numéro, doublon...). Bloqué si la carte a déjà
// été vendue via une vraie vente, ou déjà utilisée comme paiement — dans ces cas, la carte fait
// partie de l'historique réel et ne doit jamais disparaître silencieusement.
router.delete("/:id", requireAdmin, async (req, res) => {
  const bon = await prisma.bonValeur.findUnique({ where: { id: req.params.id } });
  if (!bon) return res.status(404).json({ error: "Carte introuvable." });
  if (bon.origineVenteId) {
    return res.status(409).json({ error: "Cette carte a été vendue via une vraie vente — annule plutôt cette vente si besoin, ne supprime pas la carte." });
  }
  if (bon.utilisee) {
    return res.status(409).json({ error: "Cette carte a déjà été utilisée comme paiement — impossible de la supprimer sans fausser l'historique." });
  }
  await prisma.bonValeur.delete({ where: { id: bon.id } });
  res.json({ ok: true });
});

// GET /api/bons-valeur/echeances-proches?jours=7
// Avoirs et cartes cadeaux non utilisés qui expirent dans les X prochains jours (7 par défaut) —
// visible par les caissières et l'admin, pour rappeler à la cliente de venir les utiliser avant
// qu'ils ne soient définitivement perdus.
router.get("/echeances-proches", async (req, res) => {
  const jours = Number(req.query.jours) || 7;
  const maintenant = new Date();
  const limite = new Date();
  limite.setDate(limite.getDate() + jours);

  const bons = await prisma.bonValeur.findMany({
    where: { utilisee: false, dateValidite: { gte: maintenant, lte: limite } },
    include: { client: true },
    orderBy: { dateValidite: "asc" },
  });
  res.json(bons);
});

// PUT /api/bons-valeur/:id/rappel   { effectue: true|false }
// Marque (ou démarque) qu'une caissière ou l'admin a bien appelé la cliente au sujet de
// l'échéance proche — accessible à tout le monde, pas réservé à l'administrateur.
router.put("/:id/rappel", async (req, res) => {
  const { effectue } = req.body;
  const bon = await prisma.bonValeur.findUnique({ where: { id: req.params.id } });
  if (!bon) return res.status(404).json({ error: "Carte ou avoir introuvable." });
  const misAJour = await prisma.bonValeur.update({
    where: { id: bon.id },
    data: effectue
      ? { rappelEffectue: true, rappelEffectueParId: req.user.id, dateRappel: new Date() }
      : { rappelEffectue: false, rappelEffectueParId: null, dateRappel: null },
    include: { client: true },
  });
  res.json(misAJour);
});

module.exports = router;