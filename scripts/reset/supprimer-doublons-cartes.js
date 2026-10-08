require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const prisma = require("../../src/prisma");

const CONFIRMER = process.argv.includes("--confirmer");
const A_SUPPRIMER = ["CG-0003", "0071-0087"];

async function main() {
  console.log(`\n=== Suppression doublons cartes cadeaux — mode ${CONFIRMER ? "RÉEL" : "TEST"} ===\n`);

  for (const numero of A_SUPPRIMER) {
    const carte = await prisma.bonValeur.findUnique({ where: { numero } });
    if (!carte) { console.log(`  ${numero} : introuvable, déjà supprimée ou n'existe pas.`); continue; }
    if (carte.utilisee) { console.log(`  ⚠ ${numero} : DÉJÀ UTILISÉE — ignorée, ne pas supprimer une carte déjà consommée.`); continue; }
    console.log(`  ${numero} : trouvée, montant ${carte.montant} F, ${CONFIRMER ? "suppression..." : "serait supprimée"}`);
    if (CONFIRMER) await prisma.bonValeur.delete({ where: { numero } });
  }

  console.log(CONFIRMER ? "\n=== Terminé. ===\n" : "\n--- MODE TEST : rien n'a été supprimé. Relance avec --confirmer. ---\n");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());