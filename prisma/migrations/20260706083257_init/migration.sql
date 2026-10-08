-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "systeme" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "prenom" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "nom" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "famille" TEXT NOT NULL,
    "marqueId" TEXT NOT NULL,
    "prixVente" INTEGER NOT NULL,
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "pointure" TEXT,
    "quantite" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "nomPrenoms" TEXT NOT NULL,
    "jourAnniv" TEXT NOT NULL,
    "moisAnniv" TEXT NOT NULL,
    "civilite" TEXT NOT NULL,
    "adresse" TEXT,
    "commune" TEXT,
    "quartier" TEXT,
    "telephone" TEXT,
    "whatsapp" TEXT,
    "pointure" TEXT,
    "pays" TEXT,
    "carteFidelite" TEXT,
    "dateDelivrance" TIMESTAMP(3),
    "observation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vente" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "boutique" TEXT NOT NULL,
    "modeVente" TEXT NOT NULL,
    "vendeurId" TEXT NOT NULL,
    "clientId" TEXT,
    "total" INTEGER NOT NULL,
    "monnaieRendue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Vente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LigneVente" (
    "id" TEXT NOT NULL,
    "venteId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "designation" TEXT NOT NULL,
    "marque" TEXT NOT NULL,
    "famille" TEXT NOT NULL,
    "pointure" TEXT,
    "quantite" INTEGER NOT NULL,
    "prixUnitaire" INTEGER NOT NULL,
    "sousTotal" INTEGER NOT NULL,

    CONSTRAINT "LigneVente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Paiement" (
    "id" TEXT NOT NULL,
    "venteId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "carteCadeauId" TEXT,

    CONSTRAINT "Paiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Retour" (
    "id" TEXT NOT NULL,
    "venteId" TEXT NOT NULL,
    "ligneVenteId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "nouvellePointure" TEXT,
    "motif" TEXT,
    "boutique" TEXT NOT NULL,
    "traiteParId" TEXT NOT NULL,
    "montantRembourse" INTEGER,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Retour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VenteAttente" (
    "id" TEXT NOT NULL,
    "boutique" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "clientId" TEXT,
    "vendeurId" TEXT NOT NULL,
    "modeVente" TEXT NOT NULL,
    "panier" JSONB NOT NULL,
    "paiements" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VenteAttente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarteCadeau" (
    "id" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,
    "dateExpiration" TIMESTAMP(3),
    "utilisee" BOOLEAN NOT NULL DEFAULT false,
    "utiliseeVenteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CarteCadeau_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_nom_key" ON "Brand"("nom");

-- CreateIndex
CREATE UNIQUE INDEX "Article_reference_key" ON "Article"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "StockItem_articleId_boutique_pointure_key" ON "StockItem"("articleId", "boutique", "pointure");

-- CreateIndex
CREATE UNIQUE INDEX "Client_code_key" ON "Client"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Client_telephone_key" ON "Client"("telephone");

-- CreateIndex
CREATE UNIQUE INDEX "Client_carteFidelite_key" ON "Client"("carteFidelite");

-- CreateIndex
CREATE UNIQUE INDEX "Vente_numero_key" ON "Vente"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "CarteCadeau_numero_key" ON "CarteCadeau"("numero");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_marqueId_fkey" FOREIGN KEY ("marqueId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_vendeurId_fkey" FOREIGN KEY ("vendeurId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneVente" ADD CONSTRAINT "LigneVente_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneVente" ADD CONSTRAINT "LigneVente_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Paiement" ADD CONSTRAINT "Paiement_carteCadeauId_fkey" FOREIGN KEY ("carteCadeauId") REFERENCES "CarteCadeau"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Retour" ADD CONSTRAINT "Retour_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Retour" ADD CONSTRAINT "Retour_ligneVenteId_fkey" FOREIGN KEY ("ligneVenteId") REFERENCES "LigneVente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Retour" ADD CONSTRAINT "Retour_traiteParId_fkey" FOREIGN KEY ("traiteParId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
