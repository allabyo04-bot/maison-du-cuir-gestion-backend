require('dotenv').config();
const prisma = require('../src/prisma');

// Exporte les données importantes de la base. Le mot de passe (pinHash) des
// utilisateurs est volontairement exclu de l'export, même haché.
async function exporterDonnees() {
  const [
    ventes, clients, articles, stocks, depenses, mouvements,
    utilisateurs, vendeurs, roles, bonsValeur, demandesRemise,
    categoriesDepense, budgetsAnnuels, ventesEnAttente,
    creancesHistoriques, campagnesSolde, denominationsCartesCadeaux,
    receptions, clesApiPublique,
  ] = await Promise.all([
    prisma.vente.findMany({ include: { lignes: true, paiements: true, retours: true } }),
    prisma.client.findMany(),
    prisma.article.findMany({ include: { marque: true } }),
    prisma.stockItem.findMany(),
    prisma.depense.findMany(),
    prisma.mouvementStock.findMany(),
    prisma.user.findMany({
      select: {
        id: true, nom: true, prenom: true, login: true, roleId: true,
        boutique: true, actif: true, createdAt: true,
      },
    }),
    prisma.vendeur.findMany(),
    prisma.role.findMany(),
    prisma.bonValeur.findMany(),
    prisma.demandeRemise.findMany(),
    prisma.categorieDepense.findMany(),
    prisma.budgetAnnuel.findMany(),
    prisma.venteAttente.findMany(),
    prisma.creanceHistorique.findMany({ include: { reglements: true } }),
    prisma.campagneSolde.findMany({ include: { lignes: true } }),
    prisma.denominationCarteCadeau.findMany(),
    prisma.reception.findMany({ include: { lignes: true } }),
    // Jamais le hash de la clé — juste de quoi savoir qui a un accès externe, pour audit.
    prisma.cleApiPublique.findMany({ select: { id: true, nom: true, actif: true, derniereUtilisation: true, createdAt: true } }),
  ]);

  return {
    dateExport: new Date().toISOString(),
    ventes, clients, articles, stocks, depenses, mouvements,
    utilisateurs, vendeurs, roles, bonsValeur, demandesRemise,
    categoriesDepense, budgetsAnnuels, ventesEnAttente,
    creancesHistoriques, campagnesSolde, denominationsCartesCadeaux,
    receptions, clesApiPublique,
    // ParametreSecurite (code de confirmation) volontairement exclu — c'est un secret, pas une
    // donnée métier à restaurer ; en cas de restauration, relancer definir-code-confirmation.js.
  };
}

async function envoyerSauvegarde() {
  const donnees = await exporterDonnees();
  const contenu = JSON.stringify(donnees, null, 2);
  const dateTexte = new Date().toISOString().slice(0, 10);
  const contenuBase64 = Buffer.from(contenu, 'utf-8').toString('base64');

  const reponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.BACKUP_RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'La Maison du Cuir Sauvegarde <onboarding@resend.dev>',
      to: [process.env.BACKUP_EMAIL_DESTINATAIRE],
      subject: `Sauvegarde La Maison du Cuir — ${dateTexte}`,
      text: `Sauvegarde automatique des données La Maison du Cuir du ${dateTexte}.\n\nNombre de ventes : ${donnees.ventes.length}\nNombre de clients : ${donnees.clients.length}\nNombre d'articles : ${donnees.articles.length}`,
      attachments: [
        {
          filename: `la-pointure-sauvegarde-${dateTexte}.json`,
          content: contenuBase64,
        },
      ],
    }),
  });

  if (!reponse.ok) {
    const erreurTexte = await reponse.text();
    throw new Error(`Échec de l'envoi (${reponse.status}) : ${erreurTexte}`);
  }

  console.log(`Sauvegarde envoyée avec succès (${dateTexte}).`);
}

envoyerSauvegarde()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Échec de la sauvegarde :', err);
    process.exit(1);
  });