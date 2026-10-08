const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requirePermission("ventes"));

function calculerMontantRemise(type, valeur, totalVente) {
  if (type === "POURCENTAGE") {
    return Math.round((Number(totalVente) * Number(valeur)) / 100);
  }
  return Math.min(Number(valeur), Number(totalVente));
}

// POST /api/remises  { totalVente, type, valeur, clientNom? }
// Créée par la caissière au moment de payer. Reste "EN_ATTENTE" jusqu'à ce que Djenie tranche.
router.post("/", async (req, res) => {
  const { totalVente, type, valeur, clientNom } = req.body;
  if (!totalVente || !type || !valeur) {
    return res.status(400).json({ error: "Total de la vente, type et valeur de la remise sont obligatoires." });
  }
  if (type !== "MONTANT" && type !== "POURCENTAGE") {
    return res.status(400).json({ error: "Type de remise invalide." });
  }
  if (type === "POURCENTAGE" && Number(valeur) > 100) {
    return res.status(400).json({ error: "Un pourcentage ne peut pas dépasser 100." });
  }

  const montantRemise = calculerMontantRemise(type, valeur, totalVente);
  const nb = await prisma.demandeRemise.count();
  const numero = `DEM-${String(nb + 1).padStart(6, "0")}`;

  const demande = await prisma.demandeRemise.create({
    data: {
      numero, boutique: req.user.boutique, demandeParId: req.user.id,
      clientNom: clientNom || null, totalVente: Number(totalVente),
      type, valeur: Number(valeur), montantRemise,
    },
  });
  res.status(201).json(demande);
});

// GET /api/remises/:id  — la caissière (ou Djenie) consulte le statut d'une demande précise (polling)
router.get("/:id", async (req, res) => {
  const demande = await prisma.demandeRemise.findUnique({ where: { id: req.params.id } });
  if (!demande) return res.status(404).json({ error: "Demande introuvable." });
  res.json(demande);
});

// GET /api/remises?statut=EN_ATTENTE  — réservé à Djenie (Administrateur) : liste des demandes, toutes boutiques
router.get("/", async (req, res) => {
  if (!req.user.role.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  const { statut } = req.query;
  const demandes = await prisma.demandeRemise.findMany({
    where: { statut: statut || undefined },
    include: {
      demandePar: true, traitePar: true,
      vente: { select: { numero: true, date: true } }, // pour savoir quel jour aller vérifier après approbation
      retour: { select: { type: true, date: true, vente: { select: { numero: true } } } }, // idem pour une remise sur le supplément d'un échange
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(demandes);
});

// PATCH /api/remises/:id  { statut: "APPROUVEE" | "REFUSEE" }  — réservé à Djenie
//
// La vente correspondante a pu être validée avant ce traitement (statut EN_ATTENTE au moment de la vente,
// CA enregistré au plein tarif). Si on approuve ici, il faut régulariser a posteriori le CA de cette vente
// (total et montantRemise) pour qu'il rejoigne ce que le client a réellement payé. Si on refuse, le CA reste
// au plein tarif : l'écart en caisse doit être régularisé manuellement (le client a payé le tarif réduit
// sans que ce soit autorisé) — pas de correction automatique dans ce cas.
router.patch("/:id", async (req, res) => {
  if (!req.user.role.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  const { statut } = req.body;
  if (statut !== "APPROUVEE" && statut !== "REFUSEE") {
    return res.status(400).json({ error: "Statut invalide." });
  }
  try {
    const demande = await prisma.demandeRemise.findUnique({ where: { id: req.params.id } });
    if (!demande) return res.status(404).json({ error: "Demande introuvable." });
    if (demande.statut !== "EN_ATTENTE") {
      return res.status(409).json({ error: "Cette demande a déjà été traitée." });
    }

    const misAJour = await prisma.$transaction(async (tx) => {
      const demandeMiseAJour = await tx.demandeRemise.update({
        where: { id: req.params.id },
        data: { statut, traiteParId: req.user.id, dateTraitement: new Date() },
      });

      if (statut === "APPROUVEE") {
        const venteLiee = await tx.vente.findUnique({ where: { demandeRemiseId: req.params.id } });
        if (venteLiee) {
          await tx.vente.update({
            where: { id: venteLiee.id },
            data: {
              total: venteLiee.total - demandeMiseAJour.montantRemise,
              montantRemise: demandeMiseAJour.montantRemise,
            },
          });
        }
      }

      return demandeMiseAJour;
    });

    res.json(misAJour);
  } catch (err) {
    res.status(500).json({ error: "Erreur lors du traitement de la demande." });
  }
});

module.exports = router;