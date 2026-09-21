import type { Messages } from "./index";

/** Words shared by several components; feature messages live next to their component. */
export const COMMON = {
  en: {
    cancel: "Cancel", save: "Save", close: "Close", undo: "Undo", remove: "Remove", edit: "Edit", done: "Done", copy: "Copy", download: "Download", reload: "Reload",
    audio: "audio", video: "video", chat: "chat", all: "all", room: "room", perMessage: "per message", local: "local", paused: "paused",
    live: "live", offline: "offline", connecting: "connecting", error: "error", replay: "replay",
    yes: "yes", no: "no", on: "on", off: "off", now: "now", none: "none",
    language: "Language",
  },
  fr: {
    cancel: "Annuler", save: "Enregistrer", close: "Fermer", undo: "Annuler la suppression", remove: "Supprimer", edit: "Modifier", done: "Terminé", copy: "Copier", download: "Télécharger", reload: "Recharger",
    audio: "audio", video: "vidéo", chat: "chat", all: "tout", room: "salle", perMessage: "par message", local: "local", paused: "en pause",
    live: "en direct", offline: "hors ligne", connecting: "connexion", error: "erreur", replay: "relecture",
    yes: "oui", no: "non", on: "activé", off: "désactivé", now: "maintenant", none: "aucun",
    language: "Langue",
  },
} satisfies Messages<string>;
