# dougs-mcp

MCP local (stdio) pour l'API interne de Dougs, reconstituée depuis le front app.dougs.fr (Angular).

## Connexion (simple)

```bash
npm install
npm run login
```

Email, mot de passe, puis le code MFA (mail ou appli). La session est enregistrée dans `~/.config/dougs-mcp/session.json` (droits 600) avec l'ID société détecté automatiquement. Le MCP la lit au démarrage et y réécrit les cookies renouvelés. Si la session expire, l'outil renvoie un message clair : relancer `npm run login`.

Alternative : `DOUGS_COOKIE` + `DOUGS_COMPANY_ID` en variables d'env (header `cookie` copié depuis DevTools), prioritaires sur le fichier.

### Comment marche l'auth Dougs

- API sur la même origine que le front : `https://app.dougs.fr/companies/{companyId}/...`
- Session par cookie httpOnly, pas de header Authorization. Sans cookie : `401`.
- `POST /auth/api/login {email,password}` puis, si MFA : `GET /auth/api/mfa/enabled-factors`, `POST /auth/api/mfa/send-email`, `POST /auth/api/mfa/verify {token,type}`.
- Renouvellement : `GET /users/me?refreshSession=true` (appelé toutes les 10 min).

## Endpoints utilisés

| Usage | Méthode | Chemin |
|---|---|---|
| Liste opérations | GET | `/companies/{c}/operations?limit&offset&validated&needsAttention` |
| Compteur | GET | `/companies/{c}/operations/count-operations?validated` |
| Détail | GET | `/companies/{c}/operations/{id}` |
| Plan de catégories | GET | `/companies/{c}/categories?full=true` |
| Suggestions | GET | `/companies/{c}/operations/{id}/breakdowns/{bid}/preferred-categories` |
| Mise à jour (catégorie, TVA, validation) | POST | `/companies/{c}/operations/{id}` body = `{...operation, updatedBreakdown}` (option `?force=true`) |
| Justificatif | POST | `/companies/{c}/operations/{id}/source-document-attachments/actions/create-from-formdata` (multipart, champ `file`) |
| Régime TVA | GET | `/companies/{c}/vat-configurations` |

Valider = même POST avec `validated: true` (c'est ce que fait le bouton du front).
Champs TVA d'une ligne de ventilation : `vatRate` (0.2), `vatAmount`, `manualVatAmount`, `isVatAmountManuallyModified`.

## Installation

```bash
cd dougs-mcp && npm install
```

Claude Desktop / Claude Code (`claude_desktop_config.json` ou `.mcp.json`) :

```json
{
  "mcpServers": {
    "dougs": {
      "command": "node",
      "args": ["/chemin/vers/dougs-mcp/server.mjs"]
    }
  }
}
```

## Outils

`dougs_whoami`, `dougs_list_operations`, `dougs_count_operations`, `dougs_get_operation`, `dougs_search_categories`, `dougs_suggest_categories`, `dougs_categorize_operation` (dryRun par défaut), `dougs_validate_operation` (dryRun par défaut), `dougs_list_missing_receipts`, `dougs_attach_receipt` (dryRun par défaut), `dougs_vat_configuration`, `dougs_raw_request` (écriture seulement avec `allowWrite`).

## Notes terrain

- Validé en conditions réelles (oct. 2026) : upload de justificatif (`create-from-formdata`, champ `file`) et validation (`POST {...operation, validated:true}`).
- Si une ligne passe à TVA 0 sur une catégorie normalement taxée, Dougs refuse la validation (400 / « toutes les associations doivent être renseignées ») tant que `associationData.vatExemptionReason` est vide. Valeur pour « la TVA n'est pas applicable » : `exemption:outbound:nonApplicable`.
- Transport de personnes (Taxi et VTC) : TVA non déductible, Dougs met 0 même si la facture Uber affiche 10 %.

## Points non vérifiés

- Le changement de catégorie/TVA via `dougs_categorize_operation` n'a pas encore été testé par l'API (fait via l'UI). Tester d'abord avec `dryRun:false` sur une opération et vérifier dans l'UI.
- Le paramètre de recherche serveur n'est pas identifié avec certitude (`q` ne filtre pas) : le filtre texte/date est fait côté client sur la page récupérée.
- API non officielle : peut casser à chaque déploiement du front Dougs.
