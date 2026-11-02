import NetInfo from '@react-native-community/netinfo';

/** Connectivity: online means a reachable internet connection, not just Wi-Fi association. */
export function watchConnectivity(cb: (online: boolean) => void): () => void {
  return NetInfo.addEventListener((s) => cb(!!s.isConnected && s.isInternetReachable !== false));
}
