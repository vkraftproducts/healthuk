import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Api } from '../core/api';
import { routeForPush, type PushRoute } from '../core/push';

// Notifications show only the generic title/body the server sends; nothing is added on the device.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Registers this device for push (POST /devices/register-push). Push is optional: no token, no push. */
export async function registerForPush(
  api: Api,
  deviceId: string,
  appVersion: string | null,
  projectId: string | undefined,
): Promise<void> {
  let pushToken: string | null = null;
  if (Device.isDevice) {
    const perm = await Notifications.requestPermissionsAsync();
    if (perm.granted)
      pushToken = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined))
        .data;
  }
  await api.post('/api/v1/devices/register-push', {
    deviceId,
    platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
    pushToken,
    ...(appVersion ? { appVersion } : {}),
  });
}

/** Calls back with the screen to open when a notification is tapped (including cold start). */
export function onPushTap(open: (r: PushRoute) => void): () => void {
  const last = Notifications.getLastNotificationResponse();
  const first = last ? routeForPush(last.notification.request.content.data) : null;
  if (first) open(first);
  const sub = Notifications.addNotificationResponseReceivedListener((e) => {
    const r = routeForPush(e.notification.request.content.data);
    if (r) open(r);
  });
  return () => sub.remove();
}

export const clearNotifications = () => Notifications.dismissAllNotificationsAsync();
