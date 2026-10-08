const prisma = require("./prisma");

// Écrit une ligne dans le journal d'audit (voir schema.prisma : JournalAudit). Volontairement
// tolérant aux erreurs — une panne de journalisation ne doit jamais faire échouer l'action
// métier elle-même (supprimer un client, changer un prix...).
async function consignerAudit({ action, cible, detail, utilisateurId, boutique }) {
  try {
    await prisma.journalAudit.create({
      data: { action, cible, detail: detail || null, utilisateurId, boutique: boutique || null },
    });
  } catch (e) {
    console.error("Échec d'écriture dans le journal d'audit :", e.message);
  }
}

module.exports = { consignerAudit };
