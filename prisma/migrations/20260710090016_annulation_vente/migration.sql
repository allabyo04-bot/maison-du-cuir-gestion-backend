-- AlterTable
ALTER TABLE "Paiement" ADD COLUMN     "viaReglement" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Vente" ADD COLUMN     "annuleeParId" TEXT,
ADD COLUMN     "dateAnnulation" TIMESTAMP(3),
ADD COLUMN     "motifAnnulation" TEXT,
ADD COLUMN     "statut" TEXT NOT NULL DEFAULT 'Validee';

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_annuleeParId_fkey" FOREIGN KEY ("annuleeParId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
