// À lancer une seule fois, après le correctif du 04/10/2026 : supprime les alertes de
// changement de statut créées à tort pour une toute première attribution (ancienStatut null),
// qui ne sont pas de vraies promotions. Les vraies promotions (ancienStatut renseigné) ne sont
// jamais touchées.
//   node prisma/cleanup-faux-changements-statut.js
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const { count } = await prisma.changementStatutFidelite.deleteMany({ where: { ancienStatut: null } });
  console.log(`${count} fausse(s) alerte(s) supprimée(s) (premières attributions, pas de vraies promotions).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
