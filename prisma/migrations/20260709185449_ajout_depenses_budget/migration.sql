-- CreateTable
CREATE TABLE "CategorieDepense" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategorieDepense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Depense" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boutique" TEXT NOT NULL,
    "categorieId" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "effectueParId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Depense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetAnnuel" (
    "id" TEXT NOT NULL,
    "categorieId" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "montantPrevisionnel" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetAnnuel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CategorieDepense_nom_key" ON "CategorieDepense"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetAnnuel_categorieId_annee_key" ON "BudgetAnnuel"("categorieId", "annee");

-- AddForeignKey
ALTER TABLE "Depense" ADD CONSTRAINT "Depense_categorieId_fkey" FOREIGN KEY ("categorieId") REFERENCES "CategorieDepense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Depense" ADD CONSTRAINT "Depense_effectueParId_fkey" FOREIGN KEY ("effectueParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetAnnuel" ADD CONSTRAINT "BudgetAnnuel_categorieId_fkey" FOREIGN KEY ("categorieId") REFERENCES "CategorieDepense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
