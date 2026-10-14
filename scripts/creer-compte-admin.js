// Crée un compte avec le rôle Administrateur (mêmes droits qu'Anaïs).
// Usage : node scripts/creer-compte-admin.js <prenom> <nom> <login> <pin4chiffres>
// Exemple : node scripts/creer-compte-admin.js Phil ALLABY phil 1234
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [prenom, nom, login, pin] = process.argv.slice(2);
  if (!prenom || !nom || !login || !/^\d{4}$/.test(pin || "")) {
    console.error("Usage : node scripts/creer-compte-admin.js <prenom> <nom> <login> <pin4chiffres>");
    process.exit(1);
  }

  const dejaExistant = await prisma.user.findUnique({ where: { login } });
  if (dejaExistant) {
    console.error(`L'identifiant "${login}" existe déjà. Choisis-en un autre, ou utilise reinitialiser-pin.js si c'est bien ce compte.`);
    process.exit(1);
  }

  const roleAdmin = await prisma.role.findFirst({ where: { systeme: true } });
  if (!roleAdmin) {
    console.error("Aucun rôle Administrateur trouvé en base — lance d'abord 'npm run seed'.");
    process.exit(1);
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const utilisateur = await prisma.user.create({
    data: { nom, prenom, login, pinHash, roleId: roleAdmin.id, boutique: "Boutique Principale", actif: true },
  });

  console.log(`Compte créé : ${utilisateur.prenom} ${utilisateur.nom} — identifiant "${login}", rôle Administrateur.`);
  console.log(`PIN : ${pin} — à changer dès la première connexion (Paramètres → Mon profil).`);
}

main().finally(() => prisma.$disconnect());
