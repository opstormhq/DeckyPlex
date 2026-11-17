import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  ReactNode,
} from 'react';
import { call } from '@decky/api';

interface TrackInfo {
  id: string;
  sectionId: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  thumb: string;
}

interface PlayerState {
  playbackState: string; // "playing", "paused", "stopped"
  track: TrackInfo | null;
  volume: number;
  error: string | null;
  progress: number; // current position in seconds
  duration: number; // total duration in seconds
  remoteMode: boolean;
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
  remoteActive: false, listenersInitialized: false,
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

function reportTimeline(state: 'playing' | 'paused' | 'stopped', force = false) {
  if (engine.remoteActive || !engine.track?.id) return;
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
  reportTimeline('stopped', true);
  engine.queueIndex = index;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  engine.track = nextTrack;
  window.dispatchEvent(new Event('deckyplex-track-change'));
  logToBackend(`queue: loading track ${index + 1}/${engine.queue.length}: ${nextTrack.title}`);
  try {
    const result: any = await call('play_track', nextTrack.id, nextTrack.sectionId);
    if (requestId !== engine.requestId) return;
    if (!result?.success || !result.stream_url) throw new Error(result?.error || 'Could not load queued track');
    logToBackend(`queue: stream URL for ${nextTrack.id} = ${String(result.stream_url).substring(0, 120)}...`);
    engine.explicitlyStopped = false;
    const started = await playStreamWithFallback(result.stream_url, result.fallback_stream_url || '', nextTrack.title, requestId);
    if (requestId === engine.requestId && !started) throw new Error('Playback request was interrupted');
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
  reportTimeline('stopped', true);
  if (engine.queueIndex + 1 < engine.queue.length) {
    void playQueuedIndex(engine.queueIndex + 1);
  } else if (engine.queueLoader) {
    void loadMoreQueue();
  } else {
    stopSharedPlayback(false);
  }
});
window.setInterval(() => {
  if (!sharedAudio.paused) reportTimeline('playing');
}, 10000);
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
      setState(s => ({ ...s, playbackState: "stopped", error: msg }));
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
      playbackState: s.remoteMode ? s.playbackState : engine.track ? 'paused' : 'stopped',
      error: null,
    }));
    const onQueueChange = () => setState(s => ({ ...s, queue: engine.queue.slice(), queueIndex: engine.queueIndex }));
    const onPlaybackError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; requestId?: number }>).detail;
      if (detail?.requestId != null && detail.requestId !== engine.requestId) return;
      const message = detail?.message || 'Could not load queued track';
      setState(s => ({ ...s, playbackState: 'stopped', error: message }));
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
    window.addEventListener('deckyplex-playback-error', onPlaybackError);
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
      window.removeEventListener('deckyplex-playback-error', onPlaybackError);
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
          remoteMode: settings.playback_target === 'remote' && !!settings.selected_player_id,
          remotePlayerId: settings.selected_player_id || '',
          remotePlayerName: settings.selected_player_name || '',
        }));
        engine.remoteActive = settings.playback_target === 'remote' && !!settings.selected_player_id;
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
