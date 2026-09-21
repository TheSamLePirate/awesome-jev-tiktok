import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PublicSettings } from "@shared/protocol";
import { api } from "../lib/api";
import { notificationPermission, requestNotifications } from "../lib/notify";
import { toast, useStore } from "../lib/store";
import { LANGS, type Lang, fill, locale, plural, setLang, tr, useLang, useT } from "../i18n";
import { COMMON } from "../i18n/common";
import { confirm } from "./Dialog";
import { Kbd } from "./ui";

const M = {
  en: {
    sec_tiktok: "TikTok", sec_tiktok_b: "Which live to watch. Reading a live needs no login; the session id only helps with rate limits.",
    tiktok_username: "Username", tiktok_username_h: "The @handle of the streamer. Used by Connect when the field in the header is empty.",
    tiktok_sessionId: "Session id", tiktok_sessionId_h: "Optional TikTok `sessionid` cookie. Stored on this machine only (file mode 600).",
    tiktok_autoConnect: "Auto-connect", tiktok_autoConnect_h: "Watch the username from boot and connect the moment they go live. No need to press Connect.",
    tiktok_resume: "Resume", tiktok_resume_h: "After a connect, keep watching: reconnect when the stream drops and after a server restart. Disconnect turns it off for that live.",
    tiktok_pollSec: "Check every", tiktok_pollSec_h: "Seconds between two “is the account live?” checks while watching.",
    sec_keys: "API keys", sec_keys_b: "Secrets are stored in runtime/settings.json on this machine (mode 600) only when they differ from .env, and never sent to the browser in full.",
    keys_openrouter: "OpenRouter", keys_openrouter_h: "Pays for jev, GLM and vision. Applies to the next call immediately and resets the circuit breaker.",
    keys_deepgram: "Deepgram", keys_deepgram_h: "Live speech-to-text. Applied on the next stream connection.",
    sec_models: "Models", sec_models_b: "jev makes the decisions. GLM writes the questions. The vision model captions frames. All via OpenRouter, except Deepgram.",
    models_jev: "jev (decisions)", models_jev_h: "TypeSafe System One model id on OpenRouter.",
    models_glm: "GLM (prompt writer)", models_glm_h: "Writes and rewrites jev questions. Only called when rules change or feedback arrives.",
    models_vision: "Vision (captions)", models_vision_h: "Describes a video frame as text so jev can reason about the picture.",
    models_deepgram: "Deepgram model", models_deepgram_h: "nova-3 handles multilingual audio best.",
    models_language: "Speech language", models_language_h: "`multi` auto-detects and can switch mid-sentence. Set a code like `fr` or `en` for a single-language stream.",
    sec_timing: "Timing", sec_timing_b: "The rhythm of the loop. A tick whose state did not change is free (the previous answers are reused).",
    timing_tickMs: "jev tick", timing_tickMs_h: "How often the room questions are evaluated.",
    timing_maxTickGapMs: "Re-ask after", timing_maxTickGapMs_h: "Even when nothing changed, ask jev again after this long.",
    timing_captionEveryMs: "Vision caption", timing_captionEveryMs_h: "How often a frame is considered. Unchanged pictures are skipped; a caption is forced every 5 periods.",
    timing_windowMs: "Window", timing_windowMs_h: "How much recent transcript and chat jev sees on each tick.",
    timing_highlightGapMs: "Highlight gap", timing_highlightGapMs_h: "Minimum time between two flags of the same room question.",
    timing_excerptMs: "Excerpt", timing_excerptMs_h: "How much host speech is attached to a flagged moment.",
    timing_toastMs: "Toast", timing_toastMs_h: "How long a new-flag notification stays on screen.",
    sec_decisions: "Decisions", sec_decisions_b: "How answers become alerts.",
    decisions_fireConfidenceFloor: "Confidence floor", decisions_fireConfidenceFloor_h: "Choice and score alerts only fire when jev's confidence is at least this. Noul alerts use their own probability threshold.",
    decisions_unsureBelow: "Unsure below", decisions_unsureBelow_h: "Gauges are drawn dashed under this confidence, and the sample is kept for auto-refine.",
    decisions_judgeMessages: "Judge chat messages", decisions_judgeMessages_h: "Run the per-message questions on every incoming chat message.",
    decisions_messageConcurrency: "Message concurrency", decisions_messageConcurrency_h: "Parallel jev calls for chat messages. Applies live.",
    sec_budget: "Budget & back-pressure", sec_budget_b: "Hard limits so a chat flood or a provider outage cannot turn into an unbounded bill. Recording never stops for budget reasons.",
    budget_sessionUsd: "Session budget", budget_sessionUsd_h: "When the session's spend reaches this, paid calls stop (jev, vision, GLM). 0 = no cap. Estimates and calls in flight count.",
    budget_chatPerMinute: "Chat judged / min", budget_chatPerMinute_h: "Beyond this many messages per minute the rest are not judged (keyword rules still run).",
    budget_chatMaxAgeMs: "Chat max age", budget_chatMaxAgeMs_h: "A message older than this when its turn comes is skipped instead of billed late.",
    budget_chatQueue: "Chat queue", budget_chatQueue_h: "Backlog capacity; the oldest messages are dropped beyond it. Applied on the next connection.",
    sec_replay: "Replay", sec_replay_b: "How recorded sessions are played back.",
    replay_dryRun: "Dry run", replay_dryRun_h: "Replay without any paid call: no jev, vision or GLM. Keyword rules still fire. Decisions show as 'not evaluated'.",
    sec_autoRefine: "Auto-refine", sec_autoRefine_b: "When jev stays unsure about a question, GLM rewrites it without you. Off by default: a low confidence is not proof the question is wrong, and a rewrite mid-live changes what fires. Never runs during a replay.",
    autoRefine_enabled: "Enabled", autoRefine_enabled_h: "Turn the watchdog on or off.",
    autoRefine_emaBelow: "Trigger below", autoRefine_emaBelow_h: "Moving average of confidence that triggers a rewrite.",
    autoRefine_minSamples: "Min samples", autoRefine_minSamples_h: "Uncertain states to collect before asking GLM.",
    autoRefine_cooldownMs: "Cooldown", autoRefine_cooldownMs_h: "Minimum time between two rewrites of the same question.",
    autoRefine_intervalMs: "Check every", autoRefine_intervalMs_h: "How often the watchdog looks at question health.",
    sec_media: "Media", sec_media_b: "What ffmpeg extracts from the stream. Applied on the next connection.",
    media_transcription: "Transcription", media_transcription_h: "Send audio to Deepgram.",
    media_vision: "Vision captions", media_vision_h: "Extract frames and caption them.",
    media_hls: "Video in browser", media_hls_h: "Write HLS segments for the player. Disable to save disk and CPU.",
    media_dvrMinutes: "DVR window", media_dvrMinutes_h: "How many minutes of video stay reviewable in the player. Older segments are deleted from disk; the archive MP4 is unaffected.",
    media_recordVideo: "Record video", media_recordVideo_h: "Archive the stream as an MP4 in its own ffmpeg process (stream copy). Stop/start it with REC; it is finalized into a seekable file when stopped.",
    media_frameWidth: "Frame width", media_frameWidth_h: "Pixels. Smaller frames are cheaper to caption.",
    media_frameEverySec: "Frame every", media_frameEverySec_h: "How often ffmpeg refreshes the frame on disk (captioning has its own period).",
    media_audioKeepAlive: "Deepgram keep-alive", media_audioKeepAlive_h: "Ping the socket during silence so it is not closed.",
    sec_glm: "GLM", sec_glm_b: "Generation parameters for the prompt writer.",
    glm_temperature: "Temperature", glm_temperature_h: "Lower is more literal. 0.3 is a good default for schema-bound output.",
    sec_assist: "jev helpers", sec_assist_b: "Built-in helpers that use jev beside your rules, each a few cents per live at most, and the app's own automation. They never run in a dry run.",
    assist_sessionUsd: "Helpers budget", assist_sessionUsd_h: "What the helpers may spend per session, on top of your rules. 0 = no cap.",
    assist_autoResolve: "Close answered prompts", assist_autoResolve_h: "When the host replies to a viewer's message, jev closes the prompt on its own (✓ answered by the host).",
    assist_dedupe: "Fold duplicates", assist_dedupe_h: "A flag asking the same thing as an open one is folded into it: one card, “+3 asked the same”.",
    assist_thanks: "Thank gifters", assist_thanks_h: "A gift becomes a “thank X” prompt, closed when the host says their name or jev hears a thank-you; it expires after 4 minutes.",
    assist_thanksMinDiamonds: "Gift floor", assist_thanksMinDiamonds_h: "Diamonds below which a gift creates no prompt (a gifter who already has one adds to it).", 
    assist_promises: "Catch promises", assist_promises_h: "“In 5 minutes the giveaway”: the host's promises become prompts with a due time and appear in the director's run of show.",
    assist_faq: "Prepared answers", assist_faq_h: "jev matches flagged questions to the answers below and shows the answer on the card.",
    assist_faqText: "FAQ", assist_faqText_h: "One entry per line: question => answer (or question | answer). Up to 40 entries.",
    assist_poll: "Live polls", assist_poll_h: "Count chat messages as votes for a poll started from the console or the director (p).",
    assist_regime: "Attention regime", assist_regime_h: "jev rates the room calm / normal / hot; the tick, captions and chat judging follow, so a quiet room costs almost nothing.",
    assist_degrade: "Budget degradation", assist_degrade_h: "Before the budget cap: alert at 80 %, then vision off, then chat judging off, keeping the room rules to the end.",
    assist_repair: "Self-repair", assist_repair_h: "jev reads the health state and picks an action; the safe ones (restart media) are applied, the others suggested in the health bar.",
    assist_ruleHygiene: "Rule hygiene", assist_ruleHygiene_h: "Suggest keep / refine / pause / remove for each rule from its fires, your verdicts and jev's confidence.",
    assist_retention: "Recordings retention", assist_retention_h: "Score each recording at the end of the session; when the disk is below the floor, expendable ones are deleted, oldest first.",
    assist_diskFloorGb: "Disk floor", assist_diskFloorGb_h: "Free space under which expendable recordings are deleted.",
    assist_interruptibility: "Interruptibility", assist_interruptibility_h: "The director delays chimes while the host is in full flow, and plays them at the next pause.",
    glm_maxTokens: "Max tokens", glm_maxTokens_h: "Ceiling for one GLM answer, reasoning included.",
    noCap: "no cap", notANumber: "not a number", min: "min {n}", max: "max {n}",
    reconnectTitle: "applies on the next stream connection", reconnect: "reconnect", unsaved: "unsaved",
    storedPh: "stored (…{tail}) · type to replace", notSet: "not set", hide: "hide", show: "show", hideSecret: "hide secret", showSecret: "show secret", testKey: "test this key", test: "test",
    savedOne: "Saved {n} setting", savedMany: "Saved {n} settings", reconnectToApply: " · reconnect the stream to apply the media changes",
    resetTitle: "Reset every setting to the .env defaults?", resetBody: "Keys typed here will be replaced by the .env values.", reset: "Reset", resetDone: "Reset to defaults",
    testing: "testing…", imported: "Imported {name}", importFailed: "Import failed: {msg}", notifBlocked: "Notifications blocked by the browser",
    loading: "Loading settings…", navAria: "settings sections", thisBrowser: "This browser", exportTitle: "download settings without secrets", export: "⤓ export", importTitle: "upload a settings JSON", import: "⤒ import", importAria: "import settings JSON", resetBtn: "reset",
    checkModels: "check model ids on OpenRouter",
    prefsBlurb: "Preferences stored locally, not on the server.", chime: "Alert chime", chimeHelp: "Play a short tone when a new flag arrives (a lower one for warnings). Shortcut",
    notifications: "Browser notifications", blocked: "blocked", notifHelp: "Show a system notification for a new flag while this tab is hidden.",
    langHelp: "The language of the console. Remembered by this browser only.",
    access: "Access", accessNote: "This browser holds a session cookie for the server's token (30 days).", signOut: "Sign out of this browser",
    streamAudio: "Stream audio", muted: "muted", playing: "playing", audioHelp: "Whether the video player plays sound. Shortcut",
    meta: "last saved {date} · stored in runtime/settings.json · .env values are the defaults",
    unsavedOne: "{n} unsaved change", unsavedMany: "{n} unsaved changes", someReconnect: " · some apply after reconnect", invalid: " · {n} invalid",
    discard: "Discard", saving: "Saving",
  },
  fr: {
    sec_tiktok: "TikTok", sec_tiktok_b: "Quel live surveiller. Lire un live ne demande pas de connexion ; l'id de session aide seulement contre les limites de débit.",
    tiktok_username: "Nom d'utilisateur", tiktok_username_h: "Le @pseudo du streamer. Utilisé par Connecter quand le champ de l'en-tête est vide.",
    tiktok_sessionId: "Id de session", tiktok_sessionId_h: "Cookie TikTok `sessionid`, optionnel. Stocké sur cette machine uniquement (fichier en mode 600).",
    tiktok_autoConnect: "Connexion auto", tiktok_autoConnect_h: "Surveille le pseudo dès le démarrage et se connecte à l'instant où il passe en direct. Plus besoin d'appuyer sur Connecter.",
    tiktok_resume: "Reprise", tiktok_resume_h: "Après une connexion, continue de surveiller : reconnexion quand le flux tombe et après un redémarrage du serveur. Déconnecter la désactive pour ce live.",
    tiktok_pollSec: "Vérifier toutes les", tiktok_pollSec_h: "Secondes entre deux vérifications « le compte est-il en direct ? » pendant la surveillance.",
    sec_keys: "Clés API", sec_keys_b: "Les secrets sont stockés dans runtime/settings.json sur cette machine (mode 600) seulement s'ils diffèrent du .env, et jamais envoyés en entier au navigateur.",
    keys_openrouter: "OpenRouter", keys_openrouter_h: "Paie jev, GLM et la vision. S'applique dès l'appel suivant et réarme le disjoncteur.",
    keys_deepgram: "Deepgram", keys_deepgram_h: "Transcription en direct. Appliquée à la prochaine connexion au flux.",
    sec_models: "Modèles", sec_models_b: "jev prend les décisions. GLM écrit les questions. Le modèle de vision décrit les images. Tout passe par OpenRouter, sauf Deepgram.",
    models_jev: "jev (décisions)", models_jev_h: "Id du modèle TypeSafe System One sur OpenRouter.",
    models_glm: "GLM (rédacteur de prompts)", models_glm_h: "Écrit et réécrit les questions jev. Appelé seulement quand les règles changent ou qu'un retour arrive.",
    models_vision: "Vision (descriptions)", models_vision_h: "Décrit une image de la vidéo en texte pour que jev puisse raisonner sur l'image.",
    models_deepgram: "Modèle Deepgram", models_deepgram_h: "nova-3 gère le mieux l'audio multilingue.",
    models_language: "Langue de la parole", models_language_h: "`multi` détecte automatiquement et peut changer en milieu de phrase. Mets un code comme `fr` ou `en` pour un flux monolingue.",
    sec_timing: "Rythme", sec_timing_b: "Le rythme de la boucle. Un tick dont l'état n'a pas changé est gratuit (les réponses précédentes sont réutilisées).",
    timing_tickMs: "Tick jev", timing_tickMs_h: "Fréquence d'évaluation des questions de salle.",
    timing_maxTickGapMs: "Redemander après", timing_maxTickGapMs_h: "Même si rien n'a changé, redemande à jev après ce délai.",
    timing_captionEveryMs: "Description vision", timing_captionEveryMs_h: "Fréquence à laquelle une image est considérée. Les images inchangées sont sautées ; une description est forcée toutes les 5 périodes.",
    timing_windowMs: "Fenêtre", timing_windowMs_h: "Quantité de transcription et de chat récents que jev voit à chaque tick.",
    timing_highlightGapMs: "Écart entre signalements", timing_highlightGapMs_h: "Délai minimum entre deux signalements de la même question de salle.",
    timing_excerptMs: "Extrait", timing_excerptMs_h: "Quantité de parole du streamer attachée à un moment signalé.",
    timing_toastMs: "Notification", timing_toastMs_h: "Durée d'affichage d'une notification de nouveau signalement.",
    sec_decisions: "Décisions", sec_decisions_b: "Comment les réponses deviennent des alertes.",
    decisions_fireConfidenceFloor: "Confiance minimale", decisions_fireConfidenceFloor_h: "Les alertes de choix et de score ne partent que si la confiance de jev atteint ce niveau. Les alertes noul ont leur propre seuil de probabilité.",
    decisions_unsureBelow: "Incertain sous", decisions_unsureBelow_h: "Les jauges sont dessinées en pointillé sous cette confiance, et l'échantillon est gardé pour l'auto-affinage.",
    decisions_judgeMessages: "Juger les messages du chat", decisions_judgeMessages_h: "Exécute les questions par message sur chaque message de chat entrant.",
    decisions_messageConcurrency: "Messages en parallèle", decisions_messageConcurrency_h: "Appels jev parallèles pour les messages du chat. S'applique en direct.",
    sec_budget: "Budget et contre-pression", sec_budget_b: "Des limites dures pour qu'un déluge de chat ou une panne de fournisseur ne devienne pas une facture sans fin. L'enregistrement ne s'arrête jamais pour des raisons de budget.",
    budget_sessionUsd: "Budget de session", budget_sessionUsd_h: "Quand la dépense de la session atteint ce montant, les appels payants s'arrêtent (jev, vision, GLM). 0 = sans plafond. Les estimations et les appels en cours comptent.",
    budget_chatPerMinute: "Chat jugé / min", budget_chatPerMinute_h: "Au-delà de ce nombre de messages par minute, le reste n'est pas jugé (les règles mot-clé tournent toujours).",
    budget_chatMaxAgeMs: "Âge max du chat", budget_chatMaxAgeMs_h: "Un message plus vieux que ça quand vient son tour est sauté au lieu d'être facturé en retard.",
    budget_chatQueue: "File du chat", budget_chatQueue_h: "Capacité de l'arriéré ; au-delà, les messages les plus anciens sont abandonnés. Appliqué à la prochaine connexion.",
    sec_replay: "Relecture", sec_replay_b: "Comment les sessions enregistrées sont rejouées.",
    replay_dryRun: "Essai à blanc", replay_dryRun_h: "Rejoue sans aucun appel payant : ni jev, ni vision, ni GLM. Les règles mot-clé se déclenchent toujours. Les décisions s'affichent « non évaluées ».",
    sec_autoRefine: "Auto-affinage", sec_autoRefine_b: "Quand jev reste incertain sur une question, GLM la réécrit sans toi. Désactivé par défaut : une confiance basse ne prouve pas que la question est mauvaise, et une réécriture en plein live change ce qui se déclenche. Ne tourne jamais pendant une relecture.",
    autoRefine_enabled: "Activé", autoRefine_enabled_h: "Active ou désactive le chien de garde.",
    autoRefine_emaBelow: "Déclencher sous", autoRefine_emaBelow_h: "Moyenne mobile de confiance qui déclenche une réécriture.",
    autoRefine_minSamples: "Échantillons min", autoRefine_minSamples_h: "États incertains à collecter avant de demander à GLM.",
    autoRefine_cooldownMs: "Délai de repos", autoRefine_cooldownMs_h: "Délai minimum entre deux réécritures de la même question.",
    autoRefine_intervalMs: "Vérifier toutes les", autoRefine_intervalMs_h: "Fréquence à laquelle le chien de garde examine la santé des questions.",
    sec_media: "Média", sec_media_b: "Ce que ffmpeg extrait du flux. Appliqué à la prochaine connexion.",
    media_transcription: "Transcription", media_transcription_h: "Envoie l'audio à Deepgram.",
    media_vision: "Descriptions vision", media_vision_h: "Extrait des images et les décrit.",
    media_hls: "Vidéo dans le navigateur", media_hls_h: "Écrit des segments HLS pour le lecteur. Désactive pour économiser disque et CPU.",
    media_dvrMinutes: "Fenêtre DVR", media_dvrMinutes_h: "Combien de minutes de vidéo restent consultables dans le lecteur. Les segments plus anciens sont supprimés du disque ; le MP4 d'archive n'est pas touché.",
    media_recordVideo: "Enregistrer la vidéo", media_recordVideo_h: "Archive le flux en MP4 dans son propre processus ffmpeg (copie du flux). Démarre/arrête avec REC ; le fichier est finalisé en un fichier navigable à l'arrêt.",
    media_frameWidth: "Largeur d'image", media_frameWidth_h: "En pixels. Des images plus petites coûtent moins cher à décrire.",
    media_frameEverySec: "Image toutes les", media_frameEverySec_h: "Fréquence à laquelle ffmpeg rafraîchit l'image sur le disque (la description a sa propre période).",
    media_audioKeepAlive: "Keep-alive Deepgram", media_audioKeepAlive_h: "Pinge le socket pendant les silences pour qu'il ne soit pas fermé.",
    sec_glm: "GLM", sec_glm_b: "Paramètres de génération du rédacteur de prompts.",
    glm_temperature: "Température", glm_temperature_h: "Plus bas est plus littéral. 0,3 est une bonne valeur par défaut pour une sortie contrainte par un schéma.",
    sec_assist: "Assistants jev", sec_assist_b: "Des assistants intégrés qui utilisent jev à côté de tes règles, quelques centimes par live au plus, et l'automatisation de l'app elle-même. Jamais en essai à blanc.",
    assist_sessionUsd: "Budget des assistants", assist_sessionUsd_h: "Ce que les assistants peuvent dépenser par session, en plus de tes règles. 0 = sans plafond.",
    assist_autoResolve: "Clore les prompts répondus", assist_autoResolve_h: "Quand l'hôte répond au message d'un spectateur, jev ferme le prompt tout seul (✓ répondu par l'hôte).",
    assist_dedupe: "Regrouper les doublons", assist_dedupe_h: "Un signalement qui pose la même question qu'un autre encore ouvert est replié dedans : une seule carte, « +3 posent la même question ».",
    assist_thanks: "Remercier les donateurs", assist_thanks_h: "Un cadeau devient un prompt « remercie X », fermé quand l'hôte dit son nom ou que jev entend un merci ; il expire après 4 minutes.",
    assist_thanksMinDiamonds: "Seuil de cadeau", assist_thanksMinDiamonds_h: "Diamants en dessous desquels un cadeau ne crée pas de prompt (un donateur qui en a déjà un s'y ajoute).",
    assist_promises: "Retenir les promesses", assist_promises_h: "« Dans 5 minutes le giveaway » : les promesses de l'hôte deviennent des prompts avec une échéance, visibles dans le conducteur du réalisateur.",
    assist_faq: "Réponses préparées", assist_faq_h: "jev associe les questions signalées aux réponses ci-dessous et affiche la réponse sur la carte.",
    assist_faqText: "FAQ", assist_faqText_h: "Une entrée par ligne : question => réponse (ou question | réponse). Jusqu'à 40 entrées.",
    assist_poll: "Sondages en direct", assist_poll_h: "Compte les messages du chat comme des votes pour un sondage lancé depuis la console ou le réalisateur (p).",
    assist_regime: "Régime d'attention", assist_regime_h: "jev évalue la salle calme / normale / chaude ; le tick, les descriptions et le jugement du chat suivent, donc une salle calme ne coûte presque rien.",
    assist_degrade: "Dégradation budgétaire", assist_degrade_h: "Avant le plafond : alerte à 80 %, puis vision coupée, puis jugement du chat coupé, en gardant les règles de salle jusqu'au bout.",
    assist_repair: "Auto-réparation", assist_repair_h: "jev lit l'état de santé et choisit une action ; les sûres (redémarrer les médias) sont appliquées, les autres suggérées dans la barre de santé.",
    assist_ruleHygiene: "Hygiène des règles", assist_ruleHygiene_h: "Suggère garder / affiner / mettre en pause / supprimer pour chaque règle d'après ses déclenchements, tes verdicts et la confiance de jev.",
    assist_retention: "Rétention des enregistrements", assist_retention_h: "Note chaque enregistrement à la fin de la session ; sous le plancher de disque, les dispensables sont supprimés, les plus anciens d'abord.",
    assist_diskFloorGb: "Plancher de disque", assist_diskFloorGb_h: "Espace libre en dessous duquel les enregistrements dispensables sont supprimés.",
    assist_interruptibility: "Interruptibilité", assist_interruptibility_h: "Le réalisateur retarde les carillons tant que l'hôte est lancé, et les joue à la prochaine pause.",
    glm_maxTokens: "Tokens max", glm_maxTokens_h: "Plafond pour une réponse GLM, raisonnement compris.",
    noCap: "sans plafond", notANumber: "pas un nombre", min: "min {n}", max: "max {n}",
    reconnectTitle: "s'applique à la prochaine connexion au flux", reconnect: "reconnexion", unsaved: "non enregistré",
    storedPh: "enregistrée (…{tail}) · tape pour remplacer", notSet: "non définie", hide: "masquer", show: "afficher", hideSecret: "masquer le secret", showSecret: "afficher le secret", testKey: "tester cette clé", test: "tester",
    savedOne: "{n} réglage enregistré", savedMany: "{n} réglages enregistrés", reconnectToApply: " · reconnecte le flux pour appliquer les changements média",
    resetTitle: "Remettre tous les réglages aux valeurs du .env ?", resetBody: "Les clés saisies ici seront remplacées par les valeurs du .env.", reset: "Réinitialiser", resetDone: "Réglages réinitialisés",
    testing: "test en cours…", imported: "{name} importé", importFailed: "Import échoué : {msg}", notifBlocked: "Notifications bloquées par le navigateur",
    loading: "Chargement des réglages…", navAria: "sections des réglages", thisBrowser: "Ce navigateur", exportTitle: "télécharger les réglages sans les secrets", export: "⤓ exporter", importTitle: "charger un JSON de réglages", import: "⤒ importer", importAria: "importer un JSON de réglages", resetBtn: "réinitialiser",
    checkModels: "vérifier les ids de modèles sur OpenRouter",
    prefsBlurb: "Préférences stockées localement, pas sur le serveur.", chime: "Carillon d'alerte", chimeHelp: "Joue un son bref à chaque nouveau signalement (plus grave pour les avertissements). Raccourci",
    notifications: "Notifications du navigateur", blocked: "bloquées", notifHelp: "Affiche une notification système pour un nouveau signalement quand cet onglet est caché.",
    langHelp: "La langue de la console. Mémorisée par ce navigateur uniquement.",
    access: "Accès", accessNote: "Ce navigateur détient un cookie de session pour le jeton du serveur (30 jours).", signOut: "Déconnecter ce navigateur",
    streamAudio: "Audio du flux", muted: "coupé", playing: "en lecture", audioHelp: "Si le lecteur vidéo joue le son. Raccourci",
    meta: "dernier enregistrement {date} · stocké dans runtime/settings.json · les valeurs du .env sont les défauts",
    unsavedOne: "{n} changement non enregistré", unsavedMany: "{n} changements non enregistrés", someReconnect: " · certains s'appliquent après reconnexion", invalid: " · {n} invalide(s)",
    discard: "Abandonner", saving: "Enregistrement",
  },
};
type MK = keyof typeof M.en;

type Sec = "tiktok" | "keys" | "models" | "timing" | "decisions" | "budget" | "replay" | "autoRefine" | "media" | "glm" | "assist";
type Draft = Record<Sec, Record<string, string | number | boolean>>;

interface FieldDef { sec: Sec; key: string; label: MK; help: MK; type: "text" | "textarea" | "secret" | "number" | "bool" | "select" | "range"; unit?: string; min?: number; max?: number; step?: number; options?: string[]; fmt?: (v: number) => string }
interface Section { id: Sec; title: MK; icon: string; blurb: MK; fields: FieldDef[] }

const ms = (v: number) => (v >= 60_000 ? `${(v / 60_000).toFixed(v % 60_000 ? 1 : 0)} min` : v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `${v} ms`);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const usd = (v: number) => (v === 0 ? tr(M)("noCap") : `$${v.toFixed(2)}`);

/** Labels and help texts are message keys (`<sec>_<key>` and `<sec>_<key>_h`), translated where the field is drawn. */
const SECTIONS: Section[] = [
  { id: "tiktok", title: "sec_tiktok", icon: "🎬", blurb: "sec_tiktok_b", fields: [
    { sec: "tiktok", key: "username", label: "tiktok_username", help: "tiktok_username_h", type: "text" },
    { sec: "tiktok", key: "sessionId", label: "tiktok_sessionId", help: "tiktok_sessionId_h", type: "secret" },
    { sec: "tiktok", key: "autoConnect", label: "tiktok_autoConnect", help: "tiktok_autoConnect_h", type: "bool" },
    { sec: "tiktok", key: "resume", label: "tiktok_resume", help: "tiktok_resume_h", type: "bool" },
    { sec: "tiktok", key: "pollSec", label: "tiktok_pollSec", help: "tiktok_pollSec_h", type: "number", min: 20, max: 600, step: 10, unit: "s" },
  ] },
  { id: "keys", title: "sec_keys", icon: "🔑", blurb: "sec_keys_b", fields: [
    { sec: "keys", key: "openrouter", label: "keys_openrouter", help: "keys_openrouter_h", type: "secret" },
    { sec: "keys", key: "deepgram", label: "keys_deepgram", help: "keys_deepgram_h", type: "secret" },
  ] },
  { id: "models", title: "sec_models", icon: "🧠", blurb: "sec_models_b", fields: [
    { sec: "models", key: "jev", label: "models_jev", help: "models_jev_h", type: "select", options: ["typesafe/jev-1.13"] },
    { sec: "models", key: "glm", label: "models_glm", help: "models_glm_h", type: "select", options: ["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flashx", "z-ai/glm-5.3", "z-ai/glm-5.2", "z-ai/glm-4.7-flash"] },
    { sec: "models", key: "vision", label: "models_vision", help: "models_vision_h", type: "select", options: ["z-ai/glm-4.6v", "z-ai/glm-4.5v", "z-ai/glm-5v-turbo", "google/gemini-2.5-flash-lite", "google/gemini-3.1-flash-lite"] },
    { sec: "models", key: "deepgram", label: "models_deepgram", help: "models_deepgram_h", type: "select", options: ["nova-3", "nova-2", "nova-3-general"] },
    { sec: "models", key: "language", label: "models_language", help: "models_language_h", type: "select", options: ["multi", "fr", "en", "es", "de", "it", "pt", "nl", "ja", "ko", "zh"] },
  ] },
  { id: "timing", title: "sec_timing", icon: "⏱", blurb: "sec_timing_b", fields: [
    { sec: "timing", key: "tickMs", label: "timing_tickMs", help: "timing_tickMs_h", type: "range", min: 250, max: 10_000, step: 250, fmt: ms },
    { sec: "timing", key: "maxTickGapMs", label: "timing_maxTickGapMs", help: "timing_maxTickGapMs_h", type: "range", min: 1000, max: 120_000, step: 1000, fmt: ms },
    { sec: "timing", key: "captionEveryMs", label: "timing_captionEveryMs", help: "timing_captionEveryMs_h", type: "range", min: 1000, max: 60_000, step: 1000, fmt: ms },
    { sec: "timing", key: "windowMs", label: "timing_windowMs", help: "timing_windowMs_h", type: "range", min: 5000, max: 120_000, step: 5000, fmt: ms },
    { sec: "timing", key: "highlightGapMs", label: "timing_highlightGapMs", help: "timing_highlightGapMs_h", type: "range", min: 0, max: 600_000, step: 10_000, fmt: ms },
    { sec: "timing", key: "excerptMs", label: "timing_excerptMs", help: "timing_excerptMs_h", type: "range", min: 2000, max: 60_000, step: 1000, fmt: ms },
    { sec: "timing", key: "toastMs", label: "timing_toastMs", help: "timing_toastMs_h", type: "range", min: 1000, max: 20_000, step: 500, fmt: ms },
  ] },
  { id: "decisions", title: "sec_decisions", icon: "◎", blurb: "sec_decisions_b", fields: [
    { sec: "decisions", key: "fireConfidenceFloor", label: "decisions_fireConfidenceFloor", help: "decisions_fireConfidenceFloor_h", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "decisions", key: "unsureBelow", label: "decisions_unsureBelow", help: "decisions_unsureBelow_h", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "decisions", key: "judgeMessages", label: "decisions_judgeMessages", help: "decisions_judgeMessages_h", type: "bool" },
    { sec: "decisions", key: "messageConcurrency", label: "decisions_messageConcurrency", help: "decisions_messageConcurrency_h", type: "number", min: 1, max: 16, step: 1 },
  ] },
  { id: "budget", title: "sec_budget", icon: "💸", blurb: "sec_budget_b", fields: [
    { sec: "budget", key: "sessionUsd", label: "budget_sessionUsd", help: "budget_sessionUsd_h", type: "range", min: 0, max: 50, step: 0.5, fmt: usd },
    { sec: "budget", key: "chatPerMinute", label: "budget_chatPerMinute", help: "budget_chatPerMinute_h", type: "number", min: 1, max: 5000, step: 10 },
    { sec: "budget", key: "chatMaxAgeMs", label: "budget_chatMaxAgeMs", help: "budget_chatMaxAgeMs_h", type: "range", min: 1000, max: 60_000, step: 1000, fmt: ms },
    { sec: "budget", key: "chatQueue", label: "budget_chatQueue", help: "budget_chatQueue_h", type: "number", min: 10, max: 5000, step: 10 },
  ] },
  { id: "replay", title: "sec_replay", icon: "▶", blurb: "sec_replay_b", fields: [
    { sec: "replay", key: "dryRun", label: "replay_dryRun", help: "replay_dryRun_h", type: "bool" },
  ] },
  { id: "autoRefine", title: "sec_autoRefine", icon: "✎", blurb: "sec_autoRefine_b", fields: [
    { sec: "autoRefine", key: "enabled", label: "autoRefine_enabled", help: "autoRefine_enabled_h", type: "bool" },
    { sec: "autoRefine", key: "emaBelow", label: "autoRefine_emaBelow", help: "autoRefine_emaBelow_h", type: "range", min: 0, max: 1, step: 0.05, fmt: pct },
    { sec: "autoRefine", key: "minSamples", label: "autoRefine_minSamples", help: "autoRefine_minSamples_h", type: "number", min: 1, max: 20, step: 1 },
    { sec: "autoRefine", key: "cooldownMs", label: "autoRefine_cooldownMs", help: "autoRefine_cooldownMs_h", type: "range", min: 10_000, max: 1_800_000, step: 10_000, fmt: ms },
    { sec: "autoRefine", key: "intervalMs", label: "autoRefine_intervalMs", help: "autoRefine_intervalMs_h", type: "range", min: 5000, max: 300_000, step: 5000, fmt: ms },
  ] },
  { id: "media", title: "sec_media", icon: "🎥", blurb: "sec_media_b", fields: [
    { sec: "media", key: "transcription", label: "media_transcription", help: "media_transcription_h", type: "bool" },
    { sec: "media", key: "vision", label: "media_vision", help: "media_vision_h", type: "bool" },
    { sec: "media", key: "hls", label: "media_hls", help: "media_hls_h", type: "bool" },
    { sec: "media", key: "dvrMinutes", label: "media_dvrMinutes", help: "media_dvrMinutes_h", type: "range", min: 5, max: 360, step: 5, fmt: (v) => `${v} min` },
    { sec: "media", key: "recordVideo", label: "media_recordVideo", help: "media_recordVideo_h", type: "bool" },
    { sec: "media", key: "frameWidth", label: "media_frameWidth", help: "media_frameWidth_h", type: "range", min: 128, max: 1280, step: 64, fmt: (v) => `${v} px` },
    { sec: "media", key: "frameEverySec", label: "media_frameEverySec", help: "media_frameEverySec_h", type: "range", min: 0.5, max: 30, step: 0.5, fmt: (v) => `${v} s` },
    { sec: "media", key: "audioKeepAlive", label: "media_audioKeepAlive", help: "media_audioKeepAlive_h", type: "bool" },
  ] },
  { id: "glm", title: "sec_glm", icon: "🛠", blurb: "sec_glm_b", fields: [
    { sec: "glm", key: "temperature", label: "glm_temperature", help: "glm_temperature_h", type: "range", min: 0, max: 1.5, step: 0.05, fmt: (v) => v.toFixed(2) },
    { sec: "glm", key: "maxTokens", label: "glm_maxTokens", help: "glm_maxTokens_h", type: "number", min: 256, max: 32_000, step: 256 },
  ] },
  { id: "assist", title: "sec_assist", icon: "🤝", blurb: "sec_assist_b", fields: [
    { sec: "assist", key: "sessionUsd", label: "assist_sessionUsd", help: "assist_sessionUsd_h", type: "range", min: 0, max: 5, step: 0.1, fmt: usd },
    { sec: "assist", key: "autoResolve", label: "assist_autoResolve", help: "assist_autoResolve_h", type: "bool" },
    { sec: "assist", key: "dedupe", label: "assist_dedupe", help: "assist_dedupe_h", type: "bool" },
    { sec: "assist", key: "thanks", label: "assist_thanks", help: "assist_thanks_h", type: "bool" },
    { sec: "assist", key: "thanksMinDiamonds", label: "assist_thanksMinDiamonds", help: "assist_thanksMinDiamonds_h", type: "number", min: 0, max: 100_000, step: 1 },
    { sec: "assist", key: "promises", label: "assist_promises", help: "assist_promises_h", type: "bool" },
    { sec: "assist", key: "faq", label: "assist_faq", help: "assist_faq_h", type: "bool" },
    { sec: "assist", key: "faqText", label: "assist_faqText", help: "assist_faqText_h", type: "textarea" },
    { sec: "assist", key: "poll", label: "assist_poll", help: "assist_poll_h", type: "bool" },
    { sec: "assist", key: "regime", label: "assist_regime", help: "assist_regime_h", type: "bool" },
    { sec: "assist", key: "degrade", label: "assist_degrade", help: "assist_degrade_h", type: "bool" },
    { sec: "assist", key: "repair", label: "assist_repair", help: "assist_repair_h", type: "bool" },
    { sec: "assist", key: "ruleHygiene", label: "assist_ruleHygiene", help: "assist_ruleHygiene_h", type: "bool" },
    { sec: "assist", key: "retention", label: "assist_retention", help: "assist_retention_h", type: "bool" },
    { sec: "assist", key: "diskFloorGb", label: "assist_diskFloorGb", help: "assist_diskFloorGb_h", type: "number", min: 1, max: 500, step: 1, unit: "GB" },
    { sec: "assist", key: "interruptibility", label: "assist_interruptibility", help: "assist_interruptibility_h", type: "bool" },
  ] },
];
const FIELD_BY_KEY = new Map<string, FieldDef>(SECTIONS.flatMap((s) => s.fields.map((f) => [`${f.sec}.${f.key}`, f] as [string, FieldDef])));

const toDraft = (s: PublicSettings): Draft => ({ tiktok: { ...s.tiktok }, keys: { ...s.keys }, models: { ...s.models }, timing: { ...s.timing }, decisions: { ...s.decisions }, budget: { ...s.budget }, replay: { ...s.replay }, autoRefine: { ...s.autoRefine }, media: { ...s.media }, glm: { ...s.glm }, assist: { ...s.assist } });

/** A number outside its field's range is invalid: Save stays disabled and the field says why, in the given language. */
const invalidReason = (key: string, v: unknown, lang: Lang): string | null => {
  const f = FIELD_BY_KEY.get(key);
  if (!f || (f.type !== "number" && f.type !== "range")) return null;
  const m = M[lang];
  const n = Number(v);
  if (!Number.isFinite(n)) return m.notANumber;
  if (f.min !== undefined && n < f.min) return fill(m.min, { n: f.min });
  if (f.max !== undefined && n > f.max) return fill(m.max, { n: f.max });
  return null;
};

function Field({ f, value, onChange, dirty, reconnect, invalid, test }: { f: FieldDef; value: string | number | boolean; onChange: (v: string | number | boolean) => void; dirty: boolean; reconnect: boolean; invalid: string | null; test?: () => void }) {
  const t = useT(M); const c = useT(COMMON);
  const [reveal, setReveal] = useState(false);
  const id = `set-${f.sec}-${f.key}`;
  const masked = typeof value === "string" && value.startsWith("••••");
  return (
    <div className={`field ${dirty ? "dirty" : ""} ${invalid ? "invalid" : ""}`}>
      <div className="field-head">
        <label htmlFor={id}>{t(f.label)}</label>
        {reconnect && <span className="badge mod" title={t("reconnectTitle")}>{t("reconnect")}</span>}
        {dirty && <span className="badge add">{t("unsaved")}</span>}
        {invalid && <span className="badge del">{invalid}</span>}
        <span className="grow" />
        {f.type === "range" && <span className="mono field-val">{f.fmt ? f.fmt(Number(value)) : String(value)}</span>}
      </div>
      {f.type === "text" && <input id={id} name={id} value={String(value)} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />}
      {f.type === "textarea" && <textarea id={id} name={id} value={String(value)} rows={5} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" />}
      {f.type === "secret" && (
        <div className="secret">
          {/* The mask stays until the user types: a focus alone never clears a stored key. */}
          <input id={id} name={id} type={reveal ? "text" : "password"} value={masked ? "" : String(value)} placeholder={masked ? t("storedPh", { tail: String(value).slice(-4) }) : t("notSet")} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
          <button type="button" className="icon" onClick={() => setReveal((v) => !v)} title={reveal ? t("hide") : t("show")} aria-label={reveal ? t("hideSecret") : t("showSecret")} aria-pressed={reveal}>{reveal ? "🙈" : "👁"}</button>
          {test && <button type="button" className="icon" onClick={test} title={t("testKey")}>{t("test")}</button>}
        </div>
      )}
      {f.type === "number" && <input id={id} name={id} type="number" inputMode="decimal" value={String(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} aria-invalid={!!invalid} autoComplete="off" data-1p-ignore="true" data-lpignore="true" />}
      {f.type === "range" && <input id={id} type="range" value={Number(value)} min={f.min} max={f.max} step={f.step} onChange={(e) => onChange(Number(e.target.value))} />}
      {f.type === "bool" && <label className="switch"><input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /><span className="track" /><span className="switch-label">{value ? c("on") : c("off")}</span></label>}
      {f.type === "select" && (
        <>
          <input id={id} name={id} list={`${id}-opts`} value={String(value)} onChange={(e) => onChange(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" data-form-type="other" />
          <datalist id={`${id}-opts`}>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</datalist>
        </>
      )}
      <p className="field-help">{t(f.help)}</p>
    </div>
  );
}

export const SettingsPanel = memo(function SettingsPanel({ settings, live, sound, setSound, muted, setMuted, notify, setNotify }: { settings: PublicSettings | null; live: boolean; sound: boolean; setSound: (v: boolean) => void; muted: boolean; setMuted: (v: boolean) => void; notify: boolean; setNotify: (v: boolean) => void }) {
  const t = useT(M); const c = useT(COMMON); const lang = useLang();
  const authProtected = useStore((s) => s.authProtected);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<PublicSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [active, setActive] = useState<string>("tiktok");
  const bodyRef = useRef<HTMLDivElement>(null);
  const loaded = draft !== null;

  // Adopt server settings when they change and there is nothing unsaved.
  useEffect(() => {
    if (!settings) return;
    if (!draft || !base || JSON.stringify(toDraft(base)) === JSON.stringify(draft)) { setDraft(toDraft(settings)); setBase(settings); }
    else setBase(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Section nav follows the scroll position.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => { const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]; if (top) setActive(top.target.id.replace(/^sec-/, "")); }, { root, threshold: 0.2 });
    root.querySelectorAll("section[id]").forEach((s) => io.observe(s));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const dirtyKeys = useMemo(() => {
    if (!draft || !base) return new Set<string>();
    const b = toDraft(base);
    const d = new Set<string>();
    for (const sec of Object.keys(draft) as Sec[]) for (const k of Object.keys(draft[sec])) if (draft[sec][k] !== b[sec][k] && !(draft[sec][k] === "" && typeof b[sec][k] === "string" && String(b[sec][k]).startsWith("••••"))) d.add(`${sec}.${k}`);
    return d;
  }, [draft, base]);
  const invalid = useMemo(() => { const out = new Map<string, string>(); if (!draft) return out; for (const key of dirtyKeys) { const [sec, k] = key.split(".") as [Sec, string]; const r = invalidReason(key, draft[sec][k], lang); if (r) out.set(key, r); } return out; }, [draft, dirtyKeys, lang]);
  const patch = useMemo(() => {
    if (!draft) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const key of dirtyKeys) { const [sec, k] = key.split(".") as [Sec, string]; (out[sec] ??= {})[k] = draft[sec][k]; }
    return out;
  }, [draft, dirtyKeys]);
  const needsReconnect = [...dirtyKeys].some((k) => settings?.reconnectFields.includes(k)) && live;

  const save = async () => {
    if (!dirtyKeys.size || invalid.size) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api.saveSettings(patch);
      setBase(r.settings); setDraft(toDraft(r.settings));
      setMsg({ ok: true, text: `${plural(dirtyKeys.size, t("savedOne"), t("savedMany"))}${needsReconnect ? t("reconnectToApply") : ""}` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setSaving(false); }
  };
  const discard = () => { if (base) setDraft(toDraft(base)); setMsg(null); };
  const reset = async () => {
    if (!(await confirm({ title: t("resetTitle"), body: t("resetBody"), confirmLabel: t("reset"), danger: true }))) return;
    try { const r = await api.resetSettings(); setBase(r.settings); setDraft(toDraft(r.settings)); setMsg({ ok: true, text: t("resetDone") }); } catch { /* toasted */ }
  };
  const test = async (which: "openrouter" | "deepgram" | "models") => {
    setTests((x) => ({ ...x, [which]: { ok: true, text: t("testing") } }));
    const value = which === "models" ? undefined : String(draft?.keys[which] ?? "");
    try { const r = await api.testSetting(which, value || undefined); setTests((x) => ({ ...x, [which]: { ok: r.ok, text: `${r.ok ? "✓" : "✗"} ${r.detail ?? ""}${r.ms ? ` · ${r.ms} ms` : ""}` } })); }
    catch (e) { setTests((x) => ({ ...x, [which]: { ok: false, text: `✗ ${(e as Error).message}` } })); }
  };
  const exportJson = () => {
    if (!base) return;
    const { keys: _k, tiktok, secrets: _s, reconnectFields: _r, updatedAt: _u, ...rest } = base;
    const blob = new Blob([JSON.stringify({ ...rest, tiktok: { username: tiktok.username } }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "awesome-jev-settings.json"; a.click(); URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try { const j = JSON.parse(await file.text()); const r = await api.saveSettings(j); setBase(r.settings); setDraft(toDraft(r.settings)); setMsg({ ok: true, text: t("imported", { name: file.name }) }); }
    catch (e) { setMsg({ ok: false, text: t("importFailed", { msg: (e as Error).message }) }); }
  };
  const askNotify = async () => { if (!notify) { const p = await requestNotifications(); if (p !== "granted") { toast({ kind: "error", title: t("notifBlocked") }); return; } } setNotify(!notify); };

  if (!draft || !settings) return <div className="empty">{t("loading")}</div>;
  const set = (sec: Sec, k: string, v: string | number | boolean) => setDraft((d) => (d ? { ...d, [sec]: { ...d[sec], [k]: v } } : d));
  const dirtyIn = (sec: Sec) => [...dirtyKeys].filter((k) => k.startsWith(`${sec}.`)).length;
  const go = (id: string) => { setActive(id); document.getElementById(`sec-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }); };

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("navAria")}>
        {SECTIONS.map((s) => <button key={s.id} className={active === s.id ? "on" : ""} aria-current={active === s.id ? "true" : undefined} onClick={() => go(s.id)}><span>{s.icon}</span>{t(s.title)}{dirtyIn(s.id) ? <span className="count new">{dirtyIn(s.id)}</span> : null}</button>)}
        <button className={active === "ui" ? "on" : ""} onClick={() => go("ui")}><span>🖥</span>{t("thisBrowser")}</button>
        <span className="grow" />
        <div className="settings-io">
          <button className="chip-btn" onClick={exportJson} title={t("exportTitle")}>{t("export")}</button>
          <label className="chip-btn" title={t("importTitle")}>{t("import")}<input type="file" accept="application/json" hidden aria-label={t("importAria")} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.currentTarget.value = ""; }} /></label>
          <button className="chip-btn danger" onClick={reset}>{t("resetBtn")}</button>
        </div>
      </nav>
      <div className="settings-body" ref={bodyRef}>
        {SECTIONS.map((s) => (
          <section key={s.id} id={`sec-${s.id}`} className="settings-section panel" aria-labelledby={`sec-${s.id}-h`}>
            <header className="settings-head"><span className="settings-icon" aria-hidden>{s.icon}</span><div><h3 id={`sec-${s.id}-h`}>{t(s.title)}</h3><p>{t(s.blurb)}</p></div></header>
            <div className="fields">
              {s.fields.map((f) => (
                <Field key={f.key} f={f} value={draft[s.id][f.key]} onChange={(v) => set(s.id, f.key, v)} dirty={dirtyKeys.has(`${s.id}.${f.key}`)} reconnect={settings.reconnectFields.includes(`${s.id}.${f.key}`)} invalid={invalid.get(`${s.id}.${f.key}`) ?? null}
                  test={f.type === "secret" && (f.key === "openrouter" || f.key === "deepgram") ? () => test(f.key as "openrouter" | "deepgram") : undefined} />
              ))}
              {s.id === "keys" && (["openrouter", "deepgram"] as const).map((k) => tests[k] && <div key={k} className={`test-result ${tests[k].ok ? "ok" : "bad"}`} role="status">{k}: {tests[k].text}</div>)}
              {s.id === "models" && <div className="field-row"><button className="chip-btn" onClick={() => test("models")}>{t("checkModels")}</button>{tests.models && <span className={`test-result ${tests.models.ok ? "ok" : "bad"}`} role="status">{tests.models.text}</span>}</div>}
            </div>
          </section>
        ))}
        <section id="sec-ui" className="settings-section panel" aria-labelledby="sec-ui-h">
          <header className="settings-head"><span className="settings-icon" aria-hidden>🖥</span><div><h3 id="sec-ui-h">{t("thisBrowser")}</h3><p>{t("prefsBlurb")}</p></div></header>
          <div className="fields">
            <div className="field"><div className="field-head"><label htmlFor="pref-lang">{c("language")}</label></div><select id="pref-lang" aria-label="language" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>{LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select><p className="field-help">{t("langHelp")}</p></div>
            <div className="field"><div className="field-head"><label htmlFor="pref-sound">{t("chime")}</label></div><label className="switch"><input id="pref-sound" type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} /><span className="track" /><span className="switch-label">{sound ? c("on") : c("off")}</span></label><p className="field-help">{t("chimeHelp")} <Kbd k="s" />.</p></div>
            <div className="field"><div className="field-head"><label htmlFor="pref-notify">{t("notifications")}</label></div><label className="switch"><input id="pref-notify" type="checkbox" checked={notify && notificationPermission() === "granted"} onChange={askNotify} /><span className="track" /><span className="switch-label">{notify && notificationPermission() === "granted" ? c("on") : notificationPermission() === "denied" ? t("blocked") : c("off")}</span></label><p className="field-help">{t("notifHelp")}</p></div>
            {authProtected && <div className="field"><div className="field-head"><label htmlFor="pref-signout">{t("access")}</label><small>{t("accessNote")}</small></div><button id="pref-signout" onClick={() => void api.logout().then(() => location.reload()).catch(() => {})}>{t("signOut")}</button></div>}
            <div className="field"><div className="field-head"><label htmlFor="pref-muted">{t("streamAudio")}</label></div><label className="switch"><input id="pref-muted" type="checkbox" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} /><span className="track" /><span className="switch-label">{muted ? t("muted") : t("playing")}</span></label><p className="field-help">{t("audioHelp")} <Kbd k="m" />.</p></div>
          </div>
        </section>
        <div className="settings-meta muted mono">{t("meta", { date: new Date(settings.updatedAt).toLocaleString(locale()) })}</div>
      </div>
      <div className={`savebar ${dirtyKeys.size ? "show" : ""}`} role="status">
        <span>{plural(dirtyKeys.size, t("unsavedOne"), t("unsavedMany"))}{needsReconnect ? t("someReconnect") : ""}{invalid.size ? t("invalid", { n: invalid.size }) : ""}</span>
        <span className="grow" />
        <button onClick={discard} disabled={saving}>{t("discard")}</button>
        <button className="primary" onClick={save} disabled={saving || !dirtyKeys.size || invalid.size > 0}>{saving ? <><span className="spinner sm" /> {t("saving")}</> : c("save")}</button>
      </div>
      {msg && !dirtyKeys.size && <div className={`savemsg ${msg.ok ? "ok" : "bad"}`} role="status">{msg.text}</div>}
    </div>
  );
});

/** Used by the app to guard a tab switch / unload while a draft is unsaved. */
export const hasUnsavedSettings = () => !!document.querySelector(".savebar.show");
