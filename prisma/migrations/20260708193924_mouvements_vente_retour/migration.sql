-- AlterTable
ALTER TABLE "MouvementStock" ADD COLUMN     "retourId" TEXT,
ADD COLUMN     "venteId" TEXT;

-- AddForeignKey
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_retourId_fkey" FOREIGN KEY ("retourId") REFERENCES "Retour"("id") ON DELETE SET NULL ON UPDATE CASCADE;
