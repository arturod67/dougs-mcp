# dougs-mcp

MCP local (stdio) pour l'API interne de Dougs, reconstituée depuis le front app.dougs.fr (Angular).

## Auth

- Même origine que le front : `https://app.dougs.fr/companies/{companyId}/...`
- Session par cookie httpOnly (pas de header Authorization). Sans cookie : `401 Unauthorized`.
- Login : `POST /auth/api/login` puis MFA (`/auth/api/mfa/send-email`, `/auth/api/mfa/verify`), donc pas de login automatique ici.
- Renouvellement : `GET /users/me?refreshSession=true` (le MCP l'appelle toutes les 10 min et réinjecte les `Set-Cookie`).

Récupérer le cookie : Chrome > DevTools > Network > une requête `operations?...` > Request Headers > `cookie` > copier la valeur entière.

## Endpoints utilisés

| Usage | Méthode | Chemin |
|---|---|---|
| Liste opérations | GET | `/companies/{c}/operations?limit&offset&validated&needsAttention` |
| Compteur | GET | `/companies/{c}/operations/count-operations?validated` |
| Détail | GET | `/companies/{c}/operations/{id}` |
| Plan de catégories | GET | `/companies/{c}/categories?full=true` |
| Suggestions | GET | `/companies/{c}/operations/{id}/breakdowns/{bid}/preferred-categories` |
| Mise à jour (catégorie, TVA, validation) | POST | `/companies/{c}/operations/{id}` body = `{...operation, updatedBreakdown}` (option `?force=true`) |
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
      "args": ["/chemin/vers/dougs-mcp/server.mjs"],
      "env": {
        "DOUGS_COMPANY_ID": "ton_id_societe",
        "DOUGS_COOKIE": "colle_ici_la_valeur_du_header_cookie"
      }
    }
  }
}
```

## Outils

`dougs_whoami`, `dougs_list_operations`, `dougs_count_operations`, `dougs_get_operation`, `dougs_search_categories`, `dougs_suggest_categories`, `dougs_categorize_operation` (dryRun par défaut), `dougs_validate_operation` (dryRun par défaut), `dougs_vat_configuration`, `dougs_raw_request` (écriture seulement avec `allowWrite`).

## Points non vérifiés

- Le POST de mise à jour n'a pas été exécuté pendant la rétro-ingénierie (lecture seule). Tester d'abord sur une opération avec `dryRun:false` et vérifier dans l'UI que catégorie et TVA sont bien prises.
- Le paramètre de recherche serveur n'est pas identifié avec certitude (`q` ne filtre pas) : le filtre texte/date est fait côté client sur la page récupérée.
- API non officielle : peut casser à chaque déploiement du front Dougs.
