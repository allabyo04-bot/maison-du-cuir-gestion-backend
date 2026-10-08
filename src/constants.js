const FAMILLES = ["Chaussure", "Sac", "Article d'entretien"];
// Anaïs n'a pas de boutique physique pour l'instant — une seule entrée ; à adapter si un point
// de vente physique ouvre plus tard (voir aussi src/constants.js du frontend).
const BOUTIQUES = ["Boutique Principale"];
const POINTURES = ["35", "36", "36.5", "37", "37.5", "38", "38.5", "39", "39.5", "40", "40.5", "41", "41.5", "42", "42.5", "43", "43.5", "44", "44.5", "45", "45.5", "46", "46.5", "47", "47.5", "48"];

// Génère la base de la référence d'un article : 3 lettres de la marque + 2 lettres de la famille.
// Exemple : Hispanitas + Chaussure -> "HISCH"
function refBase(marqueNom, famille) {
  const lettresMarque = (marqueNom || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, "X");
  const lettresFamille = famille === "Chaussure" ? "CH" : famille === "Sac" ? "SA" : famille === "Article d'entretien" ? "EN" : "XX";
  return lettresMarque + lettresFamille;
}

// Interrupteur temporaire — même nom que côté frontend (src/constants.js du frontend). Contrairement
// à ce qui suffisait pour Livraison en son temps, cacher juste l'écran ne suffit pas ici : la
// déduction du bonus a un effet réel sur l'argent encaissé, il faut donc aussi bloquer l'ACTION
// elle-même côté serveur, pas seulement son affichage. Les cumuls, eux, continuent d'être calculés
// en coulisse même à false (aucun impact sur l'argent, ça prépare juste la donnée pour plus tard).
const FIDELITE_ACTIF = false;

module.exports = { FAMILLES, BOUTIQUES, POINTURES, refBase, FIDELITE_ACTIF };