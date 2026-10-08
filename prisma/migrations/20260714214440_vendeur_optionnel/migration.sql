-- DropForeignKey
ALTER TABLE "Vente" DROP CONSTRAINT "Vente_vendeurId_fkey";

-- AlterTable
ALTER TABLE "Vente" ALTER COLUMN "vendeurId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_vendeurId_fkey" FOREIGN KEY ("vendeurId") REFERENCES "Vendeur"("id") ON DELETE SET NULL ON UPDATE CASCADE;
