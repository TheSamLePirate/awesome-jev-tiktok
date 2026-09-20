/** Browser notifications, only while the tab is hidden and only after the user opted in. */
export const notificationsSupported = () => typeof Notification !== "undefined";
export const notificationPermission = (): NotificationPermission | "unsupported" => (notificationsSupported() ? Notification.permission : "unsupported");
export const requestNotifications = async () => (notificationsSupported() ? Notification.requestPermission() : "denied");

export function notifyIfHidden(title: string, body: string, tag: string) {
  if (!notificationsSupported() || Notification.permission !== "granted" || document.visibilityState === "visible") return;
  try { const n = new Notification(title, { body, tag, silent: true }); n.onclick = () => { window.focus(); n.close(); }; setTimeout(() => n.close(), 8000); } catch {}
}
