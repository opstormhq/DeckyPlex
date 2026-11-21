import { ESteamUISound, type GamepadEvent } from '@decky/ui';

export function playNavigationSound(event: Event) {
  if ((event as GamepadEvent).detail?.button !== undefined) {
    window.SteamUIStore?.GamepadUIAudio?.PlayNavSound?.(ESteamUISound.BasicNav);
  }
}

export function selectWithSound(event: Pick<Event, 'preventDefault'>, select: () => void) {
  const detail = (event as GamepadEvent).detail;
  if (detail?.is_repeat) return;
  if (detail?.button !== undefined) {
    window.SteamUIStore?.GamepadUIAudio?.PlayNavSound?.(ESteamUISound.DefaultOk);
  }
  select();
}
