import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import { addEventListener, call } from '@decky/api';
import { plexMediaUrl } from '../components/PlexMediaUrl';

interface TrackInfo {
  id: string;
  sectionId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumb: string;
  key?: string;
  playQueueItemID?: string;
  sourceServerId?: string;
}

interface PlayerState {
  playbackState: string; // "playing", "paused", "stopped"
  track: TrackInfo | null;
  volume: number;
  error: string | null;
  progress: number; // current position in seconds
  duration: number; // total duration in seconds
  remoteMode: boolean;
  remoteTargetSelected: boolean;
  companionMode: boolean;
  remotePlayerId: string;
  remotePlayerName: string;
  queue: TrackInfo[];
  queueIndex: number;
}

interface PlayerContextType extends PlayerState {
  playbackPending: boolean;
  remoteQueueEditable: boolean;
  canLoadMoreQueue: boolean;
  loadMusicArtwork: (trackId: string, sourceServerId?: string) => Promise<string>;
  localVolume: number;
  volumeSliderRevision: number;
  playTrack: (streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl?: string, loadMore?: () => Promise<TrackInfo[]>, requestToken?: number, localConnection?: boolean) => void;
  beginPlaybackRequest: () => number;
  readMusicPlaybackTarget: () => Promise<string>;
  playRemoteQueue: (playerId: string, queue: TrackInfo[], startId?: string) => Promise<{ success: boolean; error?: string }>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  skipNext: () => void;
  skipPrevious: () => void;
  playQueueIndex: (index: number) => void;
  removeFromQueue: (index: number) => void;
  addToQueue: (track: TrackInfo, playNext?: boolean) => Promise<{ success: boolean; error?: string; warning?: string }>;
  setVolume: (volume: number) => void;
  setLocalVolume: (volume: number) => void;
  seek: (time: number) => void;
}

const PlayerContext = createContext<PlayerContextType | null>(null);
const DEFAULT_LOCAL_VOLUME = 50;

// Decky may mount the sidebar and routed browser from separate bundle contexts.
// Keep the whole playback engine on window so both controls always share one queue,
// request generation, and media element.
const engine: any = (window as any).__deckyPlexPlaybackEngine || ((window as any).__deckyPlexPlaybackEngine = {
  audio: new Audio(), track: null, queue: [], queueIndex: -1, queueLoader: null,
  queueLoadInProgress: false, requestId: 0, pendingRequestId: 0, failedRequestId: 0,
  timelineAt: 0, timelineKey: '', explicitlyStopped: false, diagnosedSource: '',
  remoteActive: false, companionActive: false, companionServerContext: null, listenersInitialized: false,
});
const sharedAudio: HTMLAudioElement = engine.audio;
if (!engine.audioInitialized) {
  sharedAudio.volume = DEFAULT_LOCAL_VOLUME / 100;
  engine.audioInitialized = true;
}
if (!engine.gamePipAudioHook) {
  sharedAudio.addEventListener('play', () => window.dispatchEvent(new Event('deckyplex-local-music-playing')));
  engine.gamePipAudioHook = true;
}

function setSharedVolume(volume: number, syncSlider = false) {
  if (syncSlider) engine.volumeSliderRevision = (engine.volumeSliderRevision || 0) + 1;
  sharedAudio.volume = volume / 100;
  window.dispatchEvent(new CustomEvent('deckyplex-volume-change', { detail: volume }));
}

export function startLocalVolumeSession() {
  const session = Symbol();
  const cancelPendingSave = () => {
    window.clearTimeout(engine.volumeSaveTimer);
    engine.volumeSaveTimer = undefined;
  };
  // The Steam window can retain the engine when Decky reloads the plugin.
  cancelPendingSave();
  engine.volumeSession = session;
  engine.volumePreferenceLoaded = false;
  setSharedVolume(DEFAULT_LOCAL_VOLUME, true);

  return () => {
    if (engine.volumeSession !== session) return;
    engine.volumeSession = undefined;
    cancelPendingSave();
  };
}

function isPlaybackPending() {
  return Boolean(engine.pendingRequestId || engine.queueLoadInProgress || engine.remoteCommandsPending);
}

function setPendingPlaybackRequest(requestId: number) {
  if (engine.pendingRequestId === requestId) return;
  engine.pendingRequestId = requestId;
  window.dispatchEvent(new Event('deckyplex-playback-pending'));
}

function setQueueLoading(loading: boolean) {
  if (engine.queueLoadInProgress === loading) return;
  engine.queueLoadInProgress = loading;
  window.dispatchEvent(new Event('deckyplex-playback-pending'));
}

// Send a debug message from the browser to the backend log file
function logToBackend(message: string) {
  call("log_message", message).catch(() => {});
}

function showTransientPlaybackError(setState: any, message: string) {
  const revision = (engine.playbackErrorRevision || 0) + 1;
  engine.playbackErrorRevision = revision;
  if (engine.playbackErrorTimer) window.clearTimeout(engine.playbackErrorTimer);
  setState((state: PlayerState) => ({ ...state, playbackState: 'stopped', error: message }));
  engine.playbackErrorTimer = window.setTimeout(() => {
    if (engine.playbackErrorRevision !== revision) return;
    setState((state: PlayerState) => state.error === message ? { ...state, error: null } : state);
    engine.playbackErrorTimer = null;
  }, 10000);
}

function rememberCompanionSession() {
  if (!engine.companionActive || !engine.queue?.length || engine.queueIndex < 0) return;
  engine.lastCompanionSession = {
    queue: engine.queue.slice(), queueIndex: engine.queueIndex,
    serverContext: engine.companionServerContext,
    playQueueId: engine.companionPlayQueueId || '',
    containerKey: engine.companionContainerKey || '',
    playQueueVersion: engine.companionPlayQueueVersion || '',
  };
}

function unshareLocalCompanionQueue() {
  if (!engine.localCompanionQueueId) return;
  engine.localCompanionQueueId = '';
  engine.companionActive = false;
  engine.companionPlayQueueId = '';
  engine.companionPlayQueueVersion = '';
  engine.companionContainerKey = '';
  engine.companionServerContext = null;
  engine.lastCompanionSession = null;
  window.dispatchEvent(new Event('deckyplex-companion-stop'));
}

async function shareLocalCompanionQueue() {
  const serverId = engine.selectedServerId;
  const current: TrackInfo | null = engine.track;
  if (!engine.receiverEnabled || !serverId || !current || engine.companionActive || engine.remoteActive
      || engine.pendingRequestId || engine.explicitlyStopped || engine.sharingLocalQueue
      || (engine.localPlaybackServerId && engine.localPlaybackServerId !== serverId)
      || Date.now() < (engine.shareQueueRetryAt || 0)) return;

  const requestId = engine.requestId;
  const index = engine.queueIndex;
  const upcoming: TrackInfo[] = engine.queue.slice(index + 1);
  const entries = [current, ...upcoming];
  engine.sharingLocalQueue = true;
  try {
    const result: any = await call('share_local_companion_queue', serverId, entries.map(track => track.id));
    if (!engine.receiverEnabled || engine.selectedServerId !== serverId || engine.requestId !== requestId
        || engine.track !== current || engine.queueIndex !== index || engine.companionActive || engine.remoteActive
        || engine.queue.length !== index + 1 + upcoming.length
        || upcoming.some((track, position) => engine.queue[index + position + 1] !== track)) return;
    if (!result?.success || !result.play_queue_id || result.item_ids?.length !== entries.length
        || result.item_ids.some((id: string) => !id)) {
      throw new Error(result?.error || 'Plex returned an incomplete shared queue.');
    }

    const shared = entries.map((track, position) => ({ ...track,
      key: track.key || `/library/metadata/${track.id}`, playQueueItemID: result.item_ids[position] }));
    const previous = engine.queue.slice(0, Math.max(0, index))
      .map((track: TrackInfo) => ({ ...track, playQueueItemID: undefined }));
    engine.queue = [...previous, ...shared];
    engine.queueIndex = previous.length;
    engine.track = shared[0];
    engine.companionActive = true;
    engine.localPlaybackServerId = serverId;
    engine.localCompanionQueueId = result.play_queue_id;
    engine.companionPlayQueueId = result.play_queue_id;
    engine.companionPlayQueueVersion = result.play_queue_version;
    engine.companionContainerKey = result.container_key;
    engine.companionServerContext = result.server_context;
    engine.companionMediaContext = null;
    rememberCompanionSession();
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    window.dispatchEvent(new Event('deckyplex-track-change'));
    reportTimeline(sharedAudio.paused ? 'paused' : 'playing', true);
    logToBackend(`queue: shared ${entries.length} Deck track(s) with Plexamp without restarting audio`);
  } catch (error: any) {
    if (engine.requestId === requestId && engine.receiverEnabled) {
      engine.shareQueueRetryAt = Date.now() + 15000;
      logToBackend(`queue: could not share Deck playback with Plexamp: ${error?.message || error}`);
    }
  } finally {
    engine.sharingLocalQueue = false;
  }
}

function reportTimeline(state: 'playing' | 'paused' | 'stopped', force = false) {
  if (engine.companionActive && engine.track?.id) {
    const now = Date.now();
    if (force || now - (engine.companionTimelineAt || 0) >= 900) {
      engine.companionTimelineAt = now;
      const duration = Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
        ? sharedAudio.duration : (engine.track.duration || 0) / 1000;
      void call('report_companion_timeline', engine.track.id,
        Math.round((sharedAudio.currentTime || 0) * 1000), Math.round(duration * 1000), state,
        Math.round((sharedAudio.volume || 0) * 100), engine.companionPlayQueueId || '',
        engine.track.playQueueItemID || '', engine.companionContainerKey || '',
        engine.companionPlayQueueVersion || '', engine.companionServerContext || {},
        state !== 'stopped' && (engine.queueIndex + 1 < engine.queue.length || !!engine.queueLoader),
        engine.companionMediaContext || null)
        .catch(() => {});
    }
  }
  if (engine.companionActive || engine.remoteActive || engine.localConnection || !engine.track?.id) return;
  if (state !== 'stopped' && engine.receiverEnabled) void shareLocalCompanionQueue();
  const now = Date.now();
  const reportKey = `${engine.track.id}:${state}`;
  if (reportKey === engine.timelineKey && now - engine.timelineAt < (state === 'playing' ? 9000 : 750)) return;
  if (!force && state === 'playing' && now - engine.timelineAt < 9000 && engine.timelineKey.startsWith(`${engine.track.id}:`)) return;
  engine.timelineAt = now;
  engine.timelineKey = reportKey;
  const duration = Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
    ? sharedAudio.duration
    : (engine.track.duration || 0) / 1000;
  call('report_playback', engine.track.id, Math.round((sharedAudio.currentTime || 0) * 1000), state,
    Math.round(duration * 1000)).catch(() => {});
}

function stopSharedPlayback(report = true) {
  engine.requestId++;
  setPendingPlaybackRequest(0);
  engine.explicitlyStopped = true;
  if (report) reportTimeline('stopped', true);
  unshareLocalCompanionQueue();
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  engine.track = null;
  engine.localConnection = false;
  engine.remoteActive = false;
  engine.queue = [];
  engine.queueIndex = -1;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  engine.queueLoader = null;
  setQueueLoading(false);
  window.dispatchEvent(new Event('deckyplex-track-change'));
}

function clearRemoteQueue() {
  engine.remoteQueueId = '';
  engine.remoteQueueVersion = '';
  engine.remoteQueueItemId = '';
  engine.remoteQueueEditable = false;
  engine.remoteIdleSince = 0;
  if (!engine.remoteQueuePlayerId) return;
  engine.remoteQueuePlayerId = '';
  engine.track = null;
  engine.queue = [];
  engine.queueIndex = -1;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  window.dispatchEvent(new Event('deckyplex-track-change'));
}

function applyRemoteQueueStatus(playerId: string, result: any, track: TrackInfo) {
  let changed = false;
  if (Array.isArray(result.queue)) {
    engine.remoteQueuePlayerId = playerId;
    engine.remoteQueueId = result.play_queue_id;
    engine.remoteQueueVersion = result.play_queue_version || '';
    engine.queue = result.queue.map((item: any): TrackInfo => ({
      id: String(item.id), sectionId: String(item.sectionId || ''), title: item.title || 'Unknown',
      artist: item.grandparentTitle || item.artist || '', album: item.parentTitle || item.album || '',
      duration: item.duration || 0, thumb: item.thumb || '', key: item.key || '',
      playQueueItemID: item.playQueueItemID || '', sourceServerId: item.sourceServerId || '',
    }));
    changed = true;
  }
  engine.remoteQueueItemId = result.play_queue_item_id || '';
  engine.remoteQueueEditable = !!result.queue_editable && !!engine.remoteQueueId
    && engine.remoteQueueId === result.play_queue_id;
  engine.track = track;
  if (engine.remoteQueuePlayerId === playerId) {
    const remoteIndex = engine.remoteQueueItemId
      ? engine.queue.findIndex((item: TrackInfo) => item.playQueueItemID === engine.remoteQueueItemId)
      : engine.queue[engine.queueIndex]?.id === track.id ? engine.queueIndex
        : engine.queue.findIndex((item: TrackInfo) => item.id === track.id);
    if (engine.queueIndex !== remoteIndex) {
      engine.queueIndex = remoteIndex;
      changed = true;
    }
  }
  if (changed) window.dispatchEvent(new Event('deckyplex-queue-change'));
}

function isPlayingOnDeck() {
  return !!engine.companionActive
    || !!(engine.track && !engine.explicitlyStopped && sharedAudio.getAttribute('src'));
}

function canControlRemotePlayer() {
  return !!engine.remoteTargetId && engine.plexConnection !== 'none' && !isPlayingOnDeck() && (!engine.pendingRequestId || !!engine.remoteActive);
}

function applyMusicPlaybackTarget(settings: {
  playback_target?: string; selected_player_id?: string; selected_player_name?: string;
  selected_server_id?: string; selected_server_url?: string; local_server_enabled?: boolean; has_plex_token?: boolean;
}) {
  const connection = settings.local_server_enabled ? `local:${settings.selected_server_url}` : settings.has_plex_token ? 'account' : 'none';
  const previous = engine.plexConnection;
  if (previous && previous !== connection && (!engine.companionActive || engine.localCompanionQueueId)) {
    stopSharedPlayback(false);
    engine.lastCompanionSession = null;
  }
  engine.plexConnection = connection;
  engine.selectedServerId = settings.selected_server_id || '';
  const playerId = settings.playback_target === 'remote' ? settings.selected_player_id || '' : '';
  const playerName = playerId ? settings.selected_player_name || '' : '';
  const targetChanged = engine.remoteTargetId !== playerId;
  if (targetChanged || isPlayingOnDeck()) {
    engine.remoteActive = false;
    engine.remoteStatusTransition = null;
  }
  if (!targetChanged && engine.remoteTargetName === playerName) return playerId;
  if (targetChanged) {
    engine.remoteTargetId = playerId;
    if (engine.remoteQueuePlayerId && engine.remoteQueuePlayerId !== playerId) clearRemoteQueue();
  }
  engine.remoteTargetName = playerName;
  window.dispatchEvent(new Event('deckyplex-music-target-change'));
  return playerId;
}

async function readMusicPlaybackTarget() {
  return applyMusicPlaybackTarget(await call('get_settings'));
}

async function playStreamWithFallback(primaryUrl: string, fallbackUrl: string, title: string, requestId: number, localConnection?: boolean) {
  const candidates = [primaryUrl, fallbackUrl].filter((url, index, all) => !!url && all.indexOf(url) === index);
  let lastError: Error | null = null;
  try {
    for (let index = 0; index < candidates.length; index++) {
      if (requestId !== engine.requestId) return false;
      setPendingPlaybackRequest(requestId);
      engine.diagnosedSource = '';
      engine.explicitlyStopped = false;
      sharedAudio.pause();
      engine.sourceUrl = candidates[index];
      sharedAudio.src = plexMediaUrl(engine.sourceUrl, localConnection);
      sharedAudio.load();
      try {
        await sharedAudio.play();
        if (requestId !== engine.requestId) return false;
        if (index > 0) logToBackend(`playback fallback succeeded for ${title}`);
        return true;
      } catch (e: any) {
        if (requestId !== engine.requestId || e?.name === 'AbortError') return false;
        lastError = e instanceof Error ? e : new Error(String(e));
        if (index + 1 < candidates.length) logToBackend(`playback primary failed for ${title}; trying alternate Plex stream`);
      }
    }
    throw lastError || new Error('No playable stream URL was returned');
  } finally {
    if (engine.pendingRequestId === requestId) setPendingPlaybackRequest(0);
  }
}

async function playQueuedIndex(index: number) {
  const nextTrack = engine.queue[index];
  if (!nextTrack) return;
  if (engine.localCompanionQueueId && !nextTrack.playQueueItemID) {
    reportTimeline('stopped', true);
    unshareLocalCompanionQueue();
  }
  const requestId = ++engine.requestId;
  setPendingPlaybackRequest(requestId);
  engine.failedRequestId = 0;
  engine.explicitlyStopped = true;
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  if (!engine.companionActive) reportTimeline('stopped', true);
  engine.queueIndex = index;
  rememberCompanionSession();
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  engine.track = nextTrack;
  engine.companionMediaContext = null;
  window.dispatchEvent(new Event('deckyplex-track-change'));
  if (engine.companionActive) {
    void call('report_companion_timeline', nextTrack.id, 0, nextTrack.duration || 0, 'buffering',
      Math.round((sharedAudio.volume || 0) * 100), engine.companionPlayQueueId || '',
      nextTrack.playQueueItemID || '', engine.companionContainerKey || '', engine.companionPlayQueueVersion || '',
      engine.companionServerContext || {})
      .catch((error: any) => logToBackend(`Could not report Companion buffering state: ${error?.message || error}`));
  }
  logToBackend(`queue: loading track ${index + 1}/${engine.queue.length}: ${nextTrack.title}`);
  try {
    const result: any = engine.companionActive
      ? await call('play_companion_track', nextTrack.id, engine.companionServerContext || {}, nextTrack.sourceServerId || '')
      : await call('play_track', nextTrack.id, nextTrack.sectionId);
    if (requestId !== engine.requestId) return;
    if (!result?.success || !result.stream_url) throw new Error(result?.error || 'Could not load queued track');
    engine.companionMediaContext = result.media_context || null;
    logToBackend(`queue: Plex provided audio for track ${nextTrack.id}`);
    engine.explicitlyStopped = false;
    engine.localConnection = result.local_connection === true;
    const started = await playStreamWithFallback(result.stream_url, result.fallback_stream_url || '', nextTrack.title, requestId, engine.localConnection);
    if (requestId === engine.requestId && !started) throw new Error('Playback request was interrupted');
    if (requestId === engine.requestId) reportTimeline('playing', true);
  } catch (e: any) {
    if (requestId !== engine.requestId) return;
    const mediaError = sharedAudio.error;
    const detail = `${e?.name || 'Error'} ${e?.message || 'Could not load queued track'}`;
    const message = mediaError
      ? `${detail}; media error code=${mediaError.code} ${mediaError.message || ''}`
      : detail;
    logToBackend(`queue: failed to load track ${nextTrack.title}: ${message}`);
    engine.explicitlyStopped = true;
    engine.failedRequestId = requestId;
    setPendingPlaybackRequest(0);
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    if (!engine.localConnection && index + 1 < engine.queue.length) {
      logToBackend(`queue: skipping unplayable track ${nextTrack.title} and trying the next song`);
      void playQueuedIndex(index + 1);
      return;
    }
    if (engine.companionActive) {
      void call('report_companion_timeline', nextTrack.id, 0, nextTrack.duration || 0, 'stopped',
        Math.round((sharedAudio.volume || 0) * 100), engine.companionPlayQueueId || '',
        nextTrack.playQueueItemID || '', engine.companionContainerKey || '', engine.companionPlayQueueVersion || '',
        engine.companionServerContext || {})
        .catch((reportError: any) => logToBackend(`Could not report stopped Companion queue: ${reportError?.message || reportError}`));
    }
    window.dispatchEvent(new CustomEvent('deckyplex-playback-error', { detail: { message, requestId } }));
  }
}

// Keep queue progression attached to the shared media element, so it continues
// even when Decky unmounts the browser and sidebar React trees.
if (!engine.listenersInitialized) {
engine.listenersInitialized = true;
sharedAudio.addEventListener('play', () => reportTimeline('playing'));
sharedAudio.addEventListener('error', () => {
  if (engine.remoteActive) return;
  const source = sharedAudio.currentSrc || sharedAudio.src;
  if (!source || !sharedAudio.src || source !== sharedAudio.src) return;
  const trackId = engine.track?.id;
  if (!trackId || !source || source === engine.diagnosedSource) return;
  engine.diagnosedSource = source;
  const mediaError = sharedAudio.error;
  logToBackend(`audio source rejected for track ${trackId}: code=${mediaError?.code || 0}; networkState=${sharedAudio.networkState}; readyState=${sharedAudio.readyState}`);
  call('inspect_stream', trackId, engine.localConnection ? engine.sourceUrl : source).then((result: any) => {
    logToBackend(`stream diagnostic for ${trackId}: HTTP ${result?.status || 'unavailable'}; range=${Boolean(result?.content_range)}; bytes=${result?.bytes || 0}`);
  }).catch(() => {
    logToBackend(`stream diagnostic failed for track ${trackId}`);
  });
});
sharedAudio.addEventListener('ended', () => {
  if (engine.explicitlyStopped || sharedAudio.error || !engine.track) return;
  logToBackend(`queue: track ended at ${engine.queueIndex + 1}/${engine.queue.length}`);
  if (!engine.companionActive) reportTimeline('stopped', true);
  if (engine.queueIndex + 1 < engine.queue.length) {
    void playQueuedIndex(engine.queueIndex + 1);
  } else if (engine.queueLoader) {
    void loadMoreQueue();
  } else {
    if (engine.companionActive) reportTimeline('stopped', true);
    stopSharedPlayback(false);
  }
});
window.setInterval(() => {
  if (!sharedAudio.paused) reportTimeline('playing');
}, 1000);
}

async function loadMoreQueue() {
  if (!engine.queueLoader || engine.queueLoadInProgress) return;
  setQueueLoading(true);
  const requestId = engine.requestId;
  try {
    const tracks = await engine.queueLoader();
    if (requestId !== engine.requestId || !tracks.length) {
      if (requestId === engine.requestId && !tracks.length) stopSharedPlayback(false);
      return;
    }
    const start = engine.queue.length;
    engine.queue.push(...tracks);
    await playQueuedIndex(start);
  } catch (e: any) {
    logToBackend(`queue: could not load next shuffle page: ${e?.message || e}`);
    stopSharedPlayback(false);
  } finally {
    setQueueLoading(false);
  }
}

async function startCompanionTrack(params: Record<string, string[]>) {
  const requestedKey = params.key?.[0] || '';
  const containerKey = params.containerKey?.[0] || engine.companionContainerKey || '';
  const incomingQueueId = containerKey.match(/\/playQueues\/(\d+)/)?.[1] || '';
  engine.lastCompanionPlayMediaAt = Date.now();
  if (engine.companionActive && !sharedAudio.paused && engine.track?.key === requestedKey
      && incomingQueueId === (engine.companionPlayQueueId || '')) {
    logToBackend(`Plex Companion repeated current playMedia; keeping ${engine.track.title} active`);
    void refreshCompanionQueue().then(refreshed => {
      if (!refreshed && engine.companionPlayQueueId === incomingQueueId) reportTimeline('playing', true);
    });
    return;
  }
  const previousContext = engine.companionServerContext || {};
  const requestedContext = {
    machine_identifier: params.machineIdentifier?.[0] || previousContext.machine_identifier || '',
    address: params.address?.[0] || previousContext.address || '',
    port: Number(params.port?.[0] || previousContext.port || 32400),
    protocol: params.protocol?.[0] || previousContext.protocol || 'http',
    token: params.token?.[0] || previousContext.token || '',
  };
  const requestBeforePrepare = engine.requestId;
  const prepared: any = await call('prepare_companion_playback', requestedKey,
    containerKey, requestedContext.machine_identifier, requestedContext.token,
    requestedContext.address, requestedContext.port, requestedContext.protocol);
  if (engine.requestId !== requestBeforePrepare && engine.remoteActive) return;
  if (!prepared?.success || !prepared.track || !prepared.stream_url) {
    const failedKey = requestedKey.match(/\/library\/metadata\/(\d+)/)?.[1] || '';
    logToBackend(`Plex Companion could not prepare incoming track: ${prepared?.error || 'missing stream URL'}`);
    if (failedKey) {
      void call('report_companion_timeline', failedKey, 0, 0, 'stopped', 50, '', '', '', '', requestedContext)
        .catch((error: any) => logToBackend(`Could not report Companion playback error: ${error?.message || error}`));
    }
    window.dispatchEvent(new CustomEvent('deckyplex-playback-error', {
      detail: { message: prepared?.error || 'Plexamp sent an unsupported track.' },
    }));
    return;
  }
  const toTrack = (item: any): TrackInfo => ({
    id: String(item.id || ''), sectionId: String(item.sectionId || ''), title: item.title || 'Unknown',
    artist: item.grandparentTitle || item.artist || '', album: item.parentTitle || '',
    duration: Number(item.duration) || 0, thumb: item.thumb || '',
    key: item.key || '', playQueueItemID: item.playQueueItemID || '', sourceServerId: item.sourceServerId || '',
  });
  const queue = (prepared.queue || [prepared.track]).map(toTrack).filter((item: TrackInfo) => item.id);
  const selected = toTrack(prepared.track);
  const requestId = ++engine.requestId;
  if (engine.track && !engine.remoteActive && !engine.companionActive) reportTimeline('stopped', true);
  engine.localCompanionQueueId = '';
  engine.remoteQueuePlayerId = '';
  engine.remoteQueueId = '';
  engine.remoteQueueVersion = '';
  engine.remoteQueueEditable = false;
  engine.remoteStatusTransition = null;
  engine.companionActive = true;
  engine.companionServerContext = prepared.server_context || requestedContext;
  engine.companionMediaContext = prepared.media_context || null;
  engine.companionPlayQueueId = prepared.play_queue_id || '';
  engine.companionContainerKey = prepared.container_key || '';
  engine.companionPlayQueueVersion = prepared.play_queue_version || '';
  engine.remoteActive = false;
  setPendingPlaybackRequest(requestId);
  engine.failedRequestId = 0;
  engine.explicitlyStopped = true;
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  engine.track = selected;
  engine.queue = queue.length ? queue : [selected];
  engine.queueIndex = Math.max(0, engine.queue.findIndex((item: TrackInfo) => selected.playQueueItemID
    ? item.playQueueItemID === selected.playQueueItemID : item.id === selected.id));
  engine.queueLoader = null;
  setQueueLoading(false);
  rememberCompanionSession();
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  window.dispatchEvent(new Event('deckyplex-track-change'));
  logToBackend(`Plex Companion starting ${selected.title} (${engine.queue.length} queued track(s))`);
  logToBackend(`Plex Companion selected queue item ${engine.queueIndex + 1}/${engine.queue.length} for key ${requestedKey}`);
  try {
    engine.localConnection = prepared.local_connection === true;
    const started = await playStreamWithFallback(prepared.stream_url, prepared.fallback_stream_url || '', selected.title,
      requestId, engine.localConnection);
    if (requestId !== engine.requestId || !started) return;
    reportTimeline('playing', true);
    window.dispatchEvent(new Event('deckyplex-track-change'));
    const offset = Number(params.offset?.[0] || 0);
    if (offset > 0) window.setTimeout(() => {
      if (engine.track?.id === selected.id && Number.isFinite(sharedAudio.duration)) sharedAudio.currentTime = offset / 1000;
    }, 500);
  } catch (error: any) {
    if (requestId !== engine.requestId) return;
    const message = error?.message || 'Could not start incoming Plex playback.';
    logToBackend(`Plex Companion playback failed: ${message}`);
    void call('report_companion_timeline', selected.id, 0, selected.duration || 0, 'stopped',
      Math.round((sharedAudio.volume || 0) * 100), engine.companionPlayQueueId || '',
      selected.playQueueItemID || '', engine.companionContainerKey || '', engine.companionPlayQueueVersion || '',
      engine.companionServerContext || {})
      .catch((reportError: any) => logToBackend(`Could not report Companion playback error: ${reportError?.message || reportError}`));
    window.dispatchEvent(new CustomEvent('deckyplex-playback-error', { detail: { message, requestId } }));
  }
}

function handleCompanionCommand(entry: any) {
  const params: Record<string, string[]> = entry.params || {};
  // The event and poll can deliver the same request. Plexamp can reuse its
  // command ID for a different request after it relaunches.
  const deliveryId = entry.delivery_id;
  if (deliveryId) {
    const handled: string[] = engine.handledCompanionCommands || (engine.handledCompanionCommands = []);
    if (handled.includes(deliveryId)) return;
    handled.push(deliveryId);
    if (handled.length > 64) handled.splice(0, handled.length - 64);
  }
  if ((engine.remoteStartRequestId && engine.remoteStartRequestId === engine.requestId) ||
      (engine.remoteActive && !isPlayingOnDeck() && entry.command !== 'playMedia')) return;
  logToBackend(`Plex Companion frontend received ${entry.command || 'unknown'} command`);
  const value = (key: string) => Number(params[key]?.[0] || 0);
  switch (entry.command) {
    case 'playMedia': void startCompanionTrack(params); break;
    case 'play':
      engine.explicitlyStopped = false;
      void sharedAudio.play().catch((error: any) => logToBackend(`Plex Companion resume failed: ${error?.message || error}`));
      break;
    case 'pause':
      logToBackend('Plex Companion pause command received');
      sharedAudio.pause();
      reportTimeline('paused', true);
      break;
    case 'stop':
      if (engine.companionActive && Date.now() - (engine.lastCompanionPlayMediaAt || 0) < 1500) {
        logToBackend('Plex Companion stop arrived during a new queue handoff; ignoring stale stop');
        break;
      }
      logToBackend('Plex Companion stop command received');
      stopSharedPlayback(true);
      engine.companionActive = false;
      window.dispatchEvent(new Event('deckyplex-companion-stop'));
      break;
    case 'next':
      if (engine.queueIndex + 1 < engine.queue.length) void playQueuedIndex(engine.queueIndex + 1);
      else if (engine.queueLoader) void loadMoreQueue();
      break;
    case 'skipTo': {
      const key = params.key?.[0] || '';
      const ratingKey = key.match(/\/library\/metadata\/(\d+)/)?.[1] || '';
      const targetIndex = engine.queue.findIndex((track: TrackInfo) =>
        track.key === key || (ratingKey && track.id === ratingKey));
      if (targetIndex >= 0) void playQueuedIndex(targetIndex);
      else if (ratingKey && engine.companionActive) {
        logToBackend(`Plex Companion skipTo key is outside the loaded queue; loading from server: ${key}`);
        void startCompanionTrack({ ...params, key: [key], containerKey: [params.containerKey?.[0] || engine.companionContainerKey || ''] });
      } else logToBackend(`Plex Companion skipTo key not found in queue: ${key}`);
      break;
    }
    case 'refreshQueue':
      if (engine.companionActive && engine.companionPlayQueueId) {
        void refreshCompanionQueue();
      }
      break;
    case 'previous': {
      const previous = sharedAudio.currentTime > 3 ? engine.queueIndex : engine.queueIndex - 1;
      if (previous >= 0 && previous < engine.queue.length) void playQueuedIndex(previous);
      else sharedAudio.currentTime = 0;
      break;
    }
    case 'seek':
      sharedAudio.currentTime = Math.max(0, value('offset') / 1000);
      reportTimeline(sharedAudio.paused ? 'paused' : 'playing', true);
      break;
    case 'parameters': {
      const volume = params.volume?.[0];
      if (volume != null) {
        const normalized = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
        if (normalized !== Math.round(sharedAudio.volume * 100)) setSharedVolume(normalized, true);
      }
      break;
    }
  }
}

async function refreshCompanionQueue(added?: Pick<TrackInfo, 'playQueueItemID' | 'sourceServerId'>, includeRemaining = false) {
  const currentTrack = engine.track;
  const queueId = engine.companionPlayQueueId;
  const context = engine.companionServerContext;
  if (!engine.companionActive || !currentTrack || !queueId) return false;
  try {
    const expandedQueue = engine.queue.length - Math.max(0, engine.queueIndex) > 201;
    const result: any = await call('refresh_companion_queue', queueId,
      currentTrack.playQueueItemID || '', context || {}, includeRemaining || expandedQueue);
    if (!result?.success) throw new Error(result?.error || 'Plex did not return the updated queue');
    if (!engine.companionActive || engine.companionPlayQueueId !== queueId || engine.companionServerContext !== context) return false;
    if (engine.track?.playQueueItemID !== currentTrack.playQueueItemID) return false;
    if (Number(result.play_queue_version || 0) < Number(engine.companionPlayQueueVersion || 0)) return false;
    const knownSources = new Map<string, string>();
    for (const track of engine.queue as TrackInfo[]) {
      if (track.playQueueItemID && track.sourceServerId) knownSources.set(track.playQueueItemID, track.sourceServerId);
    }
    if (added?.playQueueItemID && added.sourceServerId) knownSources.set(added.playQueueItemID, added.sourceServerId);
    const refreshed = (result.queue || []).map((item: any): TrackInfo => ({
      id: String(item.id || ''), sectionId: String(item.sectionId || ''),
      title: item.title || 'Unknown', artist: item.grandparentTitle || item.artist || '',
      album: item.parentTitle || '', duration: Number(item.duration) || 0,
      thumb: item.thumb || '', key: item.key || '',
      playQueueItemID: item.playQueueItemID || '',
      sourceServerId: item.sourceServerId || knownSources.get(item.playQueueItemID) || '',
    })).filter((item: TrackInfo) => item.id);
    if (!refreshed.length || refreshed[0].playQueueItemID !== currentTrack.playQueueItemID) {
      throw new Error('Plex did not include the currently playing track in the queue update');
    }
    const previous = engine.queue.slice(0, Math.max(0, engine.queueIndex));
    engine.queue = [...previous, ...refreshed];
    engine.queueIndex = previous.length;
    engine.track = refreshed[0];
    engine.companionPlayQueueVersion = result.play_queue_version || engine.companionPlayQueueVersion;
    rememberCompanionSession();
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    window.dispatchEvent(new Event('deckyplex-track-change'));
    reportTimeline(sharedAudio.paused ? 'paused' : 'playing', true);
    logToBackend(`Plex Companion queue refreshed (${refreshed.length} track(s), version ${engine.companionPlayQueueVersion})`);
    return true;
  } catch (error: any) {
    logToBackend(`Plex Companion queue refresh failed: ${error?.message || error}`);
    return false;
  }
}

function applyCompanionQueueAddition(track: TrackInfo, afterItemId: string, version: string) {
  if (engine.queue.some((entry: TrackInfo) => entry.playQueueItemID === track.playQueueItemID)) return true;
  if (!afterItemId || Number(version || 0) < Number(engine.companionPlayQueueVersion || 0)) return false;
  const preceding = engine.queue.findIndex((entry: TrackInfo) => entry.playQueueItemID === afterItemId);
  if (preceding < 0) return false;
  const position = preceding + 1;
  engine.queue.splice(position, 0, track);
  if (position <= engine.queueIndex) engine.queueIndex++;
  engine.companionPlayQueueVersion = version || engine.companionPlayQueueVersion;
  rememberCompanionSession();
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  reportTimeline(sharedAudio.paused ? 'paused' : 'playing', true);
  return true;
}

// Decky's backend event bridge delivers commands immediately; the polling loop
// below remains as a recovery path for events emitted before this bundle loads.
addEventListener<[entry: any]>('companion_command', handleCompanionCommand);

function startCompanionCommandPolling() {
  // Do not use a window-global "already started" flag here. Decky can reload
  // this bundle while preserving window state, leaving that flag true after the
  // old interval has been discarded. Each live bundle may poll safely because
  // the backend drains commands atomically.
  let polling = false;
  logToBackend('Plex Companion frontend poller started');
  window.setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const response: any = await call('poll_companion_commands');
      for (const entry of response?.commands || []) handleCompanionCommand(entry);
    } catch (error: any) {
      logToBackend(`Plex Companion command poll failed: ${error?.message || error}`);
    } finally {
      polling = false;
    }
  }, 500);
}

startCompanionCommandPolling();

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [localVolume, setLocalVolumeState] = useState(() => Math.round(sharedAudio.volume * 100));
  const [volumeSliderRevision, setVolumeSliderRevision] = useState(() => Number(engine.volumeSliderRevision) || 0);
  const [playbackPending, setPlaybackPending] = useState(isPlaybackPending);
  const [state, setState] = useState<PlayerState>({
    playbackState: "stopped",
    track: engine.track,
    volume: localVolume,
    error: null,
    progress: 0,
    duration: 0,
    remoteMode: canControlRemotePlayer(),
    remoteTargetSelected: !!engine.remoteTargetId,
    companionMode: !!engine.companionActive && !engine.localCompanionQueueId,
    remotePlayerId: engine.remoteTargetId || '',
    remotePlayerName: engine.remoteTargetName || '',
    queue: engine.queue.slice(),
    queueIndex: engine.queueIndex,
  });

  useEffect(() => {
    const onPendingChange = () => setPlaybackPending(isPlaybackPending());
    window.addEventListener('deckyplex-playback-pending', onPendingChange);
    onPendingChange();
    return () => window.removeEventListener('deckyplex-playback-pending', onPendingChange);
  }, []);

  const beginPlaybackRequest = useCallback(() => {
    const requestId = ++engine.requestId;
    setPendingPlaybackRequest(0);
    engine.explicitlyStopped = true;
    if (engine.track && !engine.remoteActive) reportTimeline('stopped', true);
    unshareLocalCompanionQueue();
    engine.companionActive = false;
    engine.companionServerContext = null;
    engine.lastCompanionSession = null;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    engine.track = null;
    engine.remoteActive = false;
    engine.remoteQueuePlayerId = '';
    engine.remoteQueueId = '';
    engine.remoteQueueVersion = '';
    engine.remoteQueueEditable = false;
    engine.remoteStatusTransition = null;
    engine.queue = [];
    engine.queueIndex = -1;
    engine.queueLoader = null;
    setQueueLoading(false);
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    window.dispatchEvent(new Event('deckyplex-track-change'));
    return requestId;
  }, []);

  // Initialize audio element once
  useEffect(() => {
    audioRef.current = sharedAudio;

    const onPlay = () => {
      if (engine.remoteActive) return;
      reportTimeline('playing');
      setState(s => ({ ...s, playbackState: "playing", error: null }));
    };
    const onPause = () => {
      if (sharedAudio.paused && !engine.explicitlyStopped && !engine.remoteActive) {
        setState(s => ({ ...s, playbackState: "paused" }));
      }
    };
    const onEnded = () => {
      if (!engine.remoteActive) setState(s => ({ ...s, playbackState: "stopped", progress: 0 }));
    };
    const onError = (e: Event) => {
      const audio = e.target as HTMLAudioElement;
      const mediaError = audio.error;
      const msg = mediaError ? mediaError.message : "Playback error";
      if (engine.explicitlyStopped || engine.remoteActive) return;
      if (engine.pendingRequestId === engine.requestId || engine.failedRequestId === engine.requestId) return;
      logToBackend(`audio error: code=${mediaError?.code} ${msg}`);
      engine.explicitlyStopped = true;
      reportTimeline('stopped', true);
      showTransientPlaybackError(setState, msg);
    };
    const onTimeUpdate = () => setState(s => s.remoteMode ? s : ({
        ...s,
        progress: Number.isFinite(sharedAudio.currentTime) ? sharedAudio.currentTime : 0,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (engine.track?.duration || 0) / 1000,
      }));
    const onLoadedMetadata = () => setState(s => s.remoteMode ? s : ({
        ...s,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (engine.track?.duration || 0) / 1000,
      }));
    const onDurationChange = () => setState(s => s.remoteMode ? s : ({
        ...s,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (engine.track?.duration || 0) / 1000,
      }));
    const onTrackChange = () => {
      const remoteMode = canControlRemotePlayer();
      setState(s => ({
        ...s,
        track: engine.track,
        progress: engine.companionActive && engine.track ? sharedAudio.currentTime || 0 : 0,
        duration: engine.track ? (engine.track.duration || 0) / 1000 : 0,
        remoteMode,
        companionMode: !!engine.companionActive && !engine.localCompanionQueueId,
        playbackState: !engine.track ? 'stopped' : remoteMode ? s.playbackState
          : isPlayingOnDeck() && !sharedAudio.paused ? 'playing' : 'paused',
        error: null,
      }));
    };
    const onQueueChange = () => setState(s => ({ ...s, queue: engine.queue.slice(), queueIndex: engine.queueIndex }));
    const onCompanionStop = () => setState(s => ({ ...s, companionMode: false }));
    const onVolumeChange = (event: Event) => {
      const volume = Number((event as CustomEvent<number>).detail);
      if (Number.isFinite(volume)) {
        setLocalVolumeState(volume);
        setVolumeSliderRevision(Number(engine.volumeSliderRevision) || 0);
        setState(s => s.remoteMode ? s : { ...s, volume });
      }
    };
    const onPlaybackError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; requestId?: number }>).detail;
      if (detail?.requestId != null && detail.requestId !== engine.requestId) return;
      const message = detail?.message || 'Could not load queued track';
      showTransientPlaybackError(setState, message);
    };

    sharedAudio.addEventListener('play', onPlay);
    sharedAudio.addEventListener('pause', onPause);
    sharedAudio.addEventListener('ended', onEnded);
    sharedAudio.addEventListener('error', onError);
    sharedAudio.addEventListener('timeupdate', onTimeUpdate);
    sharedAudio.addEventListener('loadedmetadata', onLoadedMetadata);
    sharedAudio.addEventListener('durationchange', onDurationChange);
    window.addEventListener('deckyplex-track-change', onTrackChange);
    window.addEventListener('deckyplex-queue-change', onQueueChange);
    window.addEventListener('deckyplex-volume-change', onVolumeChange);
    window.addEventListener('deckyplex-playback-error', onPlaybackError);
    window.addEventListener('deckyplex-companion-stop', onCompanionStop);
    setState(s => ({
      ...s,
      track: engine.track,
      playbackState: engine.track ? (sharedAudio.paused ? "paused" : "playing") : "stopped",
      progress: Number.isFinite(sharedAudio.currentTime) ? sharedAudio.currentTime : 0,
      duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
        ? sharedAudio.duration
        : (engine.track?.duration || 0) / 1000,
    }));

    return () => {
      sharedAudio.removeEventListener('play', onPlay);
      sharedAudio.removeEventListener('pause', onPause);
      sharedAudio.removeEventListener('ended', onEnded);
      sharedAudio.removeEventListener('error', onError);
      sharedAudio.removeEventListener('timeupdate', onTimeUpdate);
      sharedAudio.removeEventListener('loadedmetadata', onLoadedMetadata);
      sharedAudio.removeEventListener('durationchange', onDurationChange);
      window.removeEventListener('deckyplex-track-change', onTrackChange);
      window.removeEventListener('deckyplex-queue-change', onQueueChange);
      window.removeEventListener('deckyplex-volume-change', onVolumeChange);
      window.removeEventListener('deckyplex-playback-error', onPlaybackError);
      window.removeEventListener('deckyplex-companion-stop', onCompanionStop);
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const volumeSession = engine.volumeSession;
    const updateTargetState = () => {
      const remoteMode = canControlRemotePlayer();
      setState(s => ({
        ...s,
        remoteMode,
        remoteTargetSelected: !!engine.remoteTargetId,
        volume: remoteMode ? s.volume : Math.round(sharedAudio.volume * 100),
        remotePlayerId: engine.remoteTargetId || '',
        remotePlayerName: engine.remoteTargetName || '',
      }));
    };
    let settingsRequest = 0;
    const refreshTarget = async () => {
      const request = ++settingsRequest;
      try {
        const settings: any = await call('get_settings');
        if (!mounted || engine.volumeSession !== volumeSession || request !== settingsRequest) return;
        if (!engine.volumePreferenceLoaded) {
          const savedVolume = settings.volume;
          const normalizedVolume = Number.isFinite(savedVolume)
            ? Math.max(0, Math.min(100, savedVolume)) : DEFAULT_LOCAL_VOLUME;
          engine.volumePreferenceLoaded = true;
          setSharedVolume(normalizedVolume, true);
        }
        applyMusicPlaybackTarget(settings);
        const enabled = settings.companion_receiver_enabled === true && settings.local_server_enabled !== true;
        if (enabled && !engine.receiverEnabled) engine.shareQueueRetryAt = 0;
        engine.receiverEnabled = enabled;
        if (!enabled || (engine.localPlaybackServerId && engine.localPlaybackServerId !== engine.selectedServerId)) {
          unshareLocalCompanionQueue();
        } else if (!engine.companionActive) {
          void shareLocalCompanionQueue();
        }
        updateTargetState();
      } catch {}
    };
    window.addEventListener('deckyplex-music-target-change', updateTargetState);
    refreshTarget();
    const interval = window.setInterval(refreshTarget, 5000);
    window.addEventListener('deckyplex-settings-change', refreshTarget);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('deckyplex-settings-change', refreshTarget);
      window.removeEventListener('deckyplex-music-target-change', updateTargetState);
    };
  }, []);

  useEffect(() => {
    if (!state.remoteMode || !state.remotePlayerId) return;
    let active = true;
    let loading = false;
    const refreshRemoteStatus = async () => {
      if (loading || engine.pendingRequestId || engine.remoteCommandsPending) return;
      const requestId = engine.requestId;
      const queueRevision = engine.remoteQueueRevision;
      const playerId = state.remotePlayerId;
      const ownQueue = engine.remoteQueuePlayerId === playerId;
      loading = true;
      try {
        const result: any = await call('get_remote_player_status', playerId,
          ownQueue ? engine.remoteQueueId || '' : '', ownQueue ? engine.remoteQueueVersion || '' : '',
          ownQueue ? engine.remoteQueueItemId || '' : '');
        if (!active || requestId !== engine.requestId || queueRevision !== engine.remoteQueueRevision
            || !canControlRemotePlayer() || engine.remoteTargetId !== playerId) return;
        if (result?.error) throw new Error(result.error);
        const playing = result?.state === 'playing' || result?.state === 'paused';
        const snapshot = Array.isArray(result.queue) ? result.queue
          : engine.remoteQueuePlayerId === playerId ? engine.queue : [];
        const queuedTrack = snapshot.find((item: TrackInfo) => result.play_queue_item_id
          ? item.playQueueItemID === result.play_queue_item_id : item.id === result.track?.id);
        const sourceServerId = queuedTrack?.sourceServerId || result.track?.sourceServerId || '';
        const differentArtworkServer = !!queuedTrack?.sourceServerId && sourceServerId !== result.track?.sourceServerId;
        const remoteTrack = playing && result.track ? {
          id: result.track.id || '', sectionId: '', title: result.track.title || queuedTrack?.title || 'Unknown',
          artist: result.track.artist || queuedTrack?.artist || '', album: result.track.album || queuedTrack?.album || '',
          duration: result.track.duration || queuedTrack?.duration || 0,
          thumb: differentArtworkServer ? '' : result.track.thumb || queuedTrack?.thumb || '',
          sourceServerId,
        } : null;
        const transition = engine.remoteStatusTransition;
        let startFailed = false;
        if (transition?.playerId === playerId) {
          const requestedQueueIsPlaying = remoteTrack && result.play_queue_id
            && result.play_queue_id !== transition.previousQueueId && Array.isArray(result.queue)
            && result.queue.some((item: TrackInfo) => item.id === transition.trackId);
          const reachedTarget = transition.waitingForPlayback
            ? remoteTrack?.id === transition.trackId || requestedQueueIsPlaying : !remoteTrack;
          if (!reachedTarget && Date.now() < transition.until) return;
          startFailed = transition.waitingForPlayback && !reachedTarget;
          engine.remoteStatusTransition = null;
        }
        if (!remoteTrack && engine.remoteActive && !startFailed) {
          engine.remoteIdleSince ||= Date.now();
          if (Date.now() - engine.remoteIdleSince < 3000) return;
        }
        engine.remoteIdleSince = 0;
        engine.remoteActive = !!remoteTrack;
        if (remoteTrack) {
          applyRemoteQueueStatus(playerId, result, remoteTrack);
        } else {
          clearRemoteQueue();
        }
        setState(s => ({
          ...s,
          track: remoteTrack,
          playbackState: remoteTrack ? result.state : 'stopped',
          progress: Number(result.progress) || 0,
          duration: Number(result.duration) || (remoteTrack?.duration || 0) / 1000,
          volume: Number.isFinite(result.volume) ? result.volume : s.volume,
          error: startFailed ? 'The selected Plex player did not confirm the requested track.' : remoteTrack ? null : s.error,
        }));
      } catch (e: any) {
        if (active && requestId === engine.requestId && queueRevision === engine.remoteQueueRevision) {
          const transition = engine.remoteStatusTransition;
          if (transition?.playerId === playerId && transition.waitingForPlayback) {
            if (Date.now() < transition.until) return;
            engine.remoteStatusTransition = null;
            engine.remoteActive = false;
            clearRemoteQueue();
          }
          setState(s => ({ ...s, error: e?.message || 'Remote player connection failed.',
            playbackState: s.playbackState === 'starting' ? 'stopped' : s.playbackState }));
        }
      } finally {
        loading = false;
      }
    };
    refreshRemoteStatus();
    const interval = window.setInterval(refreshRemoteStatus, 2500);
    window.addEventListener('deckyplex-remote-queue-edited', refreshRemoteStatus);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener('deckyplex-remote-queue-edited', refreshRemoteStatus);
    };
  }, [state.remoteMode, state.remotePlayerId]);

  const playRemoteQueue = useCallback(async (playerId: string, queue: TrackInfo[], startId?: string) => {
    if (!playerId || playerId !== engine.remoteTargetId) {
      return { success: false, error: 'The selected Plex playback target changed. Try playing the track again.' };
    }
    const playable = queue.filter(track => track.id);
    if (!playable.length) return { success: false, error: 'No tracks found to play.' };
    const selected = playable.find(track => track.id === startId) || playable[0];
    const previousQueueId = engine.remoteQueueId;
    const requestId = ++engine.requestId;
    engine.remoteStartRequestId = requestId;
    setPendingPlaybackRequest(requestId);
    try {
      const result: any = await call('play_remote_queue', playerId,
        playable.map(track => track.id), selected.id);
      if (requestId !== engine.requestId || engine.remoteTargetId !== playerId) {
        return { success: false, error: 'Playback request was replaced.' };
      }
      if (!result?.success) return { success: false, error: result?.error || 'Could not start playback on the selected Plex player.' };
      if (isPlayingOnDeck()) stopSharedPlayback(true);
      engine.companionActive = false;
      engine.companionServerContext = null;
      engine.lastCompanionSession = null;
      engine.explicitlyStopped = true;
      engine.remoteActive = true;
      engine.track = selected;
      engine.queue = playable;
      engine.queueIndex = playable.indexOf(selected);
      engine.remoteQueuePlayerId = playerId;
      engine.remoteQueueId = '';
      engine.remoteQueueVersion = '';
      engine.remoteQueueItemId = '';
      engine.remoteQueueEditable = false;
      engine.remoteIdleSince = 0;
      engine.remoteStatusTransition = {
        playerId, previousQueueId, trackId: selected.id, waitingForPlayback: true, until: Date.now() + 10000,
      };
      window.dispatchEvent(new Event('deckyplex-queue-change'));
      window.dispatchEvent(new Event('deckyplex-track-change'));
      setState(s => ({ ...s, remoteMode: true, track: selected, error: null, playbackState: 'starting', progress: 0,
        duration: (selected.duration || 0) / 1000 }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not start remote playback.' };
    } finally {
      if (engine.remoteStartRequestId === requestId) engine.remoteStartRequestId = 0;
      if (engine.pendingRequestId === requestId) setPendingPlaybackRequest(0);
    }
  }, []);

  const controlRemotePlayer = useCallback(async (command: string, value = 0) => {
    if (!state.remotePlayerId) return false;
    engine.remoteCommandsPending = (engine.remoteCommandsPending || 0) + 1;
    if (command !== 'volume') engine.remoteQueueRevision = (engine.remoteQueueRevision || 0) + 1;
    window.dispatchEvent(new Event('deckyplex-playback-pending'));
    try {
      const result: any = await call('control_remote_player', state.remotePlayerId, command, Math.round(value));
      if (!result?.success) throw new Error(result?.error || `Could not ${command} remote player.`);
      setState(s => ({ ...s, error: null }));
      return true;
    } catch (e: any) {
      setState(s => ({ ...s, error: e?.message || 'Remote player command failed.' }));
      return false;
    } finally {
      engine.remoteCommandsPending--;
      window.dispatchEvent(new Event('deckyplex-playback-pending'));
    }
  }, [state.remotePlayerId]);

  const playTrack = useCallback((streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl = '', loadMore?: () => Promise<TrackInfo[]>, requestToken?: number, localConnection = false) => {
    const audio = audioRef.current;
    if (!audio) {
      logToBackend(`playTrack: audio element not initialized`);
      return;
    }
    const wasRemotePlayback = engine.remoteActive;
    if (requestToken != null && requestToken !== engine.requestId) return;
    const requestId = requestToken ?? ++engine.requestId;
    engine.failedRequestId = 0;
    setPendingPlaybackRequest(requestId);

    logToBackend(`playTrack: starting audio for track ${trackInfo.id}`);
    engine.explicitlyStopped = false;
    if (engine.track && engine.track.id !== trackInfo.id && !wasRemotePlayback) reportTimeline('stopped', true);
    unshareLocalCompanionQueue();
    engine.localPlaybackServerId = engine.selectedServerId || '';
    engine.localConnection = localConnection;
    engine.shareQueueRetryAt = 0;
    engine.remoteActive = false;
    engine.track = trackInfo;
    if (queue?.length) {
      engine.queue = queue;
      engine.queueIndex = Math.max(0, engine.queue.findIndex((item: TrackInfo) => item.id === trackInfo.id));
    } else if (!engine.queue.some((item: TrackInfo) => item.id === trackInfo.id)) {
      engine.queue = [trackInfo];
      engine.queueIndex = 0;
    }
    engine.queueLoader = loadMore || null;
    setQueueLoading(false);
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    logToBackend(`queue: set ${engine.queue.length} track(s), starting at ${engine.queueIndex + 1}`);
    window.dispatchEvent(new Event('deckyplex-track-change'));
    setState(s => ({ ...s, error: null, playbackState: "paused", track: trackInfo, progress: 0, duration: (trackInfo.duration || 0) / 1000 }));

    // Prefer the direct Plex media part for MP3/FLAC, then try Plex's MP3 transcode.
    logToBackend(`playTrack: using native audio playback`);
    playStreamWithFallback(streamUrl, fallbackStreamUrl, trackInfo.title, requestId, localConnection).then((started) => {
      if (!started || requestId !== engine.requestId) return;
      engine.failedRequestId = 0;
      logToBackend(`playTrack: playback started successfully`);
      if (engine.receiverEnabled) void shareLocalCompanionQueue();
      setState(s => ({ ...s, playbackState: "playing" }));
    }).catch((e: Error) => {
      if (requestId !== engine.requestId) return;
      const errDetail = audio.error
        ? `play() failed: ${e.name} ${e.message}, audio.error.code=${audio.error.code} ${audio.error.message}`
        : `play() failed: ${e.name} ${e.message}`;
      logToBackend(errDetail);
      engine.explicitlyStopped = true;
      engine.failedRequestId = requestId;
      setPendingPlaybackRequest(0);
      sharedAudio.pause();
      sharedAudio.removeAttribute('src');
      sharedAudio.load();
      const nextIndex = engine.queueIndex + 1;
      if (!localConnection && nextIndex < engine.queue.length) {
        logToBackend(`queue: skipping unplayable track ${trackInfo.title} and trying the next song`);
        void playQueuedIndex(nextIndex);
        return;
      }
      setState(s => ({ ...s, error: e.message || "Failed to play", playbackState: "stopped" }));
    });
  }, []);

  const play = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('play');
      return;
    }
    if (!engine.companionActive && !engine.track && engine.lastCompanionSession) {
      const session = engine.lastCompanionSession;
      engine.companionActive = true;
      engine.companionServerContext = session.serverContext;
      engine.companionPlayQueueId = session.playQueueId;
      engine.companionContainerKey = session.containerKey;
      engine.companionPlayQueueVersion = session.playQueueVersion;
      engine.queue = session.queue.slice();
      engine.queueIndex = Math.max(0, Math.min(session.queueIndex, engine.queue.length - 1));
      window.dispatchEvent(new Event('deckyplex-queue-change'));
      void playQueuedIndex(engine.queueIndex);
      return;
    }
    if (engine.companionActive && engine.track && engine.queue.length
        && (!engine.localCompanionQueueId || !audioRef.current?.getAttribute('src'))) {
      // A phone may let its Plex session expire while paused or asleep. Reload
      // the current item through Plex so playback and the phone timeline reconnect.
      void playQueuedIndex(engine.queueIndex);
      return;
    }
    if (audioRef.current) {
      engine.explicitlyStopped = false;
      const companionPlayback = engine.companionActive;
      const requestId = engine.requestId;
      audioRef.current.play().then(() => {
        if (companionPlayback && engine.requestId === requestId) reportTimeline('playing', true);
      }).catch((e: Error) => {
        if (requestId !== engine.requestId) return;
        if (engine.localCompanionQueueId && engine.queueIndex >= 0) {
          void playQueuedIndex(engine.queueIndex);
          return;
        }
        setState(s => ({ ...s, error: e.message || "Failed to play" }));
      });
    }
  }, [state.remoteMode, controlRemotePlayer]);

  const pause = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('pause');
      return;
    }
    if (audioRef.current) {
      engine.requestId++;
      setPendingPlaybackRequest(0);
      reportTimeline('paused', true);
      audioRef.current.pause();
    }
  }, [state.remoteMode, controlRemotePlayer]);

  const stop = useCallback(() => {
    if (state.remoteMode) {
      const requestId = ++engine.requestId;
      void controlRemotePlayer('stop').then(stopped => {
        if (!stopped || requestId !== engine.requestId || engine.remoteTargetId !== state.remotePlayerId) return;
        engine.remoteStatusTransition = { playerId: state.remotePlayerId, waitingForPlayback: false, until: Date.now() + 5000 };
        engine.remoteActive = false;
        clearRemoteQueue();
        setState(s => ({ ...s, playbackState: 'stopped', track: null, progress: 0, duration: 0 }));
      });
      return;
    }
    stopSharedPlayback(true);
    engine.companionActive = false;
    engine.companionServerContext = null;
    window.dispatchEvent(new Event('deckyplex-companion-stop'));
    setState(s => ({ ...s, playbackState: "stopped", track: null, progress: 0, duration: 0 }));
  }, [state.remoteMode, state.remotePlayerId, controlRemotePlayer]);

  const skipNext = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('next');
      return;
    }
    const nextIndex = engine.queueIndex + 1;
    if (nextIndex < engine.queue.length) void playQueuedIndex(nextIndex);
    else if (engine.queueLoader) void loadMoreQueue();
  }, [state.remoteMode, controlRemotePlayer]);

  const skipPrevious = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('previous');
      return;
    }
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (engine.queueIndex > 0) void playQueuedIndex(engine.queueIndex - 1);
  }, [state.remoteMode, controlRemotePlayer]);

  const playQueueIndex = useCallback((index: number) => {
    if (state.remoteMode) return;
    if (index >= 0 && index < engine.queue.length) void playQueuedIndex(index);
  }, [state.remoteMode]);

  const editRemoteQueue = useCallback(async (action: 'next' | 'append' | 'remove', itemId: string) => {
    const playerId = engine.remoteTargetId;
    if (!engine.remoteQueueEditable || engine.remoteQueuePlayerId !== playerId || !engine.remoteQueueId || !itemId) {
      return { success: false, error: 'The selected player has not shared an editable queue. Try editing it in Plexamp.' };
    }
    if (engine.remoteCommandsPending) return { success: false, error: 'The selected player is processing a command.' };
    engine.remoteCommandsPending = 1;
    engine.remoteQueueRevision = (engine.remoteQueueRevision || 0) + 1;
    window.dispatchEvent(new Event('deckyplex-playback-pending'));
    try {
      const result: any = await call('edit_remote_music_queue', playerId, engine.remoteQueueId, action, itemId);
      if (!result?.success) throw new Error(result?.error || 'Could not edit the selected player’s queue.');
      return { success: true, warning: result.warning as string | undefined };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Could not update the queue.' };
    } finally {
      engine.remoteCommandsPending--;
      engine.remoteQueueVersion = '';
      window.dispatchEvent(new Event('deckyplex-playback-pending'));
      window.dispatchEvent(new Event('deckyplex-remote-queue-edited'));
    }
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    if (index < 0 || index >= engine.queue.length) return;
    const track = engine.queue[index] as TrackInfo;
    if (state.remoteMode) {
      if (index !== engine.queueIndex) void editRemoteQueue('remove', track.playQueueItemID || '').then(result => {
        if (!result.success) setState(s => ({ ...s, error: result.error || 'Could not remove the queued track.' }));
        else if (result.warning) setState(s => ({ ...s, error: result.warning || '' }));
      });
      return;
    }
    if (engine.companionActive && engine.companionPlayQueueId && track.playQueueItemID
        && track.playQueueItemID !== engine.track?.playQueueItemID) {
      const queueId = engine.companionPlayQueueId;
      void call('remove_companion_queue_track', queueId, track.playQueueItemID, engine.companionServerContext || {})
        .then(async (result: any) => {
          if (!result?.success) throw new Error(result?.error || 'Could not remove the shared queue item.');
          if (engine.companionPlayQueueId !== queueId) return;
          const removedIndex = engine.queue.findIndex((entry: TrackInfo) => entry.playQueueItemID === track.playQueueItemID);
          if (removedIndex >= 0 && removedIndex !== engine.queueIndex) {
            engine.queue.splice(removedIndex, 1);
            if (removedIndex < engine.queueIndex) engine.queueIndex--;
            rememberCompanionSession();
            window.dispatchEvent(new Event('deckyplex-queue-change'));
          }
          await refreshCompanionQueue();
        }).catch((error: Error) => {
          setState(s => ({ ...s, error: error.message }));
        });
      return;
    }
    if (index === engine.queueIndex) {
      // Keep the current audio playing, but remove it and already-played entries
      // from the upcoming queue. The next item becomes index zero.
      engine.queue = engine.queue.slice(index + 1);
      engine.queueIndex = -1;
    } else {
      engine.queue.splice(index, 1);
      if (index < engine.queueIndex) engine.queueIndex--;
    }
    window.dispatchEvent(new Event('deckyplex-queue-change'));
  }, [state.remoteMode, editRemoteQueue]);

  const addToQueue = useCallback(async (track: TrackInfo, playNext = false) => {
    if (!track.id) return { success: false, error: 'This track has no Plex ID.' };
    if (engine.remoteTargetId && !isPlayingOnDeck()) return editRemoteQueue(playNext ? 'next' : 'append', track.id);
    if (engine.companionActive) {
      if (!engine.companionPlayQueueId || !engine.track?.playQueueItemID) {
        logToBackend('queue: cannot edit Plexamp queue because its active queue item is unknown');
        const error = 'Plexamp did not provide an editable queue for this session.';
        setState(s => ({ ...s, error }));
        return { success: false, error };
      }
      const queueId = engine.companionPlayQueueId;
      const context = engine.companionServerContext;
      try {
        const result: any = await call('add_companion_queue_track', track.id, queueId,
          engine.track.playQueueItemID, context || {}, playNext, track.sourceServerId || '');
        if (!result?.success || !result.track?.playQueueItemID) {
          throw new Error(result?.error || 'Plex did not confirm the queued track');
        }
        if (!engine.companionActive || engine.companionPlayQueueId !== queueId || engine.companionServerContext !== context) {
          return { success: false, error: 'Plexamp playback changed before the queue update completed.' };
        }
        const added = { ...track, key: result.track.key || track.key, thumb: result.track.thumb || track.thumb,
          playQueueItemID: result.track.playQueueItemID as string, sourceServerId: result.track.sourceServerId || track.sourceServerId };
        if (!applyCompanionQueueAddition(added, result.after_item_id || '', result.play_queue_version || '')) {
          if (!await refreshCompanionQueue(added, !playNext) || !engine.queue.some((entry: TrackInfo) => entry.playQueueItemID === added.playQueueItemID)) {
            return { success: true, warning: 'Plex added the track, but DeckyPlex could not sync the updated queue.' };
          }
        }
        logToBackend(`queue: added ${track.title} to Plexamp queue (${playNext ? 'next' : 'upcoming'})`);
        return { success: true, warning: result.warning || undefined };
      } catch (error: any) {
        logToBackend(`queue: could not update Plexamp queue: ${error?.message || error}`);
        const message = error?.message || 'Could not update the Plexamp queue.';
        setState(s => ({ ...s, error: message }));
        return { success: false, error: message };
      }
    }
    if (!engine.queue.length) {
      engine.queue = [track];
      engine.queueIndex = -1;
    } else if (playNext) {
      engine.queue.splice(Math.max(0, engine.queueIndex + 1), 0, track);
    } else {
      engine.queue.push(track);
    }
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    return { success: true };
  }, [editRemoteQueue]);

  const loadMusicArtwork = useCallback(async (trackId: string, sourceServerId?: string) => {
    if (engine.track?.id !== trackId) return '';
    const context = engine.companionActive ? engine.companionServerContext : null;
    const serverId = sourceServerId || (!engine.remoteActive && !context ? engine.localPlaybackServerId : '');
    try {
      return await call<[string, object | null, string], string>(
        'get_music_artwork', trackId, context || null, serverId || '');
    } catch {
      return '';
    }
  }, []);

  const setLocalVolume = useCallback((volume: number) => {
    const normalizedVolume = Math.max(0, Math.min(100, Math.round(volume)));
    engine.volumePreferenceLoaded = true;
    setSharedVolume(normalizedVolume);
    window.clearTimeout(engine.volumeSaveTimer);
    engine.volumeSaveTimer = window.setTimeout(() => {
      void call('set_settings', { volume: normalizedVolume }).catch(() => {});
      engine.volumeSaveTimer = undefined;
    }, 250);
  }, []);

  const setVolume = useCallback((volume: number) => {
    if (!state.remoteMode) {
      setLocalVolume(volume);
      return;
    }
    const normalizedVolume = Math.max(0, Math.min(100, Math.round(volume)));
    setState(s => ({ ...s, volume: normalizedVolume }));
    void controlRemotePlayer('volume', normalizedVolume);
  }, [state.remoteMode, controlRemotePlayer, setLocalVolume]);

  const seek = useCallback((time: number) => {
    if (state.remoteMode) {
      void controlRemotePlayer('seek', time * 1000);
      return;
    }
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, [state.remoteMode, controlRemotePlayer]);

  return (
    <PlayerContext.Provider
      value={{
        ...state,
        localVolume,
        volumeSliderRevision,
        playbackPending,
        remoteQueueEditable: state.remoteMode && !!engine.remoteQueueEditable,
        canLoadMoreQueue: !!engine.queueLoader,
        loadMusicArtwork,
        beginPlaybackRequest,
        readMusicPlaybackTarget,
        playTrack,
        playRemoteQueue,
        play,
        pause,
        stop,
        skipNext,
        skipPrevious,
        playQueueIndex,
        removeFromQueue,
        addToQueue,
        setVolume,
        setLocalVolume,
        seek,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextType {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
}
