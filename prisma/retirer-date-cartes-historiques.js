// À lancer une seule fois, à la demande de l'utilisateur (04/10/2026) : retire la date de
// validité du 01/12/2026 sur toutes les cartes cadeaux HISTORIQUES qui la portent — saisie
// manuellement de façon répétée, probablement par habitude pendant une session de saisie
// groupée. Ne touche ni aux cartes non-historiques, ni aux avoirs, ni à aucune autre date.
//   node prisma/retirer-date-cartes-historiques.js
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const debut = new Date("2026-12-01T00:00:00.000Z");
  const fin = new Date("2026-12-01T23:59:59.999Z");

  const concernees = await prisma.bonValeur.findMany({
    where: { type: "CADEAU", modePaiement: null, dateValidite: { gte: debut, lte: fin } },
    select: { id: true, numero: true },
  });
  console.log(`${concernees.length} carte(s) historique(s) trouvée(s) avec la date du 01/12/2026.`);

  if (concernees.length > 0) {
    const { count } = await prisma.bonValeur.updateMany({
      where: { id: { in: concernees.map((c) => c.id) } },
      data: { dateValidite: null },
    });
    console.log(`${count} carte(s) mise(s) à jour — elles affichent désormais "Sans expiration".`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
