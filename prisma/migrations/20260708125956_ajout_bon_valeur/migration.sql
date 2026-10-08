/*
  Warnings:

  - You are about to drop the column `carteCadeauId` on the `Paiement` table. All the data in the column will be lost.
  - You are about to drop the `CarteCadeau` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Paiement" DROP CONSTRAINT "Paiement_carteCadeauId_fkey";

-- AlterTable
ALTER TABLE "Paiement" DROP COLUMN "carteCadeauId",
ADD COLUMN     "bonValeurId" TEXT;

-- DropTable
DROP TABLE "CarteCadeau";

-- CreateTable
CREATE TABLE "BonValeur" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "dateValidite" TIMESTAMP(3),
    "utilisee" BOOLEAN NOT NULL DEFAULT false,
    "utiliseeVenteId" TEXT,
    "clientId" TEXT,
    "retourOrigineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BonValeur_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BonValeur_numero_key" ON "BonValeur"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "BonValeur_retourOrigineId_key" ON "BonValeur"("retourOrigineId");

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_bonValeurId_fkey" FOREIGN KEY ("bonValeurId") REFERENCES "BonValeur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BonValeur" ADD CONSTRAINT "BonValeur_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BonValeur" ADD CONSTRAINT "BonValeur_retourOrigineId_fkey" FOREIGN KEY ("retourOrigineId") REFERENCES "Retour"("id") ON DELETE SET NULL ON UPDATE CASCADE;
