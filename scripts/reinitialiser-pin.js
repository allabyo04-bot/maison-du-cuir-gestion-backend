// Script à lancer quand quelqu'un a oublié son PIN. S'exécute directement sur la base de
// données — accessible seulement à toi (celui qui a les identifiants de connexion sur ton PC),
// ce qui reste un niveau de sécurité suffisant pour cette réinitialisation d'urgence.
//
// Usage : node scripts/reinitialiser-pin.js <login> <nouveauPin>
// Exemple : node scripts/reinitialiser-pin.js anais 5678
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [login, nouveauPin] = process.argv.slice(2);
  if (!login || !nouveauPin || !/^\d{4}$/.test(nouveauPin)) {
    console.error('Usage : node scripts/reinitialiser-pin.js <login> <nouveauPin à 4 chiffres>');
    process.exit(1);
  }

  const utilisateur = await prisma.user.findUnique({ where: { login } });
  if (!utilisateur) {
    console.error(`Aucun utilisateur avec l'identifiant "${login}".`);
    process.exit(1);
  }

  const pinHash = await bcrypt.hash(nouveauPin, 10);
  await prisma.user.update({ where: { login }, data: { pinHash } });

  console.log(`PIN réinitialisé avec succès pour "${login}" (${utilisateur.prenom} ${utilisateur.nom}).`);
  console.log(`Nouveau PIN : ${nouveauPin} — à communiquer à la personne concernée, qui devrait le changer elle-même ensuite.`);
}

main().finally(() => prisma.$disconnect());
