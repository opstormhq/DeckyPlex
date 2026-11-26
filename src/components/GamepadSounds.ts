import { call } from '@decky/api';
import { afterPatch, callOriginal, ESteamUISound, findSP, getFocusNavController, replacePatch, type GamepadEvent, type Patch } from '@decky/ui';

const pluginSurface = '[data-deckyplex-browser], [data-deckyplex-quick-player], [data-deckyplex-settings], [data-deckyplex-video], .deckyplex-modal';
const interactionSounds = new Set([
  ESteamUISound.BasicNav, ESteamUISound.FailedNav, ESteamUISound.PagedNavigation, ESteamUISound.ChangeTabs,
  ESteamUISound.DefaultOk, ESteamUISound.ToggleOn, ESteamUISound.ToggleOff,
  ESteamUISound.SliderUp, ESteamUISound.SliderDown, ESteamUISound.ShowModal, ESteamUISound.HideModal,
]);
const interactionFiles = new Set([
  'bumper_end.wav', 'deck_ui_bumper_end_02.wav', 'deck_ui_default_activation.wav',
  'deck_ui_misc_10.wav', 'deck_ui_navigation.wav', 'deck_ui_tile_scroll.wav',
  'deck_ui_tab_transition_01.wav', 'deck_ui_switch_toggle_on.wav', 'deck_ui_switch_toggle_off.wav',
  'deck_ui_slider_up.wav', 'deck_ui_slider_down.wav', 'deck_ui_show_modal.wav', 'deck_ui_hide_modal.wav',
]);
const inputEvents = ['vgp_onbuttondown', 'vgp_onbuttonup', 'keydown', 'pointerdown', 'click'];
const inputWindows = new Map<Window, () => void>();

let muted = false;
let audioPatch: Patch | undefined;
let lastInput: { inside: boolean; until: number } | undefined;
let reportedPlayback = false;
let reportedMissingHook = false;

function insideDeckyPlex(target: EventTarget | null | undefined) {
  return !!(target as Element | null)?.closest?.(pluginSurface);
}

function trackInput(event: Event) {
  lastInput = { inside: insideDeckyPlex(event.target), until: performance.now() + 50 };
}

function watchInput(view: Window) {
  if (inputWindows.has(view)) return;
  try {
    const remove = view.removeEventListener.bind(view);
    for (const event of inputEvents) view.addEventListener(event, trackInput, true);
    inputWindows.set(view, () => {
      for (const event of inputEvents) remove(event, trackInput, true);
    });
  } catch {
    // Steam can move focus into an external web page.
  }
}

function soundBelongsToDeckyPlex() {
  const steam = window.SteamUIStore ?? findSP?.()?.SteamUIStore;
  const navigation = steam?.NavigationManager ?? getFocusNavController?.();
  const context = navigation?.GetActiveContext?.() ?? navigation?.m_ActiveContext;
  const view = context?.ActiveWindow ?? steam?.GetFocusedWindowInstance?.()?.BrowserWindow ?? window;
  watchInput(view);
  // Steam can queue a sound as a button closes a dialog or changes pages.
  if (lastInput && lastInput.until > performance.now()) return lastInput.inside;
  const node = (context?.m_LastActiveNavTree ?? context?.m_LastActiveFocusNavTree)?.GetLastFocusedNode?.();
  try {
    return insideDeckyPlex(node?.Element ?? view.document.activeElement);
  } catch {
    return false;
  }
}

function reportMutedPlayback() {
  if (reportedPlayback) return;
  reportedPlayback = true;
  void call('log_message', 'UI sounds: suppressed a native DeckyPlex cue').catch(() => {});
}

export function setGamepadSoundsMuted(value: boolean) {
  muted = value;
  if (!value) {
    audioPatch?.unpatch();
    audioPatch = undefined;
    for (const remove of inputWindows.values()) remove();
    inputWindows.clear();
    lastInput = undefined;
    reportedPlayback = false;
    reportedMissingHook = false;
    return;
  }
  if (audioPatch) return;
  const steamWindow = window.SteamUIStore ? window : findSP?.();
  const audio = steamWindow?.SteamUIStore?.GamepadUIAudio;
  const output = (audio?.AudioPlaybackManager ?? audio?.m_AudioPlaybackManager) as unknown as {
    PlayAudioURLWithRepeats?: unknown; PlayAudioURL?: unknown;
  } | undefined;
  const playMethod = typeof output?.PlayAudioURLWithRepeats === 'function' ? 'PlayAudioURLWithRepeats'
    : typeof output?.PlayAudioURL === 'function' ? 'PlayAudioURL' : undefined;
  try {
    if (playMethod) {
      // This also catches native controls that request a sound file directly.
      // Steam starts playback asynchronously, so the handle can be canceled here.
      audioPatch = afterPatch(output, playMethod, ([url], playback) => {
        const filename = typeof url === 'string' ? /(?:^|\/)([^/?#]+\.wav)(?:[?#].*)?$/i.exec(url)?.[1] : undefined;
        if (muted && filename && interactionFiles.has(filename) && typeof playback?.StopPlayback === 'function'
            && soundBelongsToDeckyPlex()) {
          playback.StopPlayback();
          reportMutedPlayback();
        }
        return playback;
      });
    } else if (typeof audio?.PlayNavSoundInternal === 'function') {
      audioPatch = replacePatch(audio, 'PlayNavSoundInternal', ([sound]) => {
        if (!muted || !interactionSounds.has(sound) || !soundBelongsToDeckyPlex()) return callOriginal;
        audio.m_pendingSoundHandle = null;
        reportMutedPlayback();
      });
    }
  } catch { /* Keep the component-level mute on Steam builds with a different audio API. */ }
  if (audioPatch) {
    watchInput(window);
    if (steamWindow) watchInput(steamWindow);
    void call('log_message', `UI sounds: mute filter attached (${playMethod ?? 'navigation callback'})`).catch(() => {});
  } else if (!reportedMissingHook) {
    reportedMissingHook = true;
    void call('log_message', 'UI sounds: Steam audio hook unavailable').catch(() => {});
  }
}

export function gamepadNavigationSoundProps(disable = muted) {
  return { disableNavSounds: disable || undefined };
}

export function playNavigationSound(event: Event) {
  if (!muted && (event as GamepadEvent).detail?.button !== undefined) {
    window.SteamUIStore?.GamepadUIAudio?.PlayNavSound?.(ESteamUISound.BasicNav);
  }
}

export function selectWithSound(event: Pick<Event, 'preventDefault'>, select: () => void) {
  const detail = (event as GamepadEvent).detail;
  if (detail?.is_repeat) return;
  if (!muted && detail?.button !== undefined) {
    window.SteamUIStore?.GamepadUIAudio?.PlayNavSound?.(ESteamUISound.DefaultOk);
  }
  select();
}
