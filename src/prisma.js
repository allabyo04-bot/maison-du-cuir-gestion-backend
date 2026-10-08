const { PrismaClient } = require("@prisma/client");

// Une seule instance partagée dans toute l'appli (bonne pratique avec Prisma)
const prisma = new PrismaClient();

module.exports = prisma;
