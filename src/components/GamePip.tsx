import { Component, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { call, toaster } from '@decky/api';
import { Router, findModuleExport } from '@decky/ui';
import { insertNextEpisode, queueFromEpisode, resumePosition } from './VideoQueue';

type SteamWindow = NonNullable<typeof Router.WindowStore.GamepadUIMainWindowInstance>;
type SteamView = ReturnType<SteamWindow['CreateBrowserView']>;
type CompositionHook = (level: number) => unknown;
const steamQuickAccessMenu = 2;
type Playback = {
  status: 'waiting' | 'ready' | 'playing' | 'paused' | 'ended' | 'error' | 'closed';
  position: number;
  duration: number;
  code?: string;
  committed?: boolean;
};

export interface VideoItem {
  id: string;
  key: string;
  title: string;
  index?: number;
  parentIndex?: number;
  type: string;
  thumb?: string;
  poster?: string;
  duration?: number;
  viewCount?: number;
  viewOffset?: number;
  parentTitle?: string;
  grandparentTitle?: string;
}

export interface VideoResume {
  item: VideoItem;
  serverId: string;
  position: number;
  playing: boolean;
  quality: string;
  volume: number;
  muted: boolean;
  episodes?: VideoItem[];
}

interface Overlay {
  id: string;
  viewKey: string;
  item: VideoItem;
  serverId: string;
  quality: string;
  volume: number;
  muted: boolean;
  steam: SteamWindow;
  view: SteamView;
  useComposition: CompositionHook;
  composed: boolean;
  bounds: string;
  corner: string;
  size: number;
  playback?: Playback;
  clock: number;
  busy: boolean;
  episodes: VideoItem[];
  lastReport: number;
  timeline: Promise<unknown>;
}

interface PipRequest {
  item: VideoItem;
  serverId: string;
  quality: string;
  position: number;
  volume: number;
  muted: boolean;
  episodes?: VideoItem[];
  preferredSource?: string;
  reuse?: { key: string; manifest: string };
}

let overlay: Overlay | null = null;
let starting = false;
let revision = 0;
let version = 0;
let fullscreenRequest: VideoResume | null = null;
const listeners = new Set<() => void>();
export const gamePipFullscreenEvent = 'deckyplex-game-pip-fullscreen';
export const videoProgressEvent = 'deckyplex-video-progress-change';

function publish() {
  version++;
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function useOverlay() {
  useSyncExternalStore(subscribe, () => version);
  return overlay;
}

export function useGamePipPlayback() {
  const current = useOverlay();
  return current?.playback ? current : null;
}

export function useGamePipEpisodeQueue() {
  return useSyncExternalStore(subscribe, () => !!overlay?.playback && overlay.episodes.length > 0);
}

export async function getEpisodeQueue(itemId: string, serverId: string) {
  return call<[string, string], VideoItem[]>('get_episode_queue', itemId, serverId);
}

function loadEpisodeQueue(current: Overlay) {
  if (current.item.type !== 'episode') return;
  const id = current.id;
  void getEpisodeQueue(current.item.id, current.serverId).then(result => {
    if (overlay !== current || current.id !== id || !result?.length) return;
    current.episodes = queueFromEpisode(result, current.item.id);
    publish();
  }).catch(() => {});
}

async function getStatus(id: string) {
  return call<[string], Playback>('get_game_pip_status', id);
}

function report(current: Overlay, state: 'playing' | 'paused' | 'stopped') {
  const playback = current.playback;
  if (!playback || playback.position < 1) return;
  const position = Math.round(playback.position * 1000);
  const duration = Math.round(playback.duration * 1000);
  const { item, serverId } = current;
  current.timeline = current.timeline.then(() =>
    call('report_video_progress', item.id, serverId, position, duration, state),
  ).then(() => {
    if (state === 'stopped') window.dispatchEvent(new Event(videoProgressEvent));
  }).catch(() => {});
}

export function stopGamePip() {
  revision++;
  const current = overlay;
  if (!current) return;
  overlay = null;
  window.clearTimeout(current.clock);
  try {
    current.view.Destroy();
  } catch {
    // Steam can destroy a browser view before the plugin is notified.
  }
  if (current.playback) report(current, 'stopped');
  void call('stop_game_pip', current.id).catch(() => {});
  publish();
}

function updateBounds(current: Overlay, steam: SteamWindow) {
  const main = steam.BrowserWindow ?? window;
  const width = main.screen.width || main.innerWidth;
  const height = main.screen.height || main.innerHeight;
  const size = Math.round(Math.min(width * current.size / 100, height * 0.96));
  const videoHeight = Math.round(size * 9 / 16);
  const margin = Math.round(width * 0.018);
  if (!(size > 0)) throw new Error('Steam did not report the overlay display size.');
  // Steam's Quick Access menu occupies the right edge. Return to the chosen corner when it closes.
  const focused = window.SteamUIStore?.GetFocusedWindowInstance?.();
  const quickAccessOpen = steam.MenuStore?.IsSideMenuVisible?.(steamQuickAccessMenu)
    || focused?.MenuStore?.IsSideMenuVisible?.(steamQuickAccessMenu);
  const x = current.corner.endsWith('right') && !quickAccessOpen ? width - size - margin : margin;
  const y = current.corner.startsWith('top') ? margin : height - videoHeight - margin;
  const bounds = `${x},${y},${size},${videoHeight}`;
  if (bounds !== current.bounds) {
    current.view.GetBrowser().SetBounds(x, y, size, videoHeight);
    current.bounds = bounds;
  }
}

function poll(current: Overlay) {
  current.clock = window.setTimeout(async () => {
    const id = current.id;
    if (overlay !== current || current.busy) return;
    try {
      const next = await getStatus(id);
      if (overlay !== current || current.id !== id || current.busy) return;
      if (next.status === 'closed') {
        stopGamePip();
        return;
      }
      const previous = current.playback;
      current.playback = next;
      if (next.status === 'ended') {
        const index = current.episodes.findIndex(episode => episode.id === current.item.id);
        const upcoming = index >= 0 ? current.episodes[index + 1] : undefined;
        if (upcoming) void playGamePipEpisode(upcoming.id);
        else stopGamePip();
        return;
      }
      if (next.status === 'error') {
        logOverlay(current, 'failed', next.code || 'stream-error');
        throw new Error('The over-game stream stopped.');
      }
      if (next.status === 'playing' || next.status === 'paused') {
        if (!current.lastReport || next.status !== previous?.status
            || (next.status === 'playing' && Date.now() - current.lastReport >= 10000)) {
          current.lastReport = Date.now();
          report(current, next.status);
        }
      }
      if (next.status !== previous?.status || next.position !== previous?.position || next.duration !== previous?.duration) publish();
      updateBounds(current, current.steam);
      poll(current);
    } catch {
      if (overlay !== current || current.id !== id || current.busy) return;
      stopGamePip();
      void toaster.toast({ title: 'DeckyPlex', body: 'The over-game video stopped.' });
    }
  }, 800);
}

function control(id: string, action: string, value = 0, playing = false) {
  return call<[string, string, number, boolean], boolean>('control_game_pip', id, action, value, playing);
}

function logOverlay(current: Overlay, event: 'attempt' | 'ready' | 'failed' | 'waiting', code = '') {
  void call('log_video_event', current.item.id, current.quality, 'pip', event, code).catch(() => {});
}

async function prepareView(current: Overlay, url: string, checkActive: () => void,
  readPlayback: () => { position: number; playing: boolean }) {
  logOverlay(current, 'attempt');
  const browser = current.view.GetBrowser();
  current.view.LoadURL(url);
  browser.SetVisible(true);
  let activated = false;
  let commit: { position: number; playing: boolean; sent: number } | undefined;
  let resynced = false;
  let phase = 'waiting-for-stream';
  let statusCode = '';
  const deadline = Date.now() + 55000;
  while (Date.now() < deadline) {
    checkActive();
    const status = await getStatus(current.id);
    statusCode = status.code || '';
    checkActive();
    if (status.status === 'error' || status.status === 'closed') {
      logOverlay(current, 'failed', status.code || status.status);
      throw new Error('The over-game view did not start playing.');
    }
    if (status.status === 'ready' && !current.composed && !activated) phase = 'steam-composition';
    if (status.status === 'ready' && current.composed && !activated) {
      phase = 'activate';
      browser.NotifyUserActivation?.();
      const playback = readPlayback();
      activated = await control(current.id, 'activate', playback.position, playback.playing);
      if (!activated) break;
    } else if (commit && status.committed && (status.status === 'playing' || status.status === 'paused')) {
      const elapsed = commit.playing ? (Date.now() - commit.sent) / 1000 : 0;
      const expected = Math.min(commit.position, status.duration || commit.position);
      if (status.position < expected - 3 || status.position > expected + elapsed + 3) {
        const diagnostic = `position-expected-${Math.round(expected)}-actual-${Math.round(status.position)}`;
        if (resynced) {
          logOverlay(current, 'failed', diagnostic);
          throw new Error('The over-game view could not match the playback position.');
        }
        logOverlay(current, 'waiting', diagnostic);
        resynced = true;
        commit = undefined;
        continue;
      }
      current.playback = status;
      logOverlay(current, 'ready', statusCode);
      return;
    } else if (activated && !commit && (status.status === 'playing' || status.status === 'paused')) {
      phase = 'commit';
      browser.NotifyUserActivation?.();
      const playback = readPlayback();
      const sent = Date.now();
      if (!await control(current.id, 'commit', playback.position, playback.playing)) break;
      checkActive();
      commit = { ...playback, sent };
    }
    await new Promise(resolve => window.setTimeout(resolve, 400));
  }
  logOverlay(current, 'failed', `${phase}${statusCode ? `:${statusCode}` : ''}`.slice(0, 96));
  throw new Error('The over-game view did not start playing.');
}

export async function startGamePip(request: PipRequest, signal: AbortSignal,
  readPlayback: () => { position: number; playing: boolean }) {
  if (starting || overlay) throw new Error('Close the over-game video before opening another one.');
  const steam = Router.WindowStore?.GamepadUIMainWindowInstance;
  if (!steam || steam.m_params?.bViaGamescope === false || typeof steam.CreateBrowserView !== 'function') {
    throw new Error('Steam’s over-game video view is unavailable.');
  }
  const useComposition: CompositionHook | undefined = findModuleExport(value => {
    if (typeof value !== 'function') return false;
    const source = String(value);
    return source.includes('AddMinimumCompositionStateRequest')
      && source.includes('ChangeMinimumCompositionStateRequest')
      && source.includes('RemoveMinimumCompositionStateRequest')
      && !source.includes('m_mapCompositionStateRequests');
  });
  if (typeof useComposition !== 'function') throw new Error('Steam’s overlay layer is unavailable.');

  starting = true;
  const run = ++revision;
  let id: string | undefined;
  let view: SteamView | undefined;
  let managed = false;
  const checkActive = () => {
    if (signal.aborted || revision !== run) throw new Error('Over-game picture-in-picture was canceled.');
  };
  try {
    checkActive();
    const result = await call<unknown[], { id?: string; url?: string; error?: string; pip_position?: string; pip_size?: number }>(
      'start_game_pip', request.item.id, request.serverId, request.quality, request.position, request.volume, request.muted,
      '', request.preferredSource || '', request.reuse ?? null,
    );
    id = result?.id;
    checkActive();
    if (!id || !result.url) throw new Error(result?.error || 'Could not prepare the over-game video.');
    view = steam.CreateBrowserView('deckyplex-video', { bOnlyAllowTrustedPopups: true });
    const browser = view?.GetBrowser?.();
    if (!browser || typeof browser.SetBounds !== 'function' || typeof browser.SetVisible !== 'function'
        || typeof view.LoadURL !== 'function' || typeof view.Destroy !== 'function') {
      throw new Error('Steam could not create the over-game video view.');
    }
    const current: Overlay = {
      id, viewKey: id, steam, view, useComposition, item: request.item, serverId: request.serverId,
      quality: request.quality, volume: request.volume, muted: request.muted, episodes: request.episodes || [],
      corner: result.pip_position ?? 'bottom-left', size: result.pip_size ?? 29,
      composed: false, bounds: '', busy: false, clock: 0, lastReport: 0, timeline: Promise.resolve(),
    };
    overlay = current;
    managed = true;
    publish();
    updateBounds(current, steam);
    await prepareView(current, result.url, checkActive, readPlayback);
    checkActive();
    publish();
    if (!request.episodes) loadEpisodeQueue(current);
    poll(current);
  } catch (error) {
    if (id && overlay?.id === id) {
      stopGamePip();
    } else if (!managed) {
      try { view?.Destroy(); } catch {}
      if (id) void call('stop_game_pip', id).catch(() => {});
    }
    throw error;
  } finally {
    starting = false;
  }
}

export function toggleGamePipPlayback() {
  const current = overlay;
  if (current?.playback && !current.busy) {
    void control(current.id, 'playback', 0, current.playback.status !== 'playing').catch(() => {});
  }
}

export function seekGamePip(position: number) {
  const current = overlay;
  if (current?.playback && !current.busy && Number.isFinite(position)) {
    const target = Math.max(0, Math.min(position, current.playback.duration));
    current.playback = { ...current.playback, position: target };
    publish();
    void control(current.id, 'seek', target).catch(() => {});
  }
}

export function setGamePipVolume(volume: number) {
  const current = overlay;
  if (!current?.playback || current.busy) return;
  current.volume = volume;
  if (volume > 0) current.muted = false;
  publish();
  void control(current.id, 'volume', volume).catch(() => {});
}

export function removeGamePipEpisode(id: string) {
  if (!overlay || overlay.item.id === id) return;
  overlay.episodes = overlay.episodes.filter(episode => episode.id !== id);
  publish();
}

export function queueGamePipEpisodeNext(episode: VideoItem) {
  if (!overlay || overlay.item.type !== 'episode') return;
  overlay.episodes = insertNextEpisode(overlay.episodes, overlay.item.id, episode);
  publish();
}

export async function playGamePipEpisode(itemId: string) {
  const current = overlay;
  const item = current?.episodes.find(entry => entry.id === itemId);
  if (!current?.playback || current.busy || !item || current.item.id === item.id) return;
  current.busy = true;
  window.clearTimeout(current.clock);
  publish();
  let replaced = false;
  const duration = (item.duration || 0) / 1000;
  const initialPosition = resumePosition(item.viewOffset || 0, item.duration || 0);
  try {
    const result = await call<unknown[], { id?: string; url?: string; error?: string }>(
      'start_game_pip', item.id, current.serverId, current.quality, initialPosition, current.volume, current.muted, current.id,
    );
    if (overlay !== current) {
      if (result.id) void call('stop_game_pip', result.id).catch(() => {});
      return;
    }
    if (!result.id || !result.url) throw new Error(result.error || 'Could not open that episode.');
    report(current, 'stopped');
    current.id = result.id;
    current.item = item;
    current.playback = { status: 'waiting', position: initialPosition, duration };
    current.lastReport = 0;
    replaced = true;
    publish();
    await prepareView(current, result.url, () => {
      if (overlay !== current) throw new Error('The over-game video has closed.');
    }, () => ({ position: initialPosition, playing: true }));
  } catch (error) {
    if (overlay !== current) return;
    if (replaced || current.playback?.status === 'ended') stopGamePip();
    void toaster.toast({ title: 'DeckyPlex', body: error instanceof Error ? error.message : 'Could not open that episode.' });
  } finally {
    if (overlay === current) {
      current.busy = false;
      publish();
      poll(current);
    }
  }
}

export async function prepareGamePipFullscreen() {
  const current = overlay;
  if (!current?.playback || current.busy) return false;
  current.busy = true;
  window.clearTimeout(current.clock);
  publish();
  const latest = await getStatus(current.id).catch(() => null);
  if (overlay !== current) return false;
  const playback = latest?.status === 'playing' || latest?.status === 'paused' ? latest : current.playback;
  fullscreenRequest = {
    item: current.item, serverId: current.serverId, position: playback.position, playing: playback.status === 'playing',
    quality: current.quality, volume: current.volume, muted: current.muted, episodes: current.episodes,
  };
  current.playback = playback;
  stopGamePip();
  return true;
}

export function takeGamePipFullscreen(serverId: string) {
  if (fullscreenRequest?.serverId !== serverId) return null;
  const request = fullscreenRequest;
  fullscreenRequest = null;
  return request;
}

class OverlayBoundary extends Component<{ children: ReactNode; fail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.fail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SteamNotificationLayer({ current }: { current: Overlay }) {
  const useComposition = current.useComposition;
  useComposition(1); // Steam's notification composition layer.
  useEffect(() => {
    current.composed = true;
    return () => { current.composed = false; };
  }, [current]);
  return null;
}

export function GamePipHost() {
  const current = useOverlay();
  useEffect(() => {
    window.addEventListener('deckyplex-local-music-playing', stopGamePip);
    return () => window.removeEventListener('deckyplex-local-music-playing', stopGamePip);
  }, []);
  useEffect(() => {
    if (!current) return;
    const refreshBounds = () => void call<[], { pip_position: string; pip_size: number }>('get_settings').then(settings => {
      if (overlay !== current) return;
      current.corner = settings.pip_position;
      current.size = settings.pip_size;
      updateBounds(current, current.steam);
    }).catch(() => {});
    const timer = window.setInterval(() => {
      if (!current.corner.endsWith('right')) return;
      try { updateBounds(current, current.steam); } catch { /* The next playback poll handles a closed Steam view. */ }
    }, 150);
    window.addEventListener('deckyplex-settings-change', refreshBounds);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('deckyplex-settings-change', refreshBounds);
    };
  }, [current]);
  return current && (
    <OverlayBoundary key={current.viewKey} fail={() => { if (overlay === current) stopGamePip(); }}>
      <SteamNotificationLayer current={current} />
    </OverlayBoundary>
  );
}
