const cloudinary = require('cloudinary').v2;

// Si CLOUDINARY_URL est définie (format "cloudinary://CLE:SECRET@NOM_DU_NUAGE", copiée telle
// quelle depuis le tableau de bord Cloudinary), le SDK la lit automatiquement ici — c'est la
// méthode la plus fiable car elle élimine tout risque de faute de frappe en recopiant trois
// valeurs séparément. Sinon, on retombe sur les trois variables individuelles.
if (process.env.CLOUDINARY_URL) {
  cloudinary.config();
  console.log("Cloudinary configuré via CLOUDINARY_URL, cloud_name détecté :", cloudinary.config().cloud_name);
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log("Cloudinary configuré via les 3 variables séparées, cloud_name lu :", JSON.stringify(process.env.CLOUDINARY_CLOUD_NAME));
}

module.exports = cloudinary;
