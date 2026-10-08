const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { bonusDisponible, statutFidelite } = require("../fidelite");

const router = express.Router();
router.use(requireAuth, requirePermission("clients"));

function requireAdmin(req, res, next) {
  if (!req.user?.role?.systeme) return res.status(403).json({ error: "Réservé à l'administrateur." });
  next();
}

// GET /api/fidelite/client/:id — pour la fiche client et l'écran de vente (bannière bonus)
router.get("/client/:id", async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) return res.status(404).json({ error: "Client introuvable." });
  const [bonus, statut, historique] = await Promise.all([
    bonusDisponible(client.cumulFideliteCourant, prisma),
    statutFidelite(client.cumulFideliteTotal, prisma),
    prisma.bonusFideliteUtilise.findMany({
      where: { clientId: client.id },
      include: { vente: { select: { numero: true, date: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  // Distance au prochain palier de bonus, utile pour l'alerte vendeuse ("il ne lui manque que...")
  // — seulement quand elle n'a pas déjà un bonus disponible (sinon la question ne se pose pas).
  let prochainPalierDistance = null;
  if (bonus === 0) {
    const prochain = await prisma.palierBonus.findFirst({
      where: { actif: true, seuilBas: { gt: client.cumulFideliteCourant } },
      orderBy: { seuilBas: "asc" },
    });
    if (prochain) prochainPalierDistance = prochain.seuilBas - client.cumulFideliteCourant;
  }
  res.json({
    cumulFideliteTotal: client.cumulFideliteTotal,
    cumulFideliteCourant: client.cumulFideliteCourant,
    statut, bonusDisponible: bonus, historique, prochainPalierDistance,
  });
});

// GET /api/fidelite/clients-bonus-disponible — toutes les clientes ayant actuellement un bonus
// prêt à être utilisé à leur prochain achat (admin) : pour vérifier/suivre le programme, pas
// pour un usage quotidien des caissières.
router.get("/clients-bonus-disponible", requireAdmin, async (req, res) => {
  const paliers = await prisma.palierBonus.findMany({ where: { actif: true }, orderBy: { seuilBas: "asc" } });
  if (paliers.length === 0) return res.json([]);
  const seuilMin = paliers[0].seuilBas;
  const candidats = await prisma.client.findMany({
    where: { cumulFideliteCourant: { gte: seuilMin } },
    select: { id: true, nomPrenoms: true, telephone: true, carteFidelite: true, cumulFideliteCourant: true, cumulFideliteTotal: true },
    orderBy: { cumulFideliteCourant: "desc" },
  });
  const resultat = candidats
    .map((c) => {
      const palier = paliers.filter((p) => c.cumulFideliteCourant >= p.seuilBas && (p.seuilHaut == null || c.cumulFideliteCourant <= p.seuilHaut)).pop();
      return palier ? { ...c, bonusDisponible: palier.montantBonus } : null;
    })
    .filter(Boolean);
  res.json(resultat);
});

// GET /api/fidelite/bonus-accordes?dateDebut=&dateFin=  — tout ce qui a été "perdu" en bonus sur
// la période, pour ajuster les paliers en connaissance de cause (admin).
router.get("/bonus-accordes", requireAdmin, async (req, res) => {
  const { dateDebut, dateFin } = req.query;
  const plage = dateDebut || dateFin ? {
    gte: dateDebut ? new Date(`${dateDebut}T00:00:00`) : undefined,
    lte: dateFin ? new Date(`${dateFin}T23:59:59`) : undefined,
  } : undefined;
  const bonus = await prisma.bonusFideliteUtilise.findMany({
    where: { createdAt: plage },
    include: { client: { select: { nomPrenoms: true, telephone: true } }, vente: { select: { numero: true, boutique: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ total: bonus.reduce((s, b) => s + b.montant, 0), nombre: bonus.length, bonus });
});

// GET /api/fidelite/clients-par-statut?statut=NomDuStatut — toutes les clientes d'un statut
// donné (admin) ; sans ?statut, renvoie le nombre de clientes par statut.
router.get("/clients-par-statut", requireAdmin, async (req, res) => {
  const paliers = await prisma.palierStatut.findMany({ where: { actif: true }, orderBy: { seuilBas: "asc" } });
  const { statut } = req.query;

  if (!statut) {
    const repartition = await Promise.all(paliers.map(async (p) => ({
      statut: p.nom,
      nombre: await prisma.client.count({
        where: { cumulFideliteTotal: { gte: p.seuilBas, ...(p.seuilHaut != null ? { lte: p.seuilHaut } : {}) } },
      }),
    })));
    return res.json(repartition);
  }

  const palier = paliers.find((p) => p.nom === statut);
  if (!palier) return res.status(404).json({ error: "Statut inconnu." });
  const clients = await prisma.client.findMany({
    where: { cumulFideliteTotal: { gte: palier.seuilBas, ...(palier.seuilHaut != null ? { lte: palier.seuilHaut } : {}) } },
    select: { id: true, nomPrenoms: true, telephone: true, cumulFideliteTotal: true, cumulFideliteCourant: true },
    orderBy: { cumulFideliteTotal: "desc" },
  });
  res.json(clients);
});

// --- Paliers de bonus (réservé à l'administrateur) --------------------------------------
router.get("/paliers-bonus", async (req, res) => {
  res.json(await prisma.palierBonus.findMany({ orderBy: { seuilBas: "asc" } }));
});
router.post("/paliers-bonus", requireAdmin, async (req, res) => {
  const { seuilBas, seuilHaut, montantBonus } = req.body;
  if (seuilBas == null || !montantBonus) return res.status(400).json({ error: "Seuil bas et montant du bonus sont obligatoires." });
  const palier = await prisma.palierBonus.create({
    data: { seuilBas: Number(seuilBas), seuilHaut: seuilHaut != null && seuilHaut !== "" ? Number(seuilHaut) : null, montantBonus: Number(montantBonus) },
  });
  res.status(201).json(palier);
});
router.put("/paliers-bonus/:id", requireAdmin, async (req, res) => {
  const { seuilBas, seuilHaut, montantBonus, actif } = req.body;
  const palier = await prisma.palierBonus.update({
    where: { id: req.params.id },
    data: {
      seuilBas: seuilBas != null ? Number(seuilBas) : undefined,
      seuilHaut: seuilHaut !== undefined ? (seuilHaut === "" || seuilHaut === null ? null : Number(seuilHaut)) : undefined,
      montantBonus: montantBonus != null ? Number(montantBonus) : undefined,
      actif,
    },
  });
  res.json(palier);
});
router.delete("/paliers-bonus/:id", requireAdmin, async (req, res) => {
  await prisma.palierBonus.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// --- Paliers de statut (réservé à l'administrateur) -------------------------------------
router.get("/paliers-statut", async (req, res) => {
  res.json(await prisma.palierStatut.findMany({ orderBy: { seuilBas: "asc" } }));
});
router.post("/paliers-statut", requireAdmin, async (req, res) => {
  const { nom, seuilBas, seuilHaut } = req.body;
  if (!nom?.trim() || seuilBas == null) return res.status(400).json({ error: "Nom et seuil bas sont obligatoires." });
  const palier = await prisma.palierStatut.create({
    data: { nom: nom.trim(), seuilBas: Number(seuilBas), seuilHaut: seuilHaut != null && seuilHaut !== "" ? Number(seuilHaut) : null },
  });
  res.status(201).json(palier);
});
router.put("/paliers-statut/:id", requireAdmin, async (req, res) => {
  const { nom, seuilBas, seuilHaut, actif } = req.body;
  const palier = await prisma.palierStatut.update({
    where: { id: req.params.id },
    data: {
      nom: nom?.trim() || undefined,
      seuilBas: seuilBas != null ? Number(seuilBas) : undefined,
      seuilHaut: seuilHaut !== undefined ? (seuilHaut === "" || seuilHaut === null ? null : Number(seuilHaut)) : undefined,
      actif,
    },
  });
  res.json(palier);
});
router.delete("/paliers-statut/:id", requireAdmin, async (req, res) => {
  await prisma.palierStatut.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// --- Alertes de changement de statut (Dashboard, vendeuses + admin) ---------------------
// GET /api/fidelite/changements-statut — non vus par défaut ; ?tous=1 pour l'historique complet
router.get("/changements-statut", async (req, res) => {
  const changements = await prisma.changementStatutFidelite.findMany({
    where: req.query.tous ? {} : { vu: false },
    include: { client: { select: { nomPrenoms: true, telephone: true } }, vuPar: { select: { nom: true, prenom: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(changements);
});
router.put("/changements-statut/:id/vu", async (req, res) => {
  const changement = await prisma.changementStatutFidelite.update({
    where: { id: req.params.id },
    data: { vu: true, vuParId: req.user.id, dateVu: new Date() },
  });
  res.json(changement);
});

module.exports = router;
