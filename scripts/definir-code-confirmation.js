// Script à lancer UNE SEULE FOIS pour créer le tout premier code de confirmation.
// Usage : node scripts/definir-code-confirmation.js "MonCodeSecret123"
//
// Ensuite, pour CHANGER le code, ne pas relancer ce script — utiliser plutôt l'appli
// (ou l'API POST /api/securite/changer-code) qui exige l'ancien code.
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const nouveauCode = process.argv[2];
  if (!nouveauCode || nouveauCode.length < 6) {
    console.error("Usage : node scripts/definir-code-confirmation.js \"MonCodeSecret123\" (6 caractères minimum)");
    process.exit(1);
  }

  const existant = await prisma.parametreSecurite.findFirst();
  if (existant) {
    console.error("Un code de confirmation existe déjà. Ce script ne sert qu'à la première mise en place.");
    console.error("Pour le changer, utilise l'appli (Sécurité) ou l'API POST /api/securite/changer-code.");
    process.exit(1);
  }

  const codeConfirmationHash = await bcrypt.hash(nouveauCode, 10);
  await prisma.parametreSecurite.create({ data: { codeConfirmationHash } });
  console.log("Code de confirmation défini avec succès.");
  console.log("Retiens-le bien (toi et Djenie uniquement) — il est exigé pour créer/modifier/supprimer un utilisateur ou un rôle.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
