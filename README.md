# KPI_Group_backend

Nouveau backend API (Node.js/Express) pour KPI_Group, en cours de migration
progressive depuis le monolithe original.

Voir `MIGRATION_MAP.md` (à la racine de `KPI Project`) pour le suivi de la
migration route par route.

## Authentification et administration des utilisateurs

Seules deux interfaces exigent une connexion : le Responsible KPI Dashboard
(`/responsible/:id/dashboard`) et l'administration des utilisateurs. Toutes les
autres pages restent ouvertes comme avant, en particulier celles ouvertes
depuis un lien reçu par mail (`/form`, `/dashboard`, `/kpi-training-center`,
`/kpi-target-adjustments/review`…).

Côté API, seules les routes de ces deux interfaces sont protégées : la liste
exacte est `PROTECTED_ROUTES` dans `src/middlewares/auth.middleware.js`. Toute
route qui n'y figure pas reste publique. Les routes `/api/admin/*` exigent en
plus le rôle `admin`.

`GET/PUT/DELETE /api/kpis/:id` restent publiques, même si le dashboard les
utilise, parce que la page ouverte `/kpi-admin` en a besoin.

### Mise en route

Les tables (`kpi_app_user`, `kpi_app_session`, `kpi_app_password_token`,
`kpi_app_auth_event`) sont créées automatiquement au démarrage. Elles ne
modifient aucune table existante ; `people` est seulement lue.

Pour créer le premier administrateur (le mot de passe est demandé en saisie masquée) :

```
npm run create-admin -- --email prenom.nom@avocarbon.com
```

Avec `--invite` à la place, le script envoie un mail d'invitation. Si l'envoi
échoue, il affiche le lien à transmettre.

### Fonctionnement

| Sujet | Règle |
|---|---|
| Rôles | `user`, `plant_manager`, `zone_manager`, `vp`, `ceo`, `admin`. Seul `admin` accède à l'administration. Les autres règlent ce que l'on voit dans « My KPI Analytics » (filtres unité / responsable) : ses propres KPI (`user`), plus les responsables de son usine (`plant_manager`) ou des usines de sa zone (`zone_manager`), plus tous les responsables (`vp`, `ceo`, `admin`). L'usine ou la zone vient des affectations actives de `people_role_assignment` (« Plant manager », « Zone managers »), sinon de l'unité de travail de la personne ; l'unité d'un responsable est son `work_at_unit_id`. Le serveur applique ce périmètre (`services/kpiAnalyticsScope.service.js`). La contrainte `kpi_app_user_role_check` est mise à jour au démarrage. |
| Compte et personne | Tout compte sauf un administrateur est lié à une personne de `public.people` : choisie par l'administrateur, sinon celle qui a le même e-mail. |
| Dashboard de chacun | Après connexion, l'utilisateur arrive sur `/responsible/<son people_id>/dashboard` (ex. 2284 pour Ahmed HORRI). Il ne peut ouvrir que le sien : l'API répond 403 `NOT_OWN_DASHBOARD` pour un autre id. Les administrateurs peuvent ouvrir tous les dashboards. |
| Session | Cookie `kpi_session` HttpOnly, SameSite=Lax (Secure en production). Seul le SHA-256 du jeton est stocké. Expire après 2 h d'inactivité, 12 h au maximum. |
| Mot de passe | Haché en scrypt. Au moins 10 caractères, avec une minuscule, une majuscule et un chiffre, sans le nom de l'e-mail. |
| Échecs de connexion | Message identique pour un e-mail inconnu ou un mauvais mot de passe. Compte verrouillé 15 min après 5 échecs ; limitation de débit par compte et par IP. |
| Mot de passe oublié | Réponse identique, que le compte existe ou non. Lien à usage unique valable 60 min ; toutes les sessions du compte sont fermées après la réinitialisation. |
| Invitation | Lien valable 72 h. L'administrateur peut aussi fixer un mot de passe temporaire, que l'utilisateur doit changer à sa première connexion. |
| CSRF | Requêtes d'écriture avec cookie refusées si l'en-tête `Origin` n'est pas dans `FRONTEND_URL`. |
| Garde-fous admin | Il reste toujours au moins un administrateur actif ; un admin ne peut ni se rétrograder, ni se désactiver, ni se supprimer. |
| Audit | Connexions, échecs, réinitialisations et actions d'administration sont enregistrés dans `kpi_app_auth_event`, consultables dans l'onglet « Activity log ». |
| Traçabilité KPI | Chaque création, modification ou suppression d'un KPI ou d'une target allocation faite par cette application (Responsible KPI Dashboard, page `/kpi-admin`, approbation d'un ajustement de cible) est enregistrée dans `kpi_app_change_log` : quoi, quand, par qui (compte connecté, approbateur du lien, sinon anonyme + IP) et, pour une modification, les champs changés (avant → après). L'écriture se fait dans la même transaction que le changement (`services/kpiChangeLog.service.js`). Onglet « KPI audit trail », administrateurs seulement. Les changements faits par le monolithe en production ou directement en SQL ne sont pas tracés. |

Variables d'environnement : voir `.env.example` (section Authentification).
Derrière le proxy Azure, mettre `TRUST_PROXY=1` pour que la limitation par IP
et le journal voient la vraie adresse du client.

### Tests

`npm test` lance les tests du parcours complet sur une base PostgreSQL en
mémoire (`pg-mem`), avec un faux serveur mail. Ils ne touchent ni la base de
production ni la messagerie.

### Lancer le backend en local

Ce backend partage la base de production. Mettre `DISABLE_CRON_JOBS=true` pour
qu'il n'envoie pas les mails hebdomadaires de soumission KPI. Sans cela, il
enregistrerait aussi l'envoi dans le journal partagé avec la production.
