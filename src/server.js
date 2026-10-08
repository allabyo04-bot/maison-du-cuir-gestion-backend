require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const roleRoutes = require("./routes/roles");
const brandRoutes = require("./routes/brands");
const articleRoutes = require("./routes/articles");
const clientRoutes = require("./routes/clients");
const venteRoutes = require("./routes/ventes");
const retourRoutes = require("./routes/retours");
const venteAttenteRoutes = require("./routes/ventes-attente");
const bonValeurRoutes = require("./routes/bons-valeur");
const etatRoutes = require("./routes/etats");
const vendeurRoutes = require("./routes/vendeurs");
const remiseRoutes = require("./routes/remises");
const depenseRoutes = require("./routes/depenses");
const creanceHistoriqueRoutes = require("./routes/creances-historiques");
const inventaireRoutes = require("./routes/inventaire");
const { router: soldeRoutes, restaurerCampagnesExpirees } = require("./routes/soldes");
const denominationCarteCadeauRoutes = require("./routes/denominations-cartes-cadeaux");
const receptionRoutes = require("./routes/receptions");
const bonsLivraisonRoutes = require("./routes/bons-livraison");
const securiteRoutes = require("./routes/securite");
const apiPubliqueRoutes = require("./routes/api-publique");
const journalAuditRoutes = require("./routes/journal-audit");
const fideliteRoutes = require("./routes/fidelite");

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

app.get("/", (req, res) => res.json({ status: "ok", service: "gestion-commerciale-backend" }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/brands", brandRoutes);
app.use("/api/articles", articleRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/ventes", venteRoutes);
app.use("/api/retours", retourRoutes);
app.use("/api/ventes-attente", venteAttenteRoutes);
app.use("/api/bons-valeur", bonValeurRoutes);
app.use("/api/etats", etatRoutes);
app.use("/api/vendeurs", vendeurRoutes);
app.use("/api/remises", remiseRoutes);
app.use("/api/depenses", depenseRoutes);
app.use("/api/creances-historiques", creanceHistoriqueRoutes);
app.use("/api/inventaire", inventaireRoutes);
app.use("/api/soldes", soldeRoutes);
app.use("/api/denominations-cartes-cadeaux", denominationCarteCadeauRoutes);
app.use("/api/receptions", receptionRoutes);
app.use("/api/bons-livraison", bonsLivraisonRoutes);
app.use("/api/securite", securiteRoutes);
app.use("/api/api-publique", apiPubliqueRoutes);
app.use("/api/journal-audit", journalAuditRoutes);
app.use("/api/fidelite", fideliteRoutes);

// Gestion centralisée des erreurs non prévues
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Erreur interne du serveur." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API démarrée sur le port ${PORT}`));

// Restauration automatique des prix soldés dont la date de fin est dépassée — vérifié au
// démarrage puis toutes les 15 minutes. Pas besoin d'un service Cron Railway séparé : le
// serveur tourne en continu, cette vérification est légère (une requête si rien n'est expiré).
restaurerCampagnesExpirees().catch((err) => console.error("Erreur restauration soldes (démarrage) :", err));
setInterval(() => {
  restaurerCampagnesExpirees().catch((err) => console.error("Erreur restauration soldes (périodique) :", err));
}, 15 * 60 * 1000);
