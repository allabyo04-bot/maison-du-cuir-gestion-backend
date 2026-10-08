// Ce script crée les 3 rôles par défaut et un premier compte Administrateur,
// pour que tu puisses te connecter dès le premier déploiement.
// Lancer avec : npm run seed

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const rolesExistants = await prisma.role.count();
  if (rolesExistants > 0) {
    console.log("Des rôles existent déjà — le seed ne fait rien pour éviter d'écraser tes données.");
    return;
  }

  const admin = await prisma.role.create({
    data: {
      nom: "Administrateur", systeme: true,
      permissions: { ventes: true, stock: true, clients: true, rapports: true, utilisateurs: true, configuration: true },
    },
  });
  await prisma.role.create({
    data: {
      nom: "Gérant", systeme: false,
      permissions: { ventes: true, stock: true, clients: true, rapports: true, utilisateurs: false, configuration: false },
    },
  });
  await prisma.role.create({
    data: {
      nom: "Vendeur", systeme: false,
      permissions: { ventes: true, stock: false, clients: true, rapports: false, utilisateurs: false, configuration: false },
    },
  });

  // Compte admin par défaut — À CHANGER IMMÉDIATEMENT après la première connexion
  const pinHash = await bcrypt.hash("1234", 10);
  await prisma.user.create({
    data: {
      nom: "Anaïs", prenom: "Anaïs", login: "anais", pinHash,
      roleId: admin.id, boutique: "Boutique Principale", actif: true,
    },
  });

  console.log("Seed terminé : 3 rôles créés + compte admin 'anais' / PIN '1234'.");
  console.log("IMPORTANT : change ce PIN dès la première connexion.");
}

main().finally(() => prisma.$disconnect());
