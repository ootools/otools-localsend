// Shim for @tauri-apps/plugin-notification in OTools plugin runtime.
// Falls back to browser Notification API; no Tauri IPC needed in plugin context.

export async function isPermissionGranted(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  return Notification.permission === 'granted';
}

export async function requestPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'denied';
  }
  return Notification.requestPermission();
}

export async function sendNotification(options: { title: string; body?: string }): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return;
  }
  if (Notification.permission === 'granted') {
    new Notification(options.title, { body: options.body });
  }
}
