-- CreateTable
CREATE TABLE "Vendeur" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vendeur_pkey" PRIMARY KEY ("id")
);
