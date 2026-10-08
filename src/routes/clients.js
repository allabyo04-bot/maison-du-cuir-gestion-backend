const express = require("express");
const prisma = require("../prisma");
const { requireAuth, requirePermission } = require("../middleware/auth");
const { consignerAudit } = require("../journalAudit");

const router = express.Router();
router.use(requireAuth, requirePermission("clients"));

function nettoyerTelephone(tel) {
  return tel ? tel.replace(/[\s\-]/g, "") : tel;
}
function chiffresSeuls(s) {
  return (s || "").replace(/\D/g, "");
}
// "10 chiffres" est une règle spécifique à la Côte d'Ivoire (confirmée). D'autres pays ont
// encore des numéros locaux à 8 chiffres — on reste large pour eux plutôt que de bloquer à
// tort un numéro en réalité correct.
function nombreDeChiffresValide(numero, pays) {
  const n = chiffresSeuls(numero).length;
  if (pays === "Côte d'Ivoire") return n === 10;
  return n >= 8 && n <= 11;
}
async function generateClientCode() {
  const existants = await prisma.client.findMany({ select: { code: true } });
  const used = new Set(existants.map((c) => parseInt((c.code || "").split("-")[1], 10)).filter((n) => !isNaN(n)));
  let n = 1;
  while (used.has(n)) n++;
  return `CLI-${String(n).padStart(6, "0")}`;
}

router.get("/", async (req, res) => {
  const clients = await prisma.client.findMany({
    orderBy: { createdAt: "desc" },
    include: { creePar: { select: { nom: true, prenom: true } } },
  });
  res.json(clients);
});

// GET /api/clients/recherche?carte=XXXX — pour l'état "achats par carte de fidélité"
router.get("/recherche", async (req, res) => {
  const { carte } = req.query;
  if (!carte) return res.status(400).json({ error: "Numéro de carte requis." });
  const client = await prisma.client.findUnique({
    where: { carteFidelite: carte },
    include: { ventes: { include: { lignes: true, paiements: true }, orderBy: { date: "desc" } } },
  });
  if (!client) return res.status(404).json({ error: "Aucun client ne correspond à ce numéro de carte." });
  res.json(client);
});

// GET /api/clients/recherche-multi?q=  — recherche élargie par nom, téléphone, WhatsApp ou
// carte de fidélité (contient, insensible à la casse) — pour l'historique d'achats quand on
// ne connaît pas forcément le numéro de carte exact. Renvoie une liste courte (pas le détail).
router.get("/recherche-multi", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Un nom, téléphone ou numéro de carte est requis." });
  const clients = await prisma.client.findMany({
    where: {
      OR: [
        { nomPrenoms: { contains: q, mode: "insensitive" } },
        { telephone: { contains: q } },
        { whatsapp: { contains: q } },
        { carteFidelite: { contains: q } },
      ],
    },
    select: { id: true, nomPrenoms: true, telephone: true, carteFidelite: true, ville: true },
    take: 15,
    orderBy: { nomPrenoms: "asc" },
  });
  res.json(clients);
});

// GET /api/clients/:id/historique-achats — historique d'achats d'un client précis, qu'il ait
// ou non une carte de fidélité (contrairement à /recherche qui exige une carte).
router.get("/:id/historique-achats", async (req, res) => {
  const client = await prisma.client.findUnique({
    where: { id: req.params.id },
    include: { ventes: { include: { lignes: true, paiements: true }, orderBy: { date: "desc" } } },
  });
  if (!client) return res.status(404).json({ error: "Client introuvable." });
  res.json(client);
});

router.post("/", async (req, res) => {
  const body = req.body;
  if (!body.nomPrenoms?.trim()) return res.status(400).json({ error: "Le nom et prénoms du client sont obligatoires." });
  if (!body.telephone?.trim()) return res.status(400).json({ error: "Le numéro de téléphone du client est obligatoire." });
  if (!nombreDeChiffresValide(body.telephone, body.pays)) {
    return res.status(400).json({ error: `Le numéro de téléphone semble incorrect pour ${body.pays || "ce pays"} (${chiffresSeuls(body.telephone).length} chiffres actuellement).` });
  }
  if (body.whatsapp?.trim() && !nombreDeChiffresValide(body.whatsapp, body.pays)) {
    return res.status(400).json({ error: `Le numéro WhatsApp semble incorrect pour ${body.pays || "ce pays"} (${chiffresSeuls(body.whatsapp).length} chiffres actuellement).` });
  }

  const telephoneNettoye = nettoyerTelephone(body.telephone.trim());
  const conflit = await prisma.client.findUnique({ where: { telephone: telephoneNettoye } });
  if (conflit) return res.status(409).json({ error: "Ce numéro de téléphone est déjà enregistré pour un autre client." });

  if (body.carteFidelite?.trim()) {
    const conflitCarte = await prisma.client.findUnique({ where: { carteFidelite: body.carteFidelite.trim() } });
    if (conflitCarte) return res.status(409).json({ error: "Ce numéro de carte de fidélité est déjà attribué à un autre client." });
  }

  const code = await generateClientCode();
  const client = await prisma.client.create({
    data: {
      code,
      nomPrenoms: body.nomPrenoms.trim(),
      jourAnniv: body.jourAnniv, moisAnniv: body.moisAnniv, civilite: body.civilite,
      adresse: body.adresse, ville: body.ville, commune: body.commune, quartier: body.quartier,
      telephone: telephoneNettoye, whatsapp: body.whatsapp,
      pointure: body.pointure, pays: body.pays,
      carteFidelite: body.carteFidelite?.trim() || null,
      dateDelivrance: body.dateDelivrance ? new Date(body.dateDelivrance) : null,
      observation: body.observation,
      creeParId: req.user.id,
    },
  });
  res.status(201).json(client);
});

router.put("/:id", async (req, res) => {
  const body = req.body;
  if (!body.nomPrenoms?.trim()) return res.status(400).json({ error: "Le nom et prénoms du client sont obligatoires." });
  if (!body.telephone?.trim()) return res.status(400).json({ error: "Le numéro de téléphone du client est obligatoire." });
  if (!nombreDeChiffresValide(body.telephone, body.pays)) {
    return res.status(400).json({ error: `Le numéro de téléphone semble incorrect pour ${body.pays || "ce pays"} (${chiffresSeuls(body.telephone).length} chiffres actuellement).` });
  }
  if (body.whatsapp?.trim() && !nombreDeChiffresValide(body.whatsapp, body.pays)) {
    return res.status(400).json({ error: `Le numéro WhatsApp semble incorrect pour ${body.pays || "ce pays"} (${chiffresSeuls(body.whatsapp).length} chiffres actuellement).` });
  }

  const telephoneNettoye = nettoyerTelephone(body.telephone.trim());
  const conflit = await prisma.client.findFirst({ where: { telephone: telephoneNettoye, NOT: { id: req.params.id } } });
  if (conflit) return res.status(409).json({ error: "Ce numéro de téléphone est déjà enregistré pour un autre client." });

  if (body.carteFidelite?.trim()) {
    const conflitCarte = await prisma.client.findFirst({ where: { carteFidelite: body.carteFidelite.trim(), NOT: { id: req.params.id } } });
    if (conflitCarte) return res.status(409).json({ error: "Ce numéro de carte de fidélité est déjà attribué à un autre client." });
  }

  const client = await prisma.client.update({
    where: { id: req.params.id },
    data: {
      nomPrenoms: body.nomPrenoms.trim(),
      jourAnniv: body.jourAnniv, moisAnniv: body.moisAnniv, civilite: body.civilite,
      adresse: body.adresse, ville: body.ville, commune: body.commune, quartier: body.quartier,
      telephone: telephoneNettoye, whatsapp: body.whatsapp,
      pointure: body.pointure, pays: body.pays,
      carteFidelite: body.carteFidelite?.trim() || null,
      dateDelivrance: body.dateDelivrance ? new Date(body.dateDelivrance) : null,
      observation: body.observation,
    },
  });
  res.json(client);
});

router.delete("/:id", async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  await prisma.client.delete({ where: { id: req.params.id } });
  if (client) {
    await consignerAudit({
      action: "SUPPRESSION", cible: `Client : ${client.nomPrenoms} (${client.code})`,
      detail: client.telephone ? `Téléphone : ${client.telephone}` : null,
      utilisateurId: req.user.id, boutique: req.user.boutique,
    });
  }
  res.status(204).end();
});

module.exports = router;