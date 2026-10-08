// Script à lancer UNIQUEMENT si le code de confirmation a été oublié (par toi ET Djenie).
// Comme le script initial, il s'exécute directement sur la base de données — accessible
// seulement à toi (celui qui a les identifiants de connexion sur ton PC), ce qui reste un
// niveau de sécurité suffisant pour autoriser cette réinitialisation d'urgence.
//
// Usage : node scripts/reinitialiser-code-confirmation.js "NouveauCodeSecret123"
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const nouveauCode = process.argv[2];
  if (!nouveauCode || nouveauCode.length < 6) {
    console.error("Usage : node scripts/reinitialiser-code-confirmation.js \"NouveauCodeSecret123\" (6 caractères minimum)");
    process.exit(1);
  }

  const codeConfirmationHash = await bcrypt.hash(nouveauCode, 10);
  const existant = await prisma.parametreSecurite.findFirst();

  if (existant) {
    await prisma.parametreSecurite.update({ where: { id: existant.id }, data: { codeConfirmationHash } });
    console.log("Code de confirmation réinitialisé avec succès (l'ancien code ne fonctionne plus).");
  } else {
    await prisma.parametreSecurite.create({ data: { codeConfirmationHash } });
    console.log("Code de confirmation défini avec succès (aucun code n'existait encore).");
  }
  console.log("Retiens-le bien (toi et Djenie uniquement) — il est exigé pour créer/modifier/supprimer un utilisateur ou un rôle.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
