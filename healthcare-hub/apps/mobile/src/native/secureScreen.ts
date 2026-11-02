import * as ScreenCapture from 'expo-screen-capture';

/**
 * Screens that show patient details: no screenshots or recordings (Android FLAG_SECURE) and the iOS
 * app switcher shows a blur instead of the screen.
 */
export function useSecureScreen(): void {
  ScreenCapture.usePreventScreenCapture('patient');
}

export async function protectAppSwitcher(): Promise<void> {
  await ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
}
