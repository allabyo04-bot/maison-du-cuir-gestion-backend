const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const CATEGORIES = [
  "Locaux", "Personnel", "Stock", "Fonctionnement", "Marketing",
  "Informatique", "Matériel", "Transport", "Banque", "Sécurité",
  "Entretien", "Fiscalité", "Divers",
];

async function main() {
  let crees = 0;
  for (const nom of CATEGORIES) {
    const existe = await prisma.categorieDepense.findUnique({ where: { nom } });
    if (!existe) {
      await prisma.categorieDepense.create({ data: { nom } });
      crees++;
    }
  }
  console.log(`${crees} categorie(s) creee(s) sur ${CATEGORIES.length}.`);
  await prisma.$disconnect();
}
main();