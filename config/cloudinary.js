const cloudinary = require('cloudinary').v2;

// Si CLOUDINARY_URL est définie (format "cloudinary://CLE:SECRET@NOM_DU_NUAGE", copiée telle
// quelle depuis le tableau de bord Cloudinary), le SDK la lit automatiquement ici — c'est la
// méthode la plus fiable car elle élimine tout risque de faute de frappe en recopiant trois
// valeurs séparément. Sinon, on retombe sur les trois variables individuelles.
if (process.env.CLOUDINARY_URL) {
  cloudinary.config();
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

module.exports = cloudinary;
