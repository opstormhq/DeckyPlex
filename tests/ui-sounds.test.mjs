import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule as loadSourceModule } from './fixtures/frontend.mjs';

const loadModule = (path, globals) => loadSourceModule(new URL(path, import.meta.url), globals);

function fixture(useAudioOutput = false) {
  const patcher = loadModule('../node_modules/@decky/ui/dist/utils/patcher.js', { console: { debug() {} } });
  const ESteamUISound = loadModule('../node_modules/@decky/ui/dist/globals/shared/enums.js', {}).ESteamUISound;
  const { BasicNav, DefaultOk, FailedNav, HideModal, ToastMessage } = ESteamUISound;
  const button = selector => ({ closest: selectors => selectors.split(', ').includes(selector) ? {} : null });
  const steamMenu = button('.steam-menu');
  const browser = button('[data-deckyplex-browser]');
  const quickPlayer = button('[data-deckyplex-quick-player]');
  const modal = button('.deckyplex-modal');
  const played = [];
  const pending = [];
  const playback = [];
  const messages = [];
  const listeners = new Map();
  let gamepadFocus = steamMenu;
  let time = 0;
  const filenames = new Map([
    [BasicNav, 'deck_ui_misc_10.wav'], [DefaultOk, 'deck_ui_default_activation.wav'],
    [FailedNav, 'deck_ui_bumper_end_02.wav'], [HideModal, 'deck_ui_hide_modal.wav'],
    [ToastMessage, 'deck_ui_message_toast.wav'],
  ]);
  const output = {
    PlayAudioURLWithRepeats(url) {
      let stopped = false;
      playback.push(() => { if (!stopped) played.push(url); });
      return { StopPlayback() { stopped = true; } };
    },
  };
  const audio = {
    m_pendingSoundHandle: null,
    AudioPlaybackManager: useAudioOutput ? output : undefined,
    PlayNavSound(sound) {
      this.m_pendingSoundHandle = pending.length;
      pending.push(this.PlayNavSoundInternal.bind(this, sound));
    },
    PlayNavSoundInternal(sound) {
      this.m_pendingSoundHandle = null;
      if (useAudioOutput) output.PlayAudioURLWithRepeats(`/sounds/${filenames.get(sound)}`);
      else played.push(sound);
    },
  };
  const steamWindow = {
    document: { activeElement: steamMenu },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  const context = {
    ActiveWindow: steamWindow,
    m_LastActiveNavTree: { GetLastFocusedNode: () => ({ Element: gamepadFocus }) },
  };
  steamWindow.SteamUIStore = { GamepadUIAudio: audio, NavigationManager: { GetActiveContext: () => context } };
  const sounds = loadModule('../src/components/GamepadSounds.ts', {
    require: name => name === '@decky/api'
      ? { call: async (_method, message) => { messages.push(message); } }
      : { ...patcher, ESteamUISound },
    window: steamWindow,
    performance: { now: () => time },
  });
  // The Steam controller keeps a reference to the request method before the plugin loads.
  const requestSound = audio.PlayNavSound.bind(audio);
  return {
    audio, output, sounds, played, listeners, messages, browser, quickPlayer, modal, steamMenu,
    BasicNav, DefaultOk, FailedNav, HideModal, ToastMessage,
    focus(target) { gamepadFocus = target; },
    input(name, target) { listeners.get(name)?.({ target }); },
    request(sound) { requestSound(sound); },
    flush() { pending.shift()(); },
    play() { playback.shift()(); },
    advance(ms) { time += ms; },
  };
}

test('the playback manager cancels native sound files before the audio plays', () => {
  const ui = fixture(true);
  const original = ui.output.PlayAudioURLWithRepeats;
  ui.sounds.setGamepadSoundsMuted(true);
  ui.focus(ui.browser);
  ui.request(ui.BasicNav);
  ui.flush();
  ui.play();
  ui.output.PlayAudioURLWithRepeats('https://steamloopback.host/sounds/deck_ui_default_activation.wav?v=1');
  ui.play();
  assert.deepEqual(ui.played, []);
  assert.ok(ui.messages.some(message => message.includes('suppressed a native')));
  ui.request(ui.ToastMessage);
  ui.flush();
  ui.play();
  ui.focus(ui.steamMenu);
  ui.request(ui.BasicNav);
  ui.flush();
  ui.play();
  assert.deepEqual(ui.played, ['/sounds/deck_ui_message_toast.wav', '/sounds/deck_ui_misc_10.wav']);
  ui.sounds.setGamepadSoundsMuted(false);
  assert.equal(ui.output.PlayAudioURLWithRepeats, original);
});

test('native focus, failed movement, and button sounds follow DeckyPlex mute', () => {
  const ui = fixture();
  ui.sounds.setGamepadSoundsMuted(true);
  for (const target of [ui.browser, ui.quickPlayer, ui.modal]) {
    ui.focus(target);
    for (const sound of [ui.BasicNav, ui.FailedNav, ui.DefaultOk]) {
      ui.request(sound);
      ui.flush();
      assert.equal(ui.audio.m_pendingSoundHandle, null);
    }
  }
  assert.deepEqual(ui.played, []);
  ui.request(ui.ToastMessage);
  ui.flush();
  ui.focus(ui.steamMenu);
  ui.request(ui.BasicNav);
  ui.flush();
  assert.deepEqual(ui.played, [ui.ToastMessage, ui.BasicNav]);
});

test('a plugin action stays quiet after moving focus, and disabling mute restores native sound', () => {
  const ui = fixture();
  const original = ui.audio.PlayNavSoundInternal;
  ui.sounds.setGamepadSoundsMuted(true);
  ui.focus(ui.modal);
  ui.input('click', ui.modal);
  ui.request(ui.HideModal);
  ui.focus(ui.steamMenu);
  ui.advance(10);
  ui.flush();
  assert.deepEqual(ui.played, []);

  ui.input('vgp_onbuttondown', ui.steamMenu);
  ui.request(ui.DefaultOk);
  ui.flush();
  assert.deepEqual(ui.played, [ui.DefaultOk]);

  ui.sounds.setGamepadSoundsMuted(false);
  assert.equal(ui.audio.PlayNavSoundInternal, original);
  assert.equal(ui.listeners.size, 0);
  ui.focus(ui.browser);
  ui.request(ui.BasicNav);
  ui.flush();
  assert.deepEqual(ui.played, [ui.DefaultOk, ui.BasicNav]);
});
