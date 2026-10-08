/*
  Warnings:

  - Added the required column `caissierId` to the `Vente` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Vente" DROP CONSTRAINT "Vente_vendeurId_fkey";

-- AlterTable
ALTER TABLE "Vente" ADD COLUMN     "caissierId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_caissierId_fkey" FOREIGN KEY ("caissierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_vendeurId_fkey" FOREIGN KEY ("vendeurId") REFERENCES "Vendeur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
