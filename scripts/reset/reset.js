// Reset des données de test avant le lancement réel.
// Efface : articles, stock, ventes, clients, retours, avoirs/cartes cadeaux, remises,
//          ventes en attente, mouvements de stock, marques, dépenses et catégories.
// Garde : utilisateurs (comptes de connexion), rôles, vendeuses.
//
// Usage :
//   node reset.js               -> mode TEST (affiche ce qui sera effacé, sans rien effacer)
//   node reset.js --confirmer   -> efface réellement

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const prisma = require("../../src/prisma");

const CONFIRMER = process.argv.includes("--confirmer");

async function main() {
  console.log(`\n=== Reset données de test — mode ${CONFIRMER ? "RÉEL (suppression)" : "TEST (aucune suppression)"} ===\n`);

  const compte = async (modele) => await prisma[modele].count();

  const counts = {
    mouvementStock: await compte("mouvementStock"),
    retour: await compte("retour"),
    paiement: await compte("paiement"),
    ligneVente: await compte("ligneVente"),
    vente: await compte("vente"),
    venteAttente: await compte("venteAttente"),
    bonValeur: await compte("bonValeur"),
    demandeRemise: await compte("demandeRemise"),
    client: await compte("client"),
    stockItem: await compte("stockItem"),
    article: await compte("article"),
    brand: await compte("brand"),
    depense: await compte("depense"),
    categorieDepense: await compte("categorieDepense"),
    budgetAnnuel: await compte("budgetAnnuel"),
  };

  console.log("Éléments qui seront effacés :");
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k} : ${v}`));

  const conserve = {
    user: await compte("user"),
    role: await compte("role"),
    vendeur: await compte("vendeur"),
  };
  console.log("\nÉléments CONSERVÉS :");
  Object.entries(conserve).forEach(([k, v]) => console.log(`  ${k} : ${v}`));

  if (!CONFIRMER) {
    console.log("\n--- MODE TEST : rien n'a été effacé. Relance avec --confirmer pour appliquer. ---\n");
    return;
  }

  console.log("\nSuppression en cours...");
  await prisma.$transaction([
    prisma.mouvementStock.deleteMany({}),
    prisma.retour.deleteMany({}),
    prisma.paiement.deleteMany({}),
    prisma.ligneVente.deleteMany({}),
    prisma.vente.deleteMany({}),
    prisma.venteAttente.deleteMany({}),
    prisma.bonValeur.deleteMany({}),
    prisma.demandeRemise.deleteMany({}),
    prisma.client.deleteMany({}),
    prisma.stockItem.deleteMany({}),
    prisma.article.deleteMany({}),
    prisma.brand.deleteMany({}),
    prisma.depense.deleteMany({}),
    prisma.budgetAnnuel.deleteMany({}),
    prisma.categorieDepense.deleteMany({}),
  ]);

  console.log("\n=== Reset terminé. Base prête pour l'import définitif. ===\n");
}

main()
  .catch((e) => { console.error("Erreur pendant le reset :", e); process.exit(1); })
  .finally(() => prisma.$disconnect());