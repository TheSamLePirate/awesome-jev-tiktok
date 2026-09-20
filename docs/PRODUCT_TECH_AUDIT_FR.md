# Audit contradictoire et feuille de route produit

Date : 20 septembre 2026. Code examiné : commit `1778401`, avec modifications locales préexistantes dans deux fichiers d’enregistrement. Plan challengé : `IMPROVEMENT_PLAN.md`, qui référence `5d6400c`.

## Avis général

Le projet possède une chaîne fonctionnelle cohérente : collecte du live, transcription, description vidéo, décisions typées, règles en langage naturel, alertes, DVR et vue Director. Son potentiel distinctif est de transformer un live en actions utiles, vérifiables et faciles à traiter.

Le plan existant est un bon inventaire de dette technique. Il ne suffit pas encore comme feuille de route produit : il mesure peu la pertinence des décisions, la charge imposée au streamer et la capacité à expliquer ou reproduire une alerte. Une application stable peut encore donner de mauvaises consignes avec beaucoup d’assurance.

Recommandation : viser d’abord un assistant fiable pour un streamer accompagné éventuellement d’un modérateur, sur une session. Reporter le multi-stream, la publication automatique et les sanctions automatiques. Cette cible est une hypothèse de travail, à confronter à l’usage réel.

## Périmètre et vérifications

- Lecture du serveur, du protocole, des parcours React et du plan existant.
- `bun run typecheck` : succès.
- `bun run build` : succès ; JS principal 889,51 kB minifié / 273,47 kB gzip. Avertissements sur la taille du chunk et `__dirname` dans la configuration Vite.
- Deux reproductions synthétiques locales avec les vrais modules `Window` et `replayEvents`, sans fournisseur externe ni écriture dans les données applicatives.
- Vérification documentaire d’Effect v3, de FFmpeg et des reconnexions Deepgram.
- Pas de test visuel navigateur, de session TikTok réelle, de mesure de précision des modèles, de panne réseau réelle ou de test de six heures. Les coûts et latences annoncés par le plan précédent ne sont donc pas revalidés ici.
- Les constats ci-dessous distinguent les résultats reproduits des chemins de code identifiés et des risques à tester.

## Ce que je changerais dans le plan existant

| Proposition actuelle | Challenge | Recommandation |
|---|---|---|
| Phase 0 en deux jours, puis quatre jours pour le cycle de vie | La pompe audio, l’arrêt des processus et la finalisation dépendent du cycle de vie. Les présenter comme petits correctifs indépendants sous-estime leur couplage. | Traiter ensemble les invariants session/processus/enregistrements ; découper en livraisons vérifiables. |
| Files d’attente et budget en phase 2 | Une panne ou un afflux de chat peut générer des appels avant que le reste soit terminé. | Avancer le plafond d’appels, la limite de concurrence, l’expiration des tâches et l’arrêt des appels IA. |
| Tests navigateur et CI en phase 5 optionnelle | Ce sont les moyens de vérifier les premières corrections. | Installer les premiers tests et la CI dès le premier lot ; enrichir à chaque bug. |
| Machine à états optionnelle | L’implémentation peut rester simple, mais les transitions autorisées et l’identité de session ne sont pas optionnelles. | Définir immédiatement `idle/connecting/live/degraded/stopping/error`, puis choisir une implémentation légère. |
| Toasts classés critiques comme la perte vidéo | La hiérarchie mélange gêne ergonomique, panne générale et perte de données. | P0 : intégrité, exposition, dépenses incontrôlées ; P1 : décisions trompeuses et parcours bloqués ; P2 : confort. Adapter à l’impact mesuré. |
| `catchAllCause` et continuer partout | Certaines erreurs permettent de continuer, d’autres invalident l’état ; une interruption volontaire doit arrêter le travail. | Politique par composant : reprise bornée, fonctionnement dégradé ou arrêt explicite. Ne pas neutraliser systématiquement l’interruption. |
| Supprimer les ticks si le hash est identique | `ts` et `secs_ago` changent ; inversement, l’expiration d’un contenu doit modifier la décision même sans nouvel événement. | Empreinte du contenu métier, déclenchements sur événements et expirations, réévaluation périodique bornée. |
| Hash JPEG pour éliminer les images statiques | Une variation d’encodage ou un petit compteur peut changer tous les octets. | Mesure perceptuelle avec seuil, durée maximale entre analyses et conservation des petits changements utiles. À comparer sur des images réelles. |
| MP4 avec byte ranges comme DVR | Ce n’est pas un remplacement transparent de HLS pour un fichier en croissance. | À court terme : HLS avec rétention bornée + archive indépendante. Étudier ensuite les segments communs et leur assemblage. |
| Clip via `-ss/-to -c copy` | Une découpe sans réencodage impose des contraintes de points de coupe. | Proposer « rapide » et « précis » avec aperçu ; tester image de début, son et synchronisation. |
| Garder tous les panneaux montés | Les effets et les sondages des panneaux masqués peuvent continuer. | Conserver les brouillons/filtres dans un état durable ; suspendre les effets inutiles des panneaux inactifs. |
| Undo avec le même numéro de version | Réutiliser un numéro brouille l’historique et l’attribution des décisions. | Restaurer le contenu dans une nouvelle version, avec référence à la version restaurée. |
| Auth globale avec jeton dans l’URL OBS | Une source OBS n’a pas besoin de pouvoir changer les clés ou supprimer les archives. | Séparer admin, modérateur, Director privé et overlay public ; accès révocable et limité au rôle. |
| Coût par règle | Les questions partagent des appels par groupe de sources ; leur coût n’est pas nécessairement additif. | Afficher le coût mesuré par groupe et une estimation marginale explicite. |
| « Fuzz : aucun 500 », « CPU < 3 % » | Critères trop absolus ou sans environnement défini. | Entrées invalides → 4xx explicites ; panne interne → erreur maîtrisée. Fixer machine, débit, durée et percentiles pour la performance. |

Corrections factuelles du plan :

- W10 : le serveur supprime aussi les alertes non épinglées (`server/index.ts:88`), ce n’est pas seulement une désynchronisation du client.
- P7 : le buffer de logs serveur est limité à 600 entrées, pas environ 1 300 (`server/bus.ts:8`). D’autres collections augmentent bien le message `hello`.
- Les cadeaux, likes et arrivées ne sont pas tous « jetés » : certains alimentent `Window`, et le client garde un buffer de cadeaux/événements sociaux. Il manque surtout une restitution dédiée.
- Les MP4 et métadonnées sont déjà suivis par Git. Ajouter une règle d’ignore ne les retire pas de l’index ni de l’historique ; prévoir une action explicite sans effacer les copies locales. Une éventuelle réécriture d’historique est une décision distincte.
- Le plan signale une exposition de secrets lors d’un audit antérieur. Je n’ai pas vérifié cet incident ni consulté les secrets ; le traiter comme un signal à confirmer, sans prétendre qu’une rotation a eu lieu.
- Les expressions « trois fonctions les plus demandées » et les mesures économiques nécessitent des sources ou un protocole. Ce sont des hypothèses tant que ces éléments ne sont pas joints.

## Constats supplémentaires importants

### A. L’arrêt de REC peut annoncer un état faux — P0

**Lecture du code.** L’enregistrement automatique appartient au processus média et son `rec.proc` vaut `null` (`server/index.ts:206`). `stopRecording` remet `rec` à `null`, ferme les métadonnées et lance le remux, mais ne retire pas la sortie MP4 du processus principal (`server/index.ts:61`). Pendant que le live continue, le fichier peut donc encore être écrit alors que l’interface annonce l’arrêt.

**À faire :** définir l’arrêt réel de l’archive indépendamment de la lecture et de la transcription. Finaliser seulement après la fin confirmée du producteur ; état `finalizing` visible. Test d’acceptation : après Stop, la taille du fichier se stabilise et le média live reste actif. Au redémarrage de l’app, détecter les enregistrements interrompus et proposer récupération/finalisation.

### B. Des données périmées restent interprétées comme actuelles — P1

**Reproduit.** Après injection à `ts=1000` d’une description vidéo et d’un transcript provisoire, un snapshot à `1000000` contient encore les deux textes. Les captions sont limitées en nombre, pas en âge ; l’interim n’a pas de date d’expiration (`server/window.ts:28`).

**À faire :** âge et état par source (`available/stale/missing/error`), expiration configurable, distinction « silence observé » / « audio indisponible ». Une décision dépendant d’une source absente doit pouvoir être « non évaluée ». Le plan S7 doit conserver les réponses disponibles sans transformer les groupes en échec en réponses négatives, ni créer artificiellement un nouveau front d’alerte à leur retour.

### C. Les horloges de replay ont deux défauts, pas un — P1

**Reproduit.** Pour deux événements à 300 ms d’écart, `replayEvents` a duré environ 318 ms mais a produit un écart de `ts` de 1 ms. `Date.now()` est évalué lors de la construction de `Effect.as`, avant l’attente (`server/replay.ts:26`). Le premier transcript conservait aussi son `endTs=1100` d’origine, conformément au bug S5.

**À faire :** distinguer `eventTime`, `receivedAt`, `decidedAt` et position média ; introduire une horloge injectable. Préserver les dates source dans l’archive et effectuer une transformation cohérente pour le replay. Réhydrater le contexte précédant un seek pour ne pas juger immédiatement sur une fenêtre vide. Les événements audio peuvent arriver après leur instant source : ne pas supposer que l’ordre des lignes du JSONL est toujours l’ordre temporel.

### D. Les alertes ne forment pas encore un historique durable — P1

**Lecture du code.** Le nettoyage de session efface les alertes non épinglées. `Highlight` n’a ni `sessionId`, ni `decisionId`, ni version de règle, ni référence à l’entrée exacte analysée (`shared/protocol.ts:123`). Le JSONL archive les événements source, pas un journal complet des décisions. Si plus de 500 éléments sont tous épinglés, `Store.addHighlight` peut encore retirer le plus ancien (`server/store.ts:63`).

**À faire :** stocker les décisions et alertes par session, paginer leur affichage et séparer archivage, épinglage et rétention. Minimum : identifiants stables, version de règle, modèle, paramètres, horodatages, sources et référence à l’entrée analysée. La limite d’affichage de 500 ne doit pas être une limite de conservation silencieuse.

### E. « Mauvaise alerte » peut agir même après Annuler — P1

**Lecture du code.** Le retour `null` de `window.prompt` devient `undefined`, puis la requête de feedback part quand même. La carte est résolue même si la réponse JSON de feedback contient `ok:false` (`web/components/Flagged.tsx:33`). Seul le premier flag est contesté.

**À faire :** Annuler ne déclenche rien ; choisir le flag concerné ; recueillir le résultat attendu ; séparer « signaler une erreur » de « modifier une règle » et de « traiter la carte ». Prévoir aussi « alerte correcte » et « événement manqué » : sans exemples négatifs et événements ratés, on ne mesure pas le rappel.

### F. L’auto-refine optimise la confiance sans preuve d’exactitude — P1

**Lecture du code.** Le watchdog transforme une faible confiance en réécriture, puis applique directement `store.replace` (`server/loop.ts:173`). L’option est activée dans les valeurs par défaut (`server/settings.ts:18`). Une faible confiance peut pourtant venir d’un cas ambigu ou d’une source manquante. Un modèle plus affirmatif n’est pas forcément meilleur.

**À faire :** `brouillon → comparaison sur exemples → observation sans action → activation`. Figer les règles de production pendant un live sauf changement explicite. Retour arrière en nouvelle version. Contrôle de version avant commit pour qu’une réponse GLM lente ne remplace pas une modification plus récente. Rendre atomiques les mises à jour règles/questions/historique : sérialiser seulement les écritures fichier ne suffit pas à empêcher des modifications concurrentes perdues.

### G. Director peut rassurer à tort et montrer trop d’informations — P1

**Lecture du code.** Le label LIVE dépend du dernier statut, sans tenir compte de `s.connected`. « all clear » signifie seulement qu’aucune carte n’est visible. Les jauges recalculent `fired` sans le plancher de confiance serveur pour les réponses choice/score (`web/Director.tsx:23`).

**À faire :** afficher les décisions serveur, leur âge, la connexion et la couverture des sources ; remplacer « all clear » par un état exact. Distinguer un prompteur privé pour le streamer d’un overlay destiné aux spectateurs. Un avertissement de modération, une donnée personnelle ou une note interne ne doit pas être diffusé automatiquement parce que l’utilisateur suit la recette OBS.

### H. La dépense affichée est incomplète — P1

**Lecture du code.** Les logs ne comptabilisent pas Deepgram ; un coût fournisseur absent devient zéro dans les adaptateurs IA ; les logs persistent en mémoire entre sessions et les totaux client sont reconstruits sur un buffer tronqué à la reconnexion.

**À faire :** comptabilité par session et fournisseur avec états `estimé/confirmé/inconnu`. Réserver une enveloppe avant admission d’un appel concurrent, puis la réconcilier. Un timeout ne prouve pas une absence de facturation. Arrêter les nouveaux appels IA à la limite sans supprimer l’enregistrement. Afficher honnêtement qu’un plafond applicatif dépend de la qualité des estimations et des appels déjà engagés.

### I. La reconnexion WebSocket mérite un contrat de synchronisation — P1, risque à reproduire

Le serveur abonne le client avant de construire son `hello` asynchrone (`server/index.ts:499`) ; le client remplace ensuite tout son état à réception de `hello`. Sans numéro de séquence ni snapshot cohérent, des messages peuvent se chevaucher avec cette initialisation.

**À faire :** `sessionId`, `seq`, version de protocole et snapshot à un numéro connu ; appliquer ensuite uniquement les événements plus récents. Tester connexion/déconnexion pendant un flood, sans doublon ni perte de carte. Le Director ne devrait recevoir que les données utiles à son rôle.

## Fonctions à construire par valeur

Les tailles S/M/L sont relatives, pas des engagements calendaires. Elles supposent les prérequis de fiabilité correspondants. La valeur est une hypothèse à valider avec des utilisateurs.

| Priorité | Fonction | Parcours concret | Taille / dépendance | Mesure utile |
|---|---|---|---|---|
| 1 | Carte d’alerte vérifiable | Voir l’extrait exact, la règle, l’âge des sources ; regarder le moment ; traiter ou contester. | M ; horloges + historique | Temps de vérification, proportion d’alertes utiles |
| 1 | File de questions du public | Regrouper « quel prix ? » répété 20 fois ; afficher une carte et le nombre de demandes ; répondre, ignorer ou reporter. | M/L ; déduplication + états | Questions utiles traitées, délai de réponse |
| 1 | Gestion complète des règles | Créer depuis un modèle, tester sur des exemples, éditer, suspendre, activer et restaurer une version. | M ; versionnement cohérent | Réussite de création, erreurs après activation |
| 1 | Diagnostic avant live | Vérifier ffmpeg, espace disque, sources et clés ; montrer les capacités réellement disponibles et les changements attendant une reconnexion. | M ; santé par composant | Temps avant première session exploitable |
| 1 | Maîtrise du bruit | Grouper les répétitions, priorité explicite, temporisation, maximum de cartes/minute, pause des conseils non urgents. | M ; événements + sévérité | Alertes/minute, cartes ignorées, délais de traitement |
| 2 | Clip depuis une alerte | Prévisualiser une plage avant/après ; ajuster ; exporter MP4 et éventuellement sous-titres. | M/L ; média fiable | Clips conservés, temps jusqu’à un export utilisable |
| 2 | Carnet des engagements | « Je partagerai le lien » devient un engagement à confirmer, à rappeler puis à cocher. | M ; mémoire au-delà de 30 s | Engagements effectivement accomplis |
| 2 | Packs par usage | Q&A, vente, cours, interview, gaming ; règles, sources, seuils et présentation adaptés. | S/M ; règles éditables | Temps de configuration, maintien des réglages |
| 2 | Bilan de session actionnable | Moments utiles, questions sans réponse, promesses restantes, incidents et coût total estimé/confirmé ; liens vers extraits. | M ; archives de décisions | Actions réalisées après lecture du bilan |
| 2 | Règles locales rapides | Mots-clés, liens et motifs bornés ; analyse IA réservée aux cas qui en bénéficient. | M ; moteur de règles | Couverture, latence et coût par événement utile |
| 3 | Modération partagée | Attribuer une carte, indiquer qui la traite, éviter les doublons ; téléphone adapté au rôle. | L ; auth + état partagé | Doublons de traitement et temps de résolution |
| 3 | Notifications externes | Envoyer uniquement les alertes choisies ; journal de livraison, limite de fréquence et nouvelle tentative contrôlée. | M ; opt-in + sécurité | Livraison utile, taux de bruit |

Deux distinctions importantes :

- « Mettre en sourdine les alertes d’un utilisateur dans cette app » est différent de « bannir cet utilisateur sur TikTok ». Le connecteur observé collecte des événements ; une action réelle de modération demanderait une capacité séparée et vérifiée.
- Un donateur important peut être mis en avant dans un flux de remerciements, sans modifier la priorité d’un incident de modération. Éviter de mélanger engagement commercial et gravité.

À reporter : multi-plateformes, agents autonomes qui publient ou sanctionnent, marketplace de règles, microservices et redesign complet. La recherche sémantique globale peut attendre que les liens temporels et la recherche existante soient fiables. Le thème clair reste utile, mais vient après lisibilité, accessibilité et états honnêtes.

## Processus de qualité à ajouter

### 1. Un replay à trois modes explicites

1. **Lecture fidèle** : événements et décisions enregistrés, zéro appel IA, aucune mutation des règles.
2. **Simulation technique** : fournisseurs factices, horloge contrôlable, pannes injectées ; utilisable en CI.
3. **Réévaluation** : appels réels avec budget affiché, règles candidates et résultats isolés des sessions originales.

Le simple `dryRun` ne garantit pas une reproduction fidèle : il faut d’abord enregistrer les décisions originales. Pour le replay technique, rendre les adaptations temporelles déterministes ; pour une nouvelle inférence réelle, mesurer et accepter la variabilité du fournisseur.

### 2. Un corpus de référence pour l’IA

Commencer avec 50 à 100 extraits annotés, couvrant silence, panne de source, accents, alternance de langues, blagues, ambiguïtés, questions répétées, spam et événements ratés. Séparer exemples utilisés pour améliorer une règle et exemples réservés à son évaluation. Conserver un petit ensemble de scénarios bloquants.

Par règle : précision, rappel, taux d’abstention et temps de détection. Par session : alertes réellement utiles, charge de traitement, latence de bout en bout et coût. Une confiance annoncée de 90 % ne remplace pas une mesure sur ce corpus. Les seuils de lancement sont à définir après une première mesure ; ne pas annoncer arbitrairement « 95 % de précision » sur quelques exemples.

### 3. Une livraison guidée par des scénarios

Chaque ticket comporte : problème utilisateur, reproduction, résultat attendu, priorité, dépendances et test d’acceptation. Chaque bug corrigé ajoute un test pertinent. CI : typage, tests de logique et de cycle de vie, build, puis smoke tests console/Director avec fournisseurs factices. Aucun secret réel ni appel facturé nécessaire pour une pull request.

Avant une version utilisée longtemps : double connexion, arrêt pendant connexion, seek répété, panne Deepgram, sortie ffmpeg, 429, disque indisponible et reconnexion navigateur. Simuler le disque plein dans un environnement isolé, jamais en saturant le disque personnel. Ajouter un essai de six heures sur une machine et un profil de débit documentés.

### 4. Des objectifs de service mesurables

- Une seule session propriétaire des ressources ; après arrêt, zéro processus et tâche facturable résiduelle.
- Chaque source affiche sa fraîcheur et sa dernière erreur ; aucune donnée périmée présentée comme actuelle.
- Budget d’admission respecté sous concurrence ; dépenses inconnues visibles.
- Mémoire et files bornées sous le débit cible ; nombre d’événements abandonnés explicite.
- Archives vérifiées après interruption ; restauration des réglages et règles testée.
- Mesurer le p95 événement → carte visible, séparément pour chat, audio et vidéo. Les 300–500 ms d’un appel jev ne décrivent pas la latence de tout le parcours vidéo.

### 5. Une politique de données utilisable

Définir des durées de conservation distinctes pour vidéo, chat, transcriptions, décisions et retours humains ; quotas visibles ; purge contrôlée excluant les archives protégées et actives. Expliquer dans l’interface quelles sources sont transmises à quels fournisseurs. Prévoir un export expurgé pour partager un bug sans joindre clés, cookies ou données inutiles. Ce sont des exigences de conception proposées, pas une certification juridique.

### 6. Une boucle produit courte

Observer quelques sessions réelles avec des streamers/modérateurs : ce qu’ils ouvrent, ignorent, vérifient ou traitent trop tard. Après chaque session pilote, revoir les trois frictions les plus fréquentes et annoter quelques alertes. Le classement des ajouts doit évoluer avec ces observations, pas seulement avec la facilité de leur implémentation.

## Ordre de livraison recommandé

| Lot | Contenu | Porte de sortie |
|---|---|---|
| A — Une session sûre | Propriété des processus, arrêt REC, intégrité des fichiers, limites réseau/chemins, bornes de file et d’appels, premiers tests/CI. | Aucun enregistrement écrasé pendant écriture ; aucune session fantôme ; surcharge contrôlée. |
| B — Des décisions honnêtes | Horloges, fraîcheur des sources, réponses partielles explicites, Director cohérent, journal par session, auto-refine en proposition. | Une carte est attribuable à son entrée et sa version ; aucune panne assimilée à « tout va bien ». |
| C — Des actions utiles | Regarder le moment, file de questions, anti-bruit, pause/édition des règles, budget visible, diagnostic avant live. | Un streamer peut vérifier et traiter les alertes sans surveiller la console technique. |
| D — Une amélioration mesurée | Trois modes de replay, corpus annoté, comparaison de versions, clips, bilan de session. | Chaque nouvelle règle démontre sa valeur sur des exemples réservés à l’évaluation. |
| E — Extension selon l’usage | Collaboration, mobile, notifications, nouveaux packs et autres plateformes si la demande est établie. | Les besoins sont observés et le socle supporte les nouveaux rôles. |

Je ne validerais pas les 18 jours plus 3 jours optionnels du plan comme engagement. Il manque notamment l’effort de mesure, les reprises après panne et la qualification navigateur/OBS. Chiffrer lot A après ses premiers tests, puis recalibrer. Aucun de ces lots ne nécessite une réécriture complète du projet.

## Références externes utilisées

- [Effect v3 — Creating Effects](https://effect.website/docs/v3/getting-started/creating-effects) : un rejet dans `Effect.promise` est un défaut ; les échecs attendus relèvent de `tryPromise`.
- [FFmpeg — Formats, HLS](https://www.ffmpeg.org/ffmpeg-formats.html) : une playlist HLS `event` impose une liste non bornée ; une politique de rétention implique d’adapter ce mode et la suppression des segments.
- [Deepgram — Recovering from connection errors](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio) : reconnecter nécessite de gérer les données en attente et de réaligner les timestamps. Une file PCM bornée doit donc aussi conserver l’origine temporelle des morceaux et signaler les pertes.
