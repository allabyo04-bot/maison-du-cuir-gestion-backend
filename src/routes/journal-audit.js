const express = require("express");
const prisma = require("../prisma");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) {
    return res.status(403).json({ error: "Réservé à l'administrateur." });
  }
  next();
}

router.use(requireAuth, requireAdmin);

// GET /api/journal-audit?action=&dateDebut=&dateFin=  — journal générique (prix, suppressions,
// connexions, PIN/rôle) ; voir /api/journal-audit/remises-par-caissiere pour ce rapport à part
// (construit depuis les demandes de remise existantes, pas depuis ce journal).
router.get("/", async (req, res) => {
  const { action, dateDebut, dateFin } = req.query;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  const entrees = await prisma.journalAudit.findMany({
    where: { action: action || undefined, createdAt: plage },
    include: { utilisateur: { select: { nom: true, prenom: true, login: true } } },
    orderBy: { createdAt: "desc" },
    take: 500, // garde-fou — au-delà, on affine plutôt le filtre (action/période) que de tout charger
  });
  res.json(entrees);
});

// GET /api/journal-audit/fiches-clients?dateDebut=&dateFin=  — qui a créé quelle fiche, avec un
// signalement des rares fiches sans téléphone (forcément anciennes, le champ est obligatoire
// depuis) ; ne vient pas de JournalAudit mais directement de Client.creeParId.
router.get("/fiches-clients", async (req, res) => {
  const { dateDebut, dateFin } = req.query;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  // Les fiches "inconnu" (créées avant ce suivi) portent une date de création factice — celle du
  // déploiement, pas leur vraie date. On les exclut d'un filtre par période (impossible de dire
  // honnêtement si elles y appartiennent) ; elles restent visibles seulement sans filtre de date.
  const where = plage ? { createdAt: plage, creeParId: { not: null } } : {};
  const clients = await prisma.client.findMany({
    where,
    select: {
      id: true, code: true, nomPrenoms: true, telephone: true, carteFidelite: true, createdAt: true,
      creePar: { select: { nom: true, prenom: true, login: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  res.json(clients);
});

// GET /api/journal-audit/remises-par-caissiere?dateDebut=&dateFin=  — pour repérer qui demande
// beaucoup de remises (fréquence, montant, taux d'approbation/refus), pas seulement les traiter
// une par une comme dans Ventes → Demandes de remise.
router.get("/remises-par-caissiere", async (req, res) => {
  const { dateDebut, dateFin } = req.query;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  const demandes = await prisma.demandeRemise.findMany({
    where: { createdAt: plage },
    include: { demandePar: { select: { id: true, nom: true, prenom: true, login: true } } },
  });

  const parCaissiere = {};
  for (const d of demandes) {
    if (!d.demandePar) continue;
    const cle = d.demandePar.id;
    if (!parCaissiere[cle]) {
      parCaissiere[cle] = {
        caissier: { nom: d.demandePar.nom, prenom: d.demandePar.prenom, login: d.demandePar.login },
        nombre: 0, montantTotal: 0, approuvees: 0, refusees: 0, enAttente: 0,
      };
    }
    const c = parCaissiere[cle];
    c.nombre += 1;
    c.montantTotal += d.montantRemise;
    if (d.statut === "APPROUVEE") c.approuvees += 1;
    else if (d.statut === "REFUSEE") c.refusees += 1;
    else c.enAttente += 1;
  }

  res.json(Object.values(parCaissiere).sort((a, b) => b.montantTotal - a.montantTotal));
});

module.exports = router;
