import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { hostModules, jsxRuntime, loadModule, nodes, nodeText, renderHooks } from './fixtures/frontend.mjs';
import { retryPlexRead } from '../src/components/PlexRead.ts';

const connected = { has_plex_token: true, selected_server_id: 'server', selected_server_url: 'https://fixture.invalid' };
const tracks = [
  { id: '1', title: 'First Track', artist: 'Test Artist', thumb: 'album-cover' },
  { id: '2', title: 'Second Track', artist: 'Test Artist', thumb: 'album-cover' },
];

function fixture({ settings = connected, playbackState = 'playing', viewer, rpc } = {}) {
  const host = renderHooks();
  const actions = [];
  const events = new Map();
  const subscriptions = new Map();
  const buttons = { CANCEL: 2, SECONDARY: 3 };
  const log = name => (...args) => actions.push([name, ...args]);
  const document = {
    body: {}, defaultView: {
      requestAnimationFrame(callback) { callback(); return 1; },
      cancelAnimationFrame() {},
    },
  };
  document.activeElement = document.body;
  const button = (name, region, closest = () => null) => ({
    region, closest, isConnected: true,
    contains(node) { return node === this; },
    matches(selector) { return selector !== ':disabled'; },
    focus() { document.activeElement = this; actions.push(['focus', name]); },
  });
  const primary = button('primary', 'header');
  const playPause = button('play/pause', 'controls');
  const queueToggle = button('queue toggle', 'controls');
  const queueRow = button('queue row', 'queue');
  const activeScrubber = button('scrubber', 'controls', selector => selector === '[data-video-scrubbing]' ? true : null);
  const heading = { ownerDocument: document, isConnected: true, scrollIntoView: log('scroll top') };
  const controls = { contains: node => node.region === 'controls', querySelector: () => null };
  const queue = { contains: node => node.region === 'queue', querySelectorAll: () => [] };
  const root = {
    ownerDocument: document,
    contains: node => Boolean(node.region),
    querySelector: () => primary,
    addEventListener(event, listener) { events.set(event, listener); },
    removeEventListener(event) { events.delete(event); },
  };
  const playing = playbackState !== 'stopped';
  const player = {
    playbackState, track: playing ? tracks[0] : undefined, queue: playing ? tracks : [], queueIndex: playing ? 0 : -1,
    progress: playing ? 10 : 0, duration: playing ? 180 : 0, volume: 50, localVolume: 50,
    play: log('play'), pause: log('pause'), stop: log('stop'), skipNext: log('next'), skipPrevious: log('previous'),
    removeFromQueue: log('remove'), playQueueIndex: log('select track'), setLocalMuted: log('mute'),
    loadMusicArtwork: async () => '',
  };
  const { QuickPlayer } = loadModule(new URL('../src/components/QuickPlayer.tsx', import.meta.url), {
    require: hostModules({
      react: host.react, 'react/jsx-runtime': jsxRuntime,
      '@decky/ui': {
        Button: 'Button', Focusable: 'Focusable', SliderField: 'SliderField',
        GamepadButton: buttons, NavEntryPositionPreferences: { MAINTAIN_X: 0, PREFERRED_CHILD: 1 },
        Navigation: { CloseSideMenus: log('close tray') },
      },
      '@decky/api': { call: async (...args) => rpc ? rpc(...args) : settings, useQuickAccessVisible: () => true },
      'react-icons/fa': new Proxy({}, { get: (_icons, key) => key }),
      'react-icons/md': { MdPictureInPictureAlt: 'PiP' },
      '../context/PlayerContext': { usePlayer: () => player },
      './GamepadSounds': { setGamepadSoundsMuted() {} },
      './PlexMediaUrl': { plexMediaUrl: url => url },
      './InterfaceTheme': { InterfaceThemeStyles: 'InterfaceThemeStyles' },
      './InlineSpinner': { InlineSpinner: 'InlineSpinner' },
      './VideoScrubber': { VideoScrubber: 'VideoScrubber' },
      './VideoPlayback': { useViewerPlayback: () => viewer, usePausedVideo: () => null },
      './VideoQueue': { episodeLabel: item => item.title },
      './GamePip': { useGamePipPlayback: () => null },
      './PlexRead': { retryPlexRead },
    }),
    window: {
      addEventListener(event, listener) { subscriptions.set(event, listener); },
      removeEventListener(event) { subscriptions.delete(event); },
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  const props = {
    onLogin: log('login'), onBrowse: log('browse'), onSettings: log('settings'),
    onExpandPip: log('expand'), onResumeVideo: log('resume'),
  };
  const findButton = (tree, title) => tree.find(node => node.type === 'Button' && nodeText(node) === title);
  let tree;
  function render() {
    host.render(() => QuickPlayer(props), result => {
      tree = nodes(result);
      const attach = (node, value) => { if (node?.props.ref) node.props.ref.current = value; };
      attach(tree[0], root);
      attach(tree.find(node => node.props['data-quick-heading'] === ''), heading);
      attach(tree.find(node => node.props['data-quick-heading-action'] === ''), primary);
      attach(tree.find(node => node.props['data-quick-primary'] === true), playPause);
      attach(tree.find(node => node.type === 'Focusable' && node.props.ref), controls);
      attach(tree.find(node => node.props.style?.overscrollBehavior === 'contain'), queue);
      attach(findButton(tree, 'Queue · 1/2') ?? findButton(tree, 'Hide queue'), queueToggle);
    });
    return tree;
  }
  function notify(detail) {
    subscriptions.get('deckyplex-settings-change')({ detail });
  }
  render();
  notify(settings);
  render();
  return {
    actions, render, notify, primary, queueRow, playPause, activeScrubber, player,
    find: title => findButton(tree, title),
    label: title => tree.find(node => node.props['aria-label'] === title),
    cancel(target, repeating = false) {
      const event = {
        target, detail: { button: buttons.CANCEL, is_repeat: repeating },
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      events.get('vgp_onbuttondown')(event);
      return Boolean(event.prevented && event.stopped);
    },
  };
}

test('B collapses the queue from an entry and leaves it open from playback controls', () => {
  const view = fixture();
  view.find('Queue · 1/2').props.onClick();
  view.render();
  assert.ok(view.find('Hide queue'));
  assert.equal(view.cancel(view.activeScrubber), false);
  assert.equal(view.cancel(view.playPause), true);
  assert.equal(view.actions.at(-2)[1], 'primary');
  view.render();
  assert.ok(view.find('Hide queue'));
  assert.equal(view.cancel(view.queueRow), true);
  view.render();
  assert.ok(view.find('Queue · 1/2'));
  assert.deepEqual(view.actions.at(-1), ['focus', 'queue toggle']);
});

test('B at Browse closes the tray only during playback with the option enabled', () => {
  const playing = fixture();
  assert.equal(playing.cancel(playing.playPause), true);
  assert.equal(playing.cancel(playing.primary, true), true);
  assert.equal(playing.actions.some(([name]) => name === 'close tray'), false);
  assert.equal(playing.cancel(playing.primary), true);
  assert.deepEqual(playing.actions.at(-1), ['close tray']);
  for (const options of [
    { playbackState: 'stopped' }, { playbackState: 'paused' },
    { settings: { ...connected, quick_player_close_tray_on_back: false } },
  ]) {
    const view = fixture(options);
    assert.equal(view.cancel(view.primary), false);
    assert.deepEqual(view.actions, []);
  }
});

test('signed-out and direct-local headers choose the correct action without exposing idle transport controls', () => {
  const view = fixture({ playbackState: 'stopped', settings: { has_plex_token: false } });
  view.find('Log in').props.onClick();
  assert.deepEqual(view.actions, [['login']]);
  assert.equal(view.label('Play'), undefined);
  assert.equal(view.label('Stop'), undefined);
  view.notify({ has_plex_token: false, hide_quick_login: true });
  view.render();
  assert.equal(view.find('Log in'), undefined);
  view.notify({ ...connected, has_plex_token: false, local_server_enabled: true, browse_all_media: true, hide_quick_login: true });
  view.render();
  view.find('Browse Media').props.onClick();
  assert.deepEqual(view.actions.at(-1), ['browse']);
});

test('a stale settings RPC cannot replace a newer header action in open Quick View', async () => {
  let resolveRead;
  const view = fixture({ rpc: () => new Promise(resolve => { resolveRead = resolve; }) });
  view.notify({ ...connected, browse_all_media: true });
  view.render();
  assert.ok(view.find('Browse Media'));
  resolveRead({ has_plex_token: false });
  await setImmediate();
  view.render();
  assert.ok(view.find('Browse Media'));
  assert.equal(view.find('Log in'), undefined);
});

test('video seek controls remain available for repeated presses while a seek buffers', () => {
  const viewer = {
    item: { id: 'movie', title: 'Test Movie', type: 'movie' },
    duration: 600, position: 120, episodes: [], ready: true, playing: true,
    seek(time) { viewer.position = time; viewer.busy = true; },
  };
  const view = fixture({ viewer });
  view.label('Forward 10 seconds').props.onClick();
  assert.equal(viewer.position, 130);
  view.render();
  view.label('Forward 10 seconds').props.onClick();
  assert.equal(viewer.position, 140);
});
