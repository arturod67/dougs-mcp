# dougs-mcp : notes pour Claude

MCP local (stdio) sur l'API interne de app.dougs.fr, reconstituée depuis le front Angular. API non officielle : tout peut casser à un déploiement Dougs.

Ce repo est public : aucune donnée de société ici (IDs, montants, numéros de facture, comptes). Les infos propres à un compte vont dans `CLAUDE.local.md` (ignoré par git) ou dans `~/.config/dougs-mcp/`.

## Règles de travail

- Écritures en `dryRun: true` d'abord, puis `dryRun: false` une fois le plan vérifié.
- Ne valider une opération que si ses justificatifs sont rattachés.
- Ne jamais confirmer ni déposer une déclaration fiscale à la place de l'utilisateur : préparer, vérifier, lui laisser le dépôt et le paiement.
- Auth : `npm run login` (email, mot de passe, MFA) fait par l'utilisateur, jamais par Claude.
- Sans session MCP, les mêmes routes marchent depuis un onglet app.dougs.fr connecté avec `fetch(path, {credentials:'include'})`.
- Ne jamais committer de données de compte (companyId, IDs d'opérations, montants, numéros de facture).

## Ventilation e-commerce mensuelle

Opération « … - Ventilation des recettes e-commerce du mois de … », type `dispatch:ecommerce:salesChannel`, une par mois et par canal de vente. Recherche : `GET /operations?q=ventil&validated=false` (`q` ne filtre qu'avec `validated` explicite).

Ces opérations ne passent PAS par `POST /operations/{id}` mais par :

| Usage | Requête |
|---|---|
| Lire les lignes | `GET /companies/{c}/operations/{id}/ecommerceSales` (sections > subSections > sales) |
| Créer une vente | `POST …/ecommerceSales` `{ecommerceSale:{sectionId:"service",subSectionId:"fr",saleId,selectedZone,packageId:"over150"}}` |
| Créer une commission | `POST …/ecommerceSales` `{ecommerceSale:{sectionId:"fees",subSectionId:"fees",saleId:"fees",paymentsProcessorId,label}}` |
| Fixer le montant | `POST …/ecommerceSales/{breakdownId}` `{ecommerceSale:{...ligne, amount, sectionId, subSectionId}}` |

- Montants de vente en TTC, Dougs calcule la TVA depuis le TTC (1 centime d'écart possible avec un calcul fait depuis le HT).
- `saleId` : `fr-20` ; UE en code ISO minuscule sauf `el` (Grèce), `ee-24`, `fi-25.5`, `sk-23`, `ro-21` ; Hors UE `exemption:inbound:outsideEuropeanUnion` avec `selectedZone:"exonerateSale"` (UE : `"eu"`).
- Commissions : une ligne par prestataire de paiement, montant = total de sa facture de frais du mois. Les `paymentsProcessorId` sont propres au compte : config locale (voir README), ou les relire sur un mois déjà ventilé.
- La contrepartie (section `main`, catégorie Encaissement e-commerce) = ventes − commissions, recalculée par Dougs avec quelques secondes de délai.
- Justificatifs : `POST /operations/{id}/source-document-attachments/actions/create-from-formdata` (multipart, champ `file`).

## Déclarations fiscales

- `GET /companies/{c}/declarations` : liste (types `CA3-AAAA`, `OSS`, `2571` acompte IS, CFE…), avec `confirmedAt`, `isLate`, `dueDate`, `summaryAmount`.
- `GET /companies/{c}/declarations/{id}` : `form` = cases du formulaire.
  - CA3 : clés = numéros de case (`08`, `16`, `20`, `23`, `25`, `A1`, `A3`, `E1`, `E2`, `E3`…). E3 = ventes à distance B2C UE (OSS) HT du mois. A3 = autoliquidation (collectée et déduite).
  - OSS : par pays `<clé>:servicesVatRevenue` (base arrondie à l'euro), `<clé>:VAT:rate:services`, `<clé>:servicesVATcredit` (TVA arrondie), `<clé>:servicesVATcredit:detailedVatAccountNumber` (TVA réellement comptabilisée).
- Routes vues dans le front, non testées : `list-declarations`, `count`, `{id}/attachments`, `{id}/actions/confirm|unconfirm|reset|correct|generate-preview`, `{id}/remoteTransmissionStatus`.
- La CA3 peut être télédéclarée par Dougs (l'utilisateur coche et valide). L'OSS est à recopier sur impots.gouv, puis à justifier dans Dougs (accusé, capture du récapitulatif, paiement).

## Guichet unique OSS (cfspro.impots.gouv.fr)

Page Opérations : `/oss-mapiusager-cadriciel/xhtml/declarationtva/oss/operations.xhtml`, application JSF/Mojarra.

- L'état de la saisie est porté par le `javax.faces.ViewState` de la page, pas par la session : **un GET ou un rechargement repart d'un formulaire vierge**. Toujours cliquer « Enregistrer brouillon » avant de quitter la page.
- Une ligne = 4 requêtes ajax (`Faces-Request: partial/ajax`, `javax.faces.source` = le champ, `javax.faces.partial.execute` = le champ deux fois, render `panelBlocSaisieOperation` ou `tva-due`) sur `types-operations` (`SERVICES_MSID`), `etat-membre-de-consommation` (code pays, Grèce = `EL`), `taux` (option `TauxTva[…]` à lire dans la réponse), `montant-taxable`, puis un POST classique avec `formSaisieOpeTaxable:btnAjoutOperation`.
- Le portail calcule la TVA (base × taux, au centime) : son total peut différer de l'arrondi Dougs de quelques centimes.
- Ne pas paralléliser : chaque requête dépend du ViewState renvoyé par la précédente.
- `dougs_oss_portal_script` génère le script qui rejoue tout en séquence puis réaffiche la page sans la recharger.
