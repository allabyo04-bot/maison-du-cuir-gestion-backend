const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("../prisma");

// Vérifie que la requête contient un token valide (utilisateur connecté).
// Ajoute req.user = { id, roleId, boutique, prenom, nom } si tout va bien.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non authentifié. Connecte-toi d'abord." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { role: true } });
    if (!user || !user.actif) return res.status(401).json({ error: "Compte introuvable ou désactivé." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Session invalide ou expirée. Reconnecte-toi." });
  }
}

// Vérifie que le rôle de l'utilisateur connecté a la permission demandée.
// La vérification se fait à CHAQUE requête, en relisant le rôle en base —
// pas seulement côté affichage. C'est la vraie sécurité qu'on n'avait pas dans l'artifact.
function requirePermission(permissionKey) {
  return (req, res, next) => {
    const permissions = req.user?.role?.permissions || {};
    if (!permissions[permissionKey]) {
      return res.status(403).json({ error: `Accès refusé : ton rôle (${req.user.role.nom}) n'a pas la permission "${permissionKey}".` });
    }
    next();
  };
}

// Comme requirePermission, mais passe dès que UNE des permissions listées est accordée. Utile
// pour un module accessible à plusieurs profils différents sans en imposer un précis — par
// exemple Livraison, accessible à qui a "ventes" (comme avant) OU juste "livraison" (nouveau
// rôle Livreur, sans accès au reste de Ventes).
function requireAnyPermission(...permissionKeys) {
  return (req, res, next) => {
    const permissions = req.user?.role?.permissions || {};
    if (!permissionKeys.some((k) => permissions[k])) {
      return res.status(403).json({ error: `Accès refusé : ton rôle (${req.user.role.nom}) n'a aucune des permissions requises (${permissionKeys.join(", ")}).` });
    }
    next();
  };
}

// Deuxième facteur pour les actions les plus sensibles (gestion des utilisateurs et des rôles) —
// exige un code séparé, connu uniquement des personnes de confiance, en plus du PIN et de la
// permission normale. Protège même si un PIN administrateur venait à fuiter ou à être partagé
// par erreur : sans ce code, impossible de créer un compte, changer un rôle, ou réinitialiser
// un PIN. À appeler APRÈS requireAuth et requirePermission.
async function requireCodeConfirmation(req, res, next) {
  const { codeConfirmation } = req.body;
  if (!codeConfirmation) {
    return res.status(400).json({ error: "Code de confirmation obligatoire pour cette action." });
  }
  const parametre = await prisma.parametreSecurite.findFirst();
  if (!parametre) {
    return res.status(500).json({ error: "Code de confirmation non configuré. Contacte le développeur." });
  }
  const valide = await bcrypt.compare(codeConfirmation, parametre.codeConfirmationHash);
  if (!valide) {
    return res.status(403).json({ error: "Code de confirmation incorrect." });
  }
  next();
}

module.exports = { requireAuth, requirePermission, requireAnyPermission, requireCodeConfirmation };
