// Programme de fidélité "Cendrillon" — logique centralisée, appelée depuis routes/ventes.js au
// moment de la création d'une vente. Voir schema.prisma (Client.cumulFideliteTotal/Courant,
// PalierBonus, PalierStatut, BonusFideliteUtilise) pour le fonctionnement général.

// Le bonus disponible pour une cliente n'est jamais stocké : toujours recalculé depuis son cumul
// courant. Une cliente n'a jamais qu'un seul bonus actif à la fois — si elle franchit un palier
// supérieur avant d'avoir utilisé son bonus, il est réévalué à la hausse, jamais cumulé.
async function bonusDisponible(cumulCourant, tx) {
  const palier = await tx.palierBonus.findFirst({
    where: {
      actif: true,
      seuilBas: { lte: cumulCourant },
      OR: [{ seuilHaut: null }, { seuilHaut: { gte: cumulCourant } }],
    },
    orderBy: { seuilBas: "desc" }, // le palier le plus haut atteint, si plusieurs se chevauchaient par erreur
  });
  return palier ? palier.montantBonus : 0;
}

// Le statut Cendrillon d'une cliente, depuis son cumul total à vie (jamais remis à zéro).
async function statutFidelite(cumulTotal, tx) {
  const palier = await tx.palierStatut.findFirst({
    where: {
      actif: true,
      seuilBas: { lte: cumulTotal },
      OR: [{ seuilHaut: null }, { seuilHaut: { gte: cumulTotal } }],
    },
    orderBy: { seuilBas: "desc" },
  });
  return palier ? palier.nom : null;
}

// Une vente n'alimente les cumuls fidélité que si : c'est un comptant, aucune remise n'a été
// demandée dessus (classique ou supplément d'échange), et aucun article vendu n'est actuellement
// en solde (prix réduit via une campagne active). Toute remise, quelle qu'elle soit, exclut
// l'INTÉGRALITÉ de la vente du cumul — jamais un calcul au prorata.
async function venteEligibleCumul({ demandeRemiseId, articleIds, tx }) {
  if (demandeRemiseId) return false;
  if (articleIds.length === 0) return true;
  const ligneSoldee = await tx.ligneCampagneSolde.findFirst({
    where: { articleId: { in: articleIds }, campagne: { statut: "ACTIVE" } },
  });
  return !ligneSoldee;
}

// À appeler après avoir mis à jour cumulFideliteTotal d'une cliente. Compare le statut d'avant et
// d'après ; si ça change, trace l'événement (pour l'alerte vendeuse/responsable sur le Dashboard)
// et met à jour la référence — jamais déclenché pour l'assignation initiale (dernierStatutNotifie
// déjà renseigné par le script de rattrapage avant l'activation).
async function detecterChangementStatut(client, nouveauCumulTotal, tx) {
  const nouveauStatut = await statutFidelite(nouveauCumulTotal, tx);
  if (!nouveauStatut || nouveauStatut === client.dernierStatutNotifie) return;
  // Une toute première attribution (fiche créée après le rattrapage initial, jamais encore
  // évaluée) n'est pas une PROMOTION — on l'enregistre silencieusement, sans alerte, exactement
  // comme le script de rattrapage l'a fait pour les clientes déjà existantes à l'activation.
  if (client.dernierStatutNotifie != null) {
    await tx.changementStatutFidelite.create({
      data: { clientId: client.id, ancienStatut: client.dernierStatutNotifie, nouveauStatut },
    });
  }
  await tx.client.update({ where: { id: client.id }, data: { dernierStatutNotifie: nouveauStatut } });
}

module.exports = { bonusDisponible, statutFidelite, venteEligibleCumul, detecterChangementStatut };
