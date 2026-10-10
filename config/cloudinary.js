const cloudinary = require('cloudinary').v2;

// Si CLOUDINARY_URL est définie (format "cloudinary://CLE:SECRET@NOM_DU_NUAGE", copiée telle
// quelle depuis le tableau de bord Cloudinary), le SDK la lit automatiquement ici — c'est la
// méthode la plus fiable car elle élimine tout risque de faute de frappe en recopiant trois
// valeurs séparément. Sinon, on retombe sur les trois variables individuelles.
function diagnostiquer(label, valeur) {
  if (!valeur) { console.log(label, "— VIDE/absente"); return; }
  const codes = [...valeur].map((c) => c.charCodeAt(0));
  console.log(label, JSON.stringify(valeur), "| longueur:", valeur.length, "| codes:", codes.join(","));
}

if (process.env.CLOUDINARY_URL) {
  diagnostiquer("CLOUDINARY_URL brute reçue :", process.env.CLOUDINARY_URL);
  cloudinary.config();
  const cfg = cloudinary.config();
  diagnostiquer("→ cloud_name extrait :", cfg.cloud_name);
  diagnostiquer("→ api_key extrait :", cfg.api_key);
} else {
  diagnostiquer("CLOUDINARY_CLOUD_NAME brute :", process.env.CLOUDINARY_CLOUD_NAME);
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

module.exports = cloudinary;
