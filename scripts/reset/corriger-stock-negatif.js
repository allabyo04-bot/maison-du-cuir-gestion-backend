// Ramène à 0 toutes les lignes de stock négatives (héritage Abigescom).
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const prisma = require("../../src/prisma");

const CONFIRMER = process.argv.includes("--confirmer");

async function main() {
  const negatifs = await prisma.stockItem.findMany({
    where: { quantite: { lt: 0 } },
    include: { article: true },
  });

  console.log(`\n=== Correction stock négatif — mode ${CONFIRMER ? "RÉEL" : "TEST"} ===\n`);
  console.log(`Lignes en négatif trouvées : ${negatifs.length}\n`);
  negatifs.forEach((s) => console.log(`  ${s.article.designation} · ${s.boutique} · T${s.pointure} : ${s.quantite} → 0`));

  if (!CONFIRMER) {
    console.log("\n--- MODE TEST : rien n'a été modifié. Relance avec --confirmer. ---\n");
    return;
  }

  for (const s of negatifs) {
    await prisma.stockItem.update({ where: { id: s.id }, data: { quantite: 0 } });
  }
  console.log(`\n=== ${negatifs.length} ligne(s) corrigée(s) à 0. ===\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());