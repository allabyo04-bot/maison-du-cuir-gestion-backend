// Diagnostic : vérifie exactement ce qui est enregistré pour un compte, et teste le PIN donné
// contre le hash stocké, pour voir s'ils correspondent réellement.
// Usage : node scripts/diagnostic-pin.js <login> <pinÀTester>
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const [login, pin] = process.argv.slice(2);
  if (!login || !pin) {
    console.error("Usage : node scripts/diagnostic-pin.js <login> <pinÀTester>");
    process.exit(1);
  }

  console.log("Connecté à la base :", process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@"));

  const tous = await prisma.user.findMany({ select: { login: true, actif: true, nom: true, prenom: true } });
  console.log(`\nComptes trouvés en base (${tous.length}) :`, tous.map((u) => `${u.login}${u.actif ? "" : " (inactif)"}`).join(", "));

  const utilisateur = await prisma.user.findUnique({ where: { login } });
  if (!utilisateur) {
    console.log(`\nAucun compte avec l'identifiant "${login}" dans CETTE base.`);
    process.exit(0);
  }

  console.log(`\nCompte "${login}" trouvé : ${utilisateur.prenom} ${utilisateur.nom}, actif = ${utilisateur.actif}`);
  console.log("Hash stocké (début) :", utilisateur.pinHash.slice(0, 20) + "...");

  const correspond = await bcrypt.compare(pin, utilisateur.pinHash);
  console.log(`\nLe PIN "${pin}" correspond au hash stocké ? → ${correspond ? "OUI" : "NON"}`);
}

main().finally(() => prisma.$disconnect());
