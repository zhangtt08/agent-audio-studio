import { useSyncExternalStore } from 'react';
import { player, type Snap } from './player';

export function useSnap(): Snap {
  return useSyncExternalStore(player.subscribe, player.getSnap, player.getSnap);
}

export { player };
