import assert from 'node:assert/strict';
import test from 'node:test';
import { hostModules, jsxRuntime, loadModule, nodes, renderHooks } from './fixtures/frontend.mjs';
import { retryPlexRead } from '../src/components/PlexRead.ts';
import { videoSeekStep } from '../src/components/VideoQueue.ts';

function scrubber(position = 100, disabled = false) {
  const host = renderHooks();
  const buttons = { DIR_LEFT: 1, DIR_RIGHT: 2 };
  const { VideoScrubber } = loadModule(new URL('../src/components/VideoScrubber.tsx', import.meta.url), {
    require: hostModules({
      react: host.react,
      'react/jsx-runtime': jsxRuntime,
      '@decky/ui': { Button: 'Button', GamepadButton: buttons },
      './PlexMediaUrl': { plexMediaUrl: url => url },
      './VideoQueue': { videoSeekStep },
    }),
  });
  const seeks = [];
  const render = () => host.render(() => VideoScrubber({ position, duration: 600, disabled, seek: value => seeks.push(value) }));
  const control = () => nodes(render()).find(node => node.type === 'Button').props;
  return {
    render, control, seeks,
    press(direction) {
      const event = {
        detail: { button: buttons[direction] },
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      control().onGamepadDirection?.(event);
      return event;
    },
  };
}

test('the scrubber leaves navigation to Steam until A starts editing', () => {
  const player = scrubber();
  assert.equal(player.control().onGamepadDirection, undefined);
  assert.equal(player.control().onCancelButton, undefined);
  assert.equal(player.press('DIR_RIGHT').prevented, undefined);
  player.control().onClick();
  assert.equal(player.control().onOKActionDescription, 'Seek');
  for (let i = 0; i < 3; i++) {
    const event = player.press('DIR_RIGHT');
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  assert.deepEqual(player.seeks, []);
  player.control().onClick();
  assert.deepEqual(player.seeks, [115]);
  assert.equal(player.control().onGamepadDirection, undefined);
});

test('B and focus loss cancel the draft and keep the actual playback position', () => {
  const player = scrubber();
  player.control().onClick();
  player.press('DIR_LEFT');
  const event = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  player.control().onCancelButton(event);
  assert.equal(event.prevented && event.stopped, true);
  assert.match(player.control()['aria-label'], /1:40 of 10:00/);
  player.control().onClick();
  player.press('DIR_RIGHT');
  player.render().props.onBlur();
  assert.equal(player.control().onGamepadDirection, undefined);
  assert.deepEqual(player.seeks, []);
});

test('seek commits clamp at the end and a disabled scrubber stays inactive', () => {
  const player = scrubber(598);
  player.control().onClick();
  player.press('DIR_RIGHT');
  player.press('DIR_RIGHT');
  player.control().onClick();
  assert.deepEqual(player.seeks, [600]);
  const disabled = scrubber(100, true);
  assert.equal(disabled.control().focusable, false);
  disabled.control().onClick();
  assert.equal(disabled.control().onGamepadDirection, undefined);
  assert.deepEqual(disabled.seeks, []);
});

test('a read retries a transient reset once for both RPC error results and exceptions', async () => {
  for (const reject of [false, true]) {
    let attempts = 0;
    const result = await retryPlexRead(async () => {
      if (++attempts > 1) return { items: ['song'] };
      const error = 'Remote end closed connection without response';
      if (reject) throw new Error(error);
      return { error };
    });
    assert.equal(attempts, 2);
    assert.deepEqual(result, { items: ['song'] });
  }
});

test('a read surfaces permission failures immediately and persistent resets after one retry', async () => {
  let attempts = 0;
  const denied = { error: 'Plex denied permission' };
  assert.equal(await retryPlexRead(async () => { attempts++; return denied; }), denied);
  assert.equal(attempts, 1);
  const reset = new Error('ECONNRESET');
  await assert.rejects(retryPlexRead(async () => { attempts++; throw reset; }), error => error === reset);
  assert.equal(attempts, 3);
});

function sharedPlayback() {
  const window = {};
  let notifications = 0;
  let unsubscribe;
  const react = {
    useSyncExternalStore(subscribe, snapshot) {
      unsubscribe ??= subscribe(() => { notifications++; });
      return snapshot();
    },
  };
  const load = () => loadModule(new URL('../src/components/VideoPlayback.ts', import.meta.url), {
    window, require: hostModules({ react }),
  });
  const movie = { id: 'movie', type: 'movie', title: 'Test Movie' };
  const resume = { item: movie, serverId: 'server-a', position: 120, playing: false, quality: 'auto' };
  const viewer = { item: movie, duration: 900, suspend: () => resume };
  return { browser: load(), quickView: load(), owner: Symbol(), resume, viewer, notifications: () => notifications };
}

test('paused playback reaches open Quick View, keeps its position, and only resumes on its source server', () => {
  const { browser, quickView, owner, resume, viewer, notifications } = sharedPlayback();
  assert.equal(quickView.usePausedVideo(), null);
  browser.setViewerPlayback(owner, viewer);
  assert.equal(quickView.useViewerPlayback(), viewer);
  assert.equal(browser.suspendVideoPlayback(), true);
  assert.equal(quickView.usePausedVideo().resume, resume);
  assert.equal(quickView.usePausedVideo().duration, 900);
  assert.ok(notifications() >= 2);
  assert.equal(browser.takePausedVideo('server-a'), null);
  assert.equal(quickView.requestPausedVideo(true), true);
  assert.equal(browser.takePausedVideo('server-b'), null);
  const handoff = browser.takePausedVideo('server-a');
  assert.equal(handoff.position, 120);
  assert.equal(handoff.playing, true);
  browser.finishPausedVideoResume(handoff);
  assert.equal(quickView.usePausedVideo(), null);
});

test('fullscreen restores the retained viewer in place and preserves paused state', () => {
  const { browser, quickView, owner, viewer } = sharedPlayback();
  browser.setViewerPlayback(owner, viewer);
  let restored;
  browser.suspendVideoPlayback({
    restore(resume) { restored = resume; return true; },
    discard() { assert.fail('The retained viewer should stay open'); },
  });
  assert.equal(quickView.useViewerPlayback(), null);
  browser.setViewerPlayback(owner, viewer);
  assert.equal(quickView.useViewerPlayback(), null, 'publishing from the suspended viewer cannot reactivate it');
  quickView.requestPausedVideo(false);
  assert.equal(browser.takePausedVideo('server-a'), null);
  assert.equal(restored.position, 120);
  assert.equal(restored.playing, false);
  assert.equal(quickView.usePausedVideo(), null);
});

test('a stale viewer cannot tear down its replacement and stopping discards a retained viewer', () => {
  const { browser, quickView, owner, viewer } = sharedPlayback();
  const replacement = Symbol();
  browser.setViewerPlayback(owner, viewer);
  browser.setViewerPlayback(replacement, { ...viewer, duration: 1200 });
  browser.setViewerPlayback(owner, null);
  assert.equal(quickView.useViewerPlayback().duration, 1200);
  let discarded = 0;
  browser.suspendVideoPlayback({ restore: () => false, discard: () => { discarded++; } });
  quickView.clearPausedVideo();
  quickView.clearPausedVideo();
  assert.equal(discarded, 1);
  assert.equal(quickView.requestPausedVideo(true), false);
});
