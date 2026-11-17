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
}

interface PlayerState {
  playbackState: string; // "playing", "paused", "stopped"
  track: TrackInfo | null;
  volume: number;
  error: string | null;
  progress: number; // current position in seconds
  duration: number; // total duration in seconds
  remoteMode: boolean;
  companionMode: boolean;
  remotePlayerId: string;
  remotePlayerName: string;
  queue: TrackInfo[];
  queueIndex: number;
}

interface PlayerContextType extends PlayerState {
  playTrack: (streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl?: string, loadMore?: () => Promise<TrackInfo[]>, requestToken?: number) => void;
  beginPlaybackRequest: () => number;
  playRemoteQueue: (queue: TrackInfo[], startId?: string) => Promise<{ success: boolean; error?: string }>;
  play: () => void;
  pause: () => void;
  stop: () => void;
  skipNext: () => void;
  skipPrevious: () => void;
  playQueueIndex: (index: number) => void;
  removeFromQueue: (index: number) => void;
  addToQueue: (track: TrackInfo, playNext?: boolean) => void;
  setVolume: (volume: number) => void;
  seek: (time: number) => void;
}

const PlayerContext = createContext<PlayerContextType | null>(null);

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
  sharedAudio.volume = 0.5;
  engine.audioInitialized = true;
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
  }, 5000);
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
        engine.companionPlayQueueVersion || '', engine.companionServerContext || {});
    }
  }
  if (engine.companionActive || engine.remoteActive || !engine.track?.id) return;
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
  engine.pendingRequestId = 0;
  engine.explicitlyStopped = true;
  if (report) reportTimeline('stopped', true);
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  engine.track = null;
  engine.remoteActive = false;
  engine.queue = [];
  engine.queueIndex = -1;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  engine.queueLoader = null;
  engine.queueLoadInProgress = false;
  window.dispatchEvent(new Event('deckyplex-track-change'));
}

async function playStreamWithFallback(primaryUrl: string, fallbackUrl: string, title: string, requestId: number) {
  const candidates = [primaryUrl, fallbackUrl].filter((url, index, all) => !!url && all.indexOf(url) === index);
  let lastError: Error | null = null;
  try {
    for (let index = 0; index < candidates.length; index++) {
      if (requestId !== engine.requestId) return false;
      engine.pendingRequestId = requestId;
      engine.diagnosedSource = '';
      engine.explicitlyStopped = false;
      sharedAudio.pause();
      sharedAudio.src = candidates[index];
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
    if (engine.pendingRequestId === requestId) engine.pendingRequestId = 0;
  }
}

async function playQueuedIndex(index: number) {
  const nextTrack = engine.queue[index];
  if (!nextTrack) return;
  const requestId = ++engine.requestId;
  engine.pendingRequestId = requestId;
  engine.failedRequestId = 0;
  engine.explicitlyStopped = true;
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  if (!engine.companionActive) reportTimeline('stopped', true);
  engine.queueIndex = index;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  engine.track = nextTrack;
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
      ? await call('play_companion_track', nextTrack.id, engine.companionServerContext || {})
      : await call('play_track', nextTrack.id, nextTrack.sectionId);
    if (requestId !== engine.requestId) return;
    if (!result?.success || !result.stream_url) throw new Error(result?.error || 'Could not load queued track');
    logToBackend(`queue: stream URL for ${nextTrack.id} = ${String(result.stream_url).substring(0, 120)}...`);
    engine.explicitlyStopped = false;
    const started = await playStreamWithFallback(result.stream_url, result.fallback_stream_url || '', nextTrack.title, requestId);
    if (requestId === engine.requestId && !started) throw new Error('Playback request was interrupted');
    if (requestId === engine.requestId && engine.companionActive) reportTimeline('playing', true);
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
    engine.pendingRequestId = 0;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    if (index + 1 < engine.queue.length) {
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
  logToBackend(`audio source rejected for track ${trackId}: code=${mediaError?.code || 0} ${mediaError?.message || ''}; networkState=${sharedAudio.networkState}; readyState=${sharedAudio.readyState}`);
  call('inspect_stream', trackId, source).then((result: any) => {
    logToBackend(`stream diagnostic for ${trackId}: ${JSON.stringify(result)}`);
  }).catch((e: Error) => {
    logToBackend(`stream diagnostic failed for ${trackId}: ${e.message}`);
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
  engine.queueLoadInProgress = true;
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
    engine.queueLoadInProgress = false;
  }
}

async function startCompanionTrack(params: Record<string, string[]>) {
  const requestedKey = params.key?.[0] || '';
  engine.lastCompanionPlayMediaAt = Date.now();
  const previousContext = engine.companionServerContext || {};
  engine.companionServerContext = {
    machine_identifier: params.machineIdentifier?.[0] || previousContext.machine_identifier || '',
    address: params.address?.[0] || previousContext.address || '',
    port: Number(params.port?.[0] || previousContext.port || 32400),
    protocol: params.protocol?.[0] || previousContext.protocol || 'http',
    token: params.token?.[0] || previousContext.token || '',
  };
  if (engine.companionActive && !sharedAudio.paused && engine.track?.key === requestedKey) {
    logToBackend(`Plex Companion repeated current playMedia; keeping ${engine.track.title} active`);
    return;
  }
  const containerKey = params.containerKey?.[0] || engine.companionContainerKey || '';
  const prepared: any = await call('prepare_companion_playback', requestedKey,
    containerKey, engine.companionServerContext.machine_identifier, engine.companionServerContext.token,
    engine.companionServerContext.address, engine.companionServerContext.port, engine.companionServerContext.protocol);
  if (prepared?.server_context) engine.companionServerContext = prepared.server_context;
  if (!prepared?.success || !prepared.track || !prepared.stream_url) {
    const failedKey = requestedKey.match(/\/library\/metadata\/(\d+)/)?.[1] || '';
    logToBackend(`Plex Companion could not prepare incoming track: ${prepared?.error || 'missing stream URL'}`);
    if (failedKey) {
      void call('report_companion_timeline', failedKey, 0, 0, 'stopped', 50, '', '', '', '', engine.companionServerContext || {})
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
    key: item.key || '', playQueueItemID: item.playQueueItemID || '',
  });
  const queue = (prepared.queue || [prepared.track]).map(toTrack).filter((item: TrackInfo) => item.id);
  const selected = toTrack(prepared.track);
  const requestId = ++engine.requestId;
  if (engine.track && !engine.remoteActive && !engine.companionActive) reportTimeline('stopped', true);
  engine.companionActive = true;
  engine.companionServerContext = prepared.server_context || engine.companionServerContext;
  engine.companionPlayQueueId = prepared.play_queue_id || '';
  engine.companionContainerKey = prepared.container_key || '';
  engine.companionPlayQueueVersion = prepared.play_queue_version || '';
  engine.remoteActive = false;
  engine.pendingRequestId = requestId;
  engine.failedRequestId = 0;
  engine.explicitlyStopped = true;
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  engine.track = selected;
  engine.queue = queue.length ? queue : [selected];
  engine.queueIndex = Math.max(0, engine.queue.findIndex((item: TrackInfo) => item.id === selected.id));
  engine.queueLoader = null;
  engine.queueLoadInProgress = false;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  window.dispatchEvent(new Event('deckyplex-track-change'));
  logToBackend(`Plex Companion starting ${selected.title} (${engine.queue.length} queued track(s))`);
  logToBackend(`Plex Companion selected queue item ${engine.queueIndex + 1}/${engine.queue.length} for key ${requestedKey}`);
  try {
    const started = await playStreamWithFallback(prepared.stream_url, prepared.fallback_stream_url || '', selected.title, requestId);
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
  const commandId = params.commandID?.[0];
  if (commandId && commandId !== '0') {
    const source = entry.client_id || entry.client_host || 'unknown';
    const commandKey = `${source}:${commandId}`;
    const handled: string[] = engine.handledCompanionCommands || (engine.handledCompanionCommands = []);
    if (handled.includes(commandKey)) return;
    handled.push(commandKey);
    if (handled.length > 64) handled.splice(0, handled.length - 64);
  }
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
        sharedAudio.volume = Math.max(0, Math.min(100, Number(volume) || 0)) / 100;
        window.dispatchEvent(new CustomEvent('deckyplex-volume-change', { detail: Math.round(sharedAudio.volume * 100) }));
      }
      break;
    }
  }
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
  const volumeSaveTimer = useRef<number | null>(null);
  const volumePreferenceLoaded = useRef(false);
  const [state, setState] = useState<PlayerState>({
    playbackState: "stopped",
    track: engine.track,
    volume: 50,
    error: null,
    progress: 0,
    duration: 0,
    remoteMode: false,
    companionMode: !!engine.companionActive,
    remotePlayerId: '',
    remotePlayerName: '',
    queue: engine.queue.slice(),
    queueIndex: engine.queueIndex,
  });

  const beginPlaybackRequest = useCallback(() => {
    const requestId = ++engine.requestId;
    engine.pendingRequestId = 0;
    engine.explicitlyStopped = true;
    if (engine.track && !engine.remoteActive) reportTimeline('stopped', true);
    engine.companionActive = false;
    engine.companionServerContext = null;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    engine.track = null;
    engine.remoteActive = false;
    engine.queue = [];
    engine.queueIndex = -1;
    engine.queueLoader = null;
    engine.queueLoadInProgress = false;
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
    const onTrackChange = () => setState(s => ({
      ...s,
      track: engine.track,
      progress: 0,
      duration: engine.track ? (engine.track.duration || 0) / 1000 : 0,
      remoteMode: engine.companionActive ? false : s.remoteMode,
      companionMode: !!engine.companionActive,
      playbackState: engine.companionActive ? (sharedAudio.paused ? 'paused' : 'playing') : s.remoteMode ? s.playbackState : engine.track ? 'paused' : 'stopped',
      error: null,
    }));
    const onQueueChange = () => setState(s => ({ ...s, queue: engine.queue.slice(), queueIndex: engine.queueIndex }));
    const onCompanionStop = () => setState(s => ({ ...s, companionMode: false }));
    const onVolumeChange = (event: Event) => {
      const volume = Number((event as CustomEvent<number>).detail);
      if (Number.isFinite(volume)) setState(s => ({ ...s, volume }));
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
    const refreshTarget = async () => {
      try {
        const settings: any = await call('get_settings');
        if (!mounted) return;
        if (!volumePreferenceLoaded.current) {
          const savedVolume = Number(settings.volume);
          if (Number.isFinite(savedVolume)) {
            const normalizedVolume = Math.max(0, Math.min(100, savedVolume));
            sharedAudio.volume = normalizedVolume / 100;
            setState(s => ({ ...s, volume: normalizedVolume }));
          }
          volumePreferenceLoaded.current = true;
        }
        setState(s => ({
          ...s,
          remoteMode: !engine.companionActive && settings.playback_target === 'remote' && !!settings.selected_player_id,
          remotePlayerId: settings.selected_player_id || '',
          remotePlayerName: settings.selected_player_name || '',
        }));
        engine.remoteActive = !engine.companionActive && settings.playback_target === 'remote' && !!settings.selected_player_id;
      } catch {}
    };
    refreshTarget();
    const interval = window.setInterval(refreshTarget, 5000);
    window.addEventListener('deckyplex-settings-change', refreshTarget);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('deckyplex-settings-change', refreshTarget);
    };
  }, []);

  useEffect(() => {
    if (!state.remoteMode || !state.remotePlayerId) return;
    let active = true;
    let loading = false;
    const refreshRemoteStatus = async () => {
      if (loading) return;
      loading = true;
      try {
        const result: any = await call('get_remote_player_status', state.remotePlayerId);
        if (!active || result?.error) return;
        const remoteTrack = result.track ? {
          id: result.track.id || '', sectionId: '', title: result.track.title || '',
          artist: result.track.artist || '', album: result.track.album || '',
          duration: result.track.duration || 0, thumb: result.track.thumb || '',
        } : null;
        setState(s => ({
          ...s,
          track: remoteTrack,
          playbackState: result.state === 'playing' ? 'playing' : result.state === 'paused' ? 'paused' : 'stopped',
          progress: Number(result.progress) || 0,
          duration: Number(result.duration) || (remoteTrack?.duration || 0) / 1000,
          volume: Number.isFinite(result.volume) ? result.volume : s.volume,
          error: null,
        }));
      } catch (e: any) {
        if (active) setState(s => ({ ...s, error: e?.message || 'Remote player connection failed.' }));
      } finally {
        loading = false;
      }
    };
    refreshRemoteStatus();
    const interval = window.setInterval(refreshRemoteStatus, 2500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [state.remoteMode, state.remotePlayerId]);

  const playRemoteQueue = useCallback(async (queue: TrackInfo[], startId?: string) => {
    if (!state.remotePlayerId) return { success: false, error: 'Select a remote player in Settings first.' };
    const playable = queue.filter(track => track.id);
    if (!playable.length) return { success: false, error: 'No tracks found to play.' };
    const selected = playable.find(track => track.id === startId) || playable[0];
    const requestId = ++engine.requestId;
    engine.pendingRequestId = 0;
    engine.explicitlyStopped = true;
    if (engine.track && !engine.remoteActive) reportTimeline('stopped', true);
    engine.remoteActive = true;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    try {
      const result: any = await call('play_remote_queue', state.remotePlayerId,
        playable.map(track => track.id), selected.id);
      if (requestId !== engine.requestId) return { success: false, error: 'Playback request was replaced.' };
      if (!result?.success) return { success: false, error: result?.error || 'Could not start playback on the selected Plex player.' };
      engine.track = selected;
      engine.queue = playable;
      engine.queueIndex = playable.findIndex(track => track.id === selected.id);
      window.dispatchEvent(new Event('deckyplex-queue-change'));
      window.dispatchEvent(new Event('deckyplex-track-change'));
      setState(s => ({ ...s, track: selected, error: null, playbackState: 'playing', progress: 0,
        duration: (selected.duration || 0) / 1000 }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e?.message || 'Could not start remote playback.' };
    }
  }, [state.remotePlayerId]);

  const controlRemotePlayer = useCallback(async (command: string, value = 0) => {
    if (!state.remotePlayerId) return false;
    try {
      const result: any = await call('control_remote_player', state.remotePlayerId, command, Math.round(value));
      if (!result?.success) throw new Error(result?.error || `Could not ${command} remote player.`);
      setState(s => ({ ...s, error: null }));
      return true;
    } catch (e: any) {
      setState(s => ({ ...s, error: e?.message || 'Remote player command failed.' }));
      return false;
    }
  }, [state.remotePlayerId]);

  const playTrack = useCallback((streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl = '', loadMore?: () => Promise<TrackInfo[]>, requestToken?: number) => {
    const audio = audioRef.current;
    if (!audio) {
      logToBackend(`playTrack: audio element not initialized`);
      return;
    }
    const wasRemotePlayback = engine.remoteActive;
    if (requestToken != null && requestToken !== engine.requestId) return;
    const requestId = requestToken ?? ++engine.requestId;
    engine.failedRequestId = 0;
    engine.pendingRequestId = requestId;

    logToBackend(`playTrack: URL = ${streamUrl.substring(0, 120)}...`);
    engine.explicitlyStopped = false;
    if (engine.track && engine.track.id !== trackInfo.id && !wasRemotePlayback) reportTimeline('stopped', true);
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
    engine.queueLoadInProgress = false;
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    logToBackend(`queue: set ${engine.queue.length} track(s), starting at ${engine.queueIndex + 1}`);
    window.dispatchEvent(new Event('deckyplex-track-change'));
    setState(s => ({ ...s, error: null, playbackState: "paused", track: trackInfo, progress: 0, duration: (trackInfo.duration || 0) / 1000 }));

    // Prefer the direct Plex media part for MP3/FLAC, then try Plex's MP3 transcode.
    logToBackend(`playTrack: using native audio playback`);
    playStreamWithFallback(streamUrl, fallbackStreamUrl, trackInfo.title, requestId).then((started) => {
      if (!started || requestId !== engine.requestId) return;
      engine.failedRequestId = 0;
      logToBackend(`playTrack: playback started successfully`);
      setState(s => ({ ...s, playbackState: "playing" }));
    }).catch((e: Error) => {
      if (requestId !== engine.requestId) return;
      const errDetail = audio.error
        ? `play() failed: ${e.name} ${e.message}, audio.error.code=${audio.error.code} ${audio.error.message}`
        : `play() failed: ${e.name} ${e.message}`;
      logToBackend(errDetail);
      engine.explicitlyStopped = true;
      engine.failedRequestId = requestId;
      engine.pendingRequestId = 0;
      sharedAudio.pause();
      sharedAudio.removeAttribute('src');
      sharedAudio.load();
      const nextIndex = engine.queueIndex + 1;
      if (nextIndex < engine.queue.length) {
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
    if (audioRef.current) {
      engine.explicitlyStopped = false;
      audioRef.current.play().catch((e: Error) => {
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
      engine.pendingRequestId = 0;
      reportTimeline('paused', true);
      audioRef.current.pause();
    }
  }, [state.remoteMode, controlRemotePlayer]);

  const stop = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('stop').then(stopped => {
        if (!stopped) return;
        engine.track = null;
        engine.queue = [];
        engine.queueIndex = -1;
        window.dispatchEvent(new Event('deckyplex-track-change'));
        setState(s => ({ ...s, playbackState: 'stopped', track: null, progress: 0, duration: 0 }));
      });
      return;
    }
    stopSharedPlayback(true);
    engine.companionActive = false;
    engine.companionServerContext = null;
    window.dispatchEvent(new Event('deckyplex-companion-stop'));
    setState(s => ({ ...s, playbackState: "stopped", track: null, progress: 0, duration: 0 }));
  }, [state.remoteMode, controlRemotePlayer]);

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

  const removeFromQueue = useCallback((index: number) => {
    if (state.remoteMode || index < 0 || index >= engine.queue.length) return;
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
  }, [state.remoteMode]);

  const addToQueue = useCallback((track: TrackInfo, playNext = false) => {
    if (!track.id) return;
    if (!engine.queue.length) {
      engine.queue = [track];
      engine.queueIndex = -1;
    } else if (playNext) {
      engine.queue.splice(Math.max(0, engine.queueIndex + 1), 0, track);
    } else {
      engine.queue.push(track);
    }
    window.dispatchEvent(new Event('deckyplex-queue-change'));
  }, []);

  const setVolume = useCallback((volume: number) => {
    const normalizedVolume = Math.max(0, Math.min(100, Math.round(volume)));
    setState(s => ({ ...s, volume: normalizedVolume }));
    if (state.remoteMode) {
      void controlRemotePlayer('volume', normalizedVolume);
      return;
    }
    if (audioRef.current) {
      audioRef.current.volume = normalizedVolume / 100;
    }
    if (volumeSaveTimer.current !== null) window.clearTimeout(volumeSaveTimer.current);
    volumeSaveTimer.current = window.setTimeout(() => {
      void call('set_settings', { volume: normalizedVolume }).catch(() => {});
      volumeSaveTimer.current = null;
    }, 250);
  }, [state.remoteMode, controlRemotePlayer]);

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
        beginPlaybackRequest,
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
