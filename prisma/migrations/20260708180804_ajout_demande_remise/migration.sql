/*
  Warnings:

  - A unique constraint covering the columns `[demandeRemiseId]` on the table `Vente` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Vente" ADD COLUMN     "demandeRemiseId" TEXT,
ADD COLUMN     "montantRemise" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "DemandeRemise" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "demandeParId" TEXT NOT NULL,
    "clientNom" TEXT,
    "totalVente" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "valeur" INTEGER NOT NULL,
    "montantRemise" INTEGER NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'EN_ATTENTE',
    "traiteParId" TEXT,
    "dateTraitement" TIMESTAMP(3),
    "utilisee" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandeRemise_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DemandeRemise_numero_key" ON "DemandeRemise"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "Vente_demandeRemiseId_key" ON "Vente"("demandeRemiseId");

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_demandeRemiseId_fkey" FOREIGN KEY ("demandeRemiseId") REFERENCES "DemandeRemise"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandeRemise" ADD CONSTRAINT "DemandeRemise_demandeParId_fkey" FOREIGN KEY ("demandeParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandeRemise" ADD CONSTRAINT "DemandeRemise_traiteParId_fkey" FOREIGN KEY ("traiteParId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
