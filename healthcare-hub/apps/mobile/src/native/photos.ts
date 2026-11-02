import * as ImagePicker from 'expo-image-picker';

/** Takes one photo with the camera (no gallery: evidence is captured at the time). */
export async function takePhoto(): Promise<{ uri: string; mime: 'image/jpeg' } | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) return null;
  const r = await ImagePicker.launchCameraAsync({
    quality: 0.6,
    exif: false,
    allowsEditing: false,
  });
  if (r.canceled || !r.assets[0]) return null;
  return { uri: r.assets[0].uri, mime: 'image/jpeg' };
}
