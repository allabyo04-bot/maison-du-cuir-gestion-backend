-- CreateTable
CREATE TABLE "CreanceHistorique" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "montantTotal" INTEGER NOT NULL,
    "montantDejaPaye" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreanceHistorique_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreanceReglement" (
    "id" TEXT NOT NULL,
    "creanceId" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "effectueParId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreanceReglement_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CreanceHistorique" ADD CONSTRAINT "CreanceHistorique_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreanceReglement" ADD CONSTRAINT "CreanceReglement_creanceId_fkey" FOREIGN KEY ("creanceId") REFERENCES "CreanceHistorique"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreanceReglement" ADD CONSTRAINT "CreanceReglement_effectueParId_fkey" FOREIGN KEY ("effectueParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
