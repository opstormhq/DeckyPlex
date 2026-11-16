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
  playTrack: (streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl?: string, loadMore?: () => Promise<TrackInfo[]>) => void;
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

// The Decky sidebar and routed browser mount separate React trees. Keep one
// audio element at module scope so playback and controls are shared by both.
const sharedAudio = new Audio();
sharedAudio.volume = 0.5;
let sharedTrack: TrackInfo | null = null;
let sharedQueue: TrackInfo[] = [];
let sharedQueueIndex = -1;
let sharedQueueLoader: (() => Promise<TrackInfo[]>) | null = null;
let queueLoadInProgress = false;
let playbackRequestId = 0;
let pendingStreamRequestId = 0;
let failedPlaybackRequestId = 0;
let lastTimelineReportAt = 0;
let lastTimelineReportKey = '';
let explicitlyStopped = false;
let lastDiagnosedSource = '';
let remotePlaybackActive = false;

// Send a debug message from the browser to the backend log file
function logToBackend(message: string) {
  call("log_message", message).catch(() => {});
}

function reportTimeline(state: 'playing' | 'paused' | 'stopped', force = false) {
  if (remotePlaybackActive || !sharedTrack?.id) return;
  const now = Date.now();
  const reportKey = `${sharedTrack.id}:${state}`;
  if (reportKey === lastTimelineReportKey && now - lastTimelineReportAt < (state === 'playing' ? 9000 : 750)) return;
  if (!force && state === 'playing' && now - lastTimelineReportAt < 9000 && lastTimelineReportKey.startsWith(`${sharedTrack.id}:`)) return;
  lastTimelineReportAt = now;
  lastTimelineReportKey = reportKey;
  const duration = Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
    ? sharedAudio.duration
    : (sharedTrack.duration || 0) / 1000;
  call('report_playback', sharedTrack.id, Math.round((sharedAudio.currentTime || 0) * 1000), state,
    Math.round(duration * 1000)).catch(() => {});
}

function stopSharedPlayback(report = true) {
  playbackRequestId++;
  pendingStreamRequestId = 0;
  explicitlyStopped = true;
  if (report) reportTimeline('stopped', true);
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  sharedTrack = null;
  remotePlaybackActive = false;
  sharedQueue = [];
  sharedQueueIndex = -1;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  sharedQueueLoader = null;
  queueLoadInProgress = false;
  window.dispatchEvent(new Event('deckyplex-track-change'));
}

async function playStreamWithFallback(primaryUrl: string, fallbackUrl: string, title: string, requestId: number) {
  const candidates = [primaryUrl, fallbackUrl].filter((url, index, all) => !!url && all.indexOf(url) === index);
  let lastError: Error | null = null;
  try {
    for (let index = 0; index < candidates.length; index++) {
      if (requestId !== playbackRequestId) return false;
      pendingStreamRequestId = requestId;
      lastDiagnosedSource = '';
      explicitlyStopped = false;
      sharedAudio.pause();
      sharedAudio.src = candidates[index];
      sharedAudio.load();
      try {
        await sharedAudio.play();
        if (requestId !== playbackRequestId) return false;
        if (index > 0) logToBackend(`playback fallback succeeded for ${title}`);
        return true;
      } catch (e: any) {
        if (requestId !== playbackRequestId || e?.name === 'AbortError') return false;
        lastError = e instanceof Error ? e : new Error(String(e));
        if (index + 1 < candidates.length) logToBackend(`playback primary failed for ${title}; trying alternate Plex stream`);
      }
    }
    throw lastError || new Error('No playable stream URL was returned');
  } finally {
    if (pendingStreamRequestId === requestId) pendingStreamRequestId = 0;
  }
}

async function playQueuedIndex(index: number) {
  const nextTrack = sharedQueue[index];
  if (!nextTrack) return;
  const requestId = ++playbackRequestId;
  pendingStreamRequestId = requestId;
  failedPlaybackRequestId = 0;
  explicitlyStopped = true;
  sharedAudio.pause();
  sharedAudio.removeAttribute('src');
  sharedAudio.load();
  reportTimeline('stopped', true);
  sharedQueueIndex = index;
  window.dispatchEvent(new Event('deckyplex-queue-change'));
  sharedTrack = nextTrack;
  window.dispatchEvent(new Event('deckyplex-track-change'));
  logToBackend(`queue: loading track ${index + 1}/${sharedQueue.length}: ${nextTrack.title}`);
  try {
    const result: any = await call('play_track', nextTrack.id, nextTrack.sectionId);
    if (requestId !== playbackRequestId) return;
    if (!result?.success || !result.stream_url) throw new Error(result?.error || 'Could not load queued track');
    logToBackend(`queue: stream URL for ${nextTrack.id} = ${String(result.stream_url).substring(0, 120)}...`);
    explicitlyStopped = false;
    const started = await playStreamWithFallback(result.stream_url, result.fallback_stream_url || '', nextTrack.title, requestId);
    if (requestId === playbackRequestId && !started) throw new Error('Playback request was interrupted');
  } catch (e: any) {
    if (requestId !== playbackRequestId) return;
    const mediaError = sharedAudio.error;
    const detail = `${e?.name || 'Error'} ${e?.message || 'Could not load queued track'}`;
    const message = mediaError
      ? `${detail}; media error code=${mediaError.code} ${mediaError.message || ''}`
      : detail;
    logToBackend(`queue: failed to load track ${nextTrack.title}: ${message}`);
    explicitlyStopped = true;
    failedPlaybackRequestId = requestId;
    pendingStreamRequestId = 0;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    window.dispatchEvent(new CustomEvent('deckyplex-playback-error', { detail: { message, requestId } }));
  }
}

// Keep queue progression attached to the shared media element, so it continues
// even when Decky unmounts the browser and sidebar React trees.
sharedAudio.addEventListener('play', () => reportTimeline('playing'));
sharedAudio.addEventListener('error', () => {
  if (remotePlaybackActive) return;
  const source = sharedAudio.currentSrc || sharedAudio.src;
  if (!source || !sharedAudio.src || source !== sharedAudio.src) return;
  const trackId = sharedTrack?.id;
  if (!trackId || !source || source === lastDiagnosedSource) return;
  lastDiagnosedSource = source;
  const mediaError = sharedAudio.error;
  logToBackend(`audio source rejected for track ${trackId}: code=${mediaError?.code || 0} ${mediaError?.message || ''}; networkState=${sharedAudio.networkState}; readyState=${sharedAudio.readyState}`);
  call('inspect_stream', trackId, source).then((result: any) => {
    logToBackend(`stream diagnostic for ${trackId}: ${JSON.stringify(result)}`);
  }).catch((e: Error) => {
    logToBackend(`stream diagnostic failed for ${trackId}: ${e.message}`);
  });
});
sharedAudio.addEventListener('ended', () => {
  if (explicitlyStopped || sharedAudio.error || !sharedTrack) return;
  logToBackend(`queue: track ended at ${sharedQueueIndex + 1}/${sharedQueue.length}`);
  reportTimeline('stopped', true);
  if (sharedQueueIndex + 1 < sharedQueue.length) {
    void playQueuedIndex(sharedQueueIndex + 1);
  } else if (sharedQueueLoader) {
    void loadMoreQueue();
  } else {
    stopSharedPlayback(false);
  }
});

async function loadMoreQueue() {
  if (!sharedQueueLoader || queueLoadInProgress) return;
  queueLoadInProgress = true;
  const requestId = playbackRequestId;
  try {
    const tracks = await sharedQueueLoader();
    if (requestId !== playbackRequestId || !tracks.length) {
      if (requestId === playbackRequestId && !tracks.length) stopSharedPlayback(false);
      return;
    }
    const start = sharedQueue.length;
    sharedQueue.push(...tracks);
    await playQueuedIndex(start);
  } catch (e: any) {
    logToBackend(`queue: could not load next shuffle page: ${e?.message || e}`);
    stopSharedPlayback(false);
  } finally {
    queueLoadInProgress = false;
  }
}
window.setInterval(() => {
  if (!sharedAudio.paused) reportTimeline('playing');
}, 10000);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PlayerState>({
    playbackState: "stopped",
    track: sharedTrack,
    volume: 50,
    error: null,
    progress: 0,
    duration: 0,
    remoteMode: false,
    remotePlayerId: '',
    remotePlayerName: '',
    queue: sharedQueue.slice(),
    queueIndex: sharedQueueIndex,
  });

  // Initialize audio element once
  useEffect(() => {
    audioRef.current = sharedAudio;

    const onPlay = () => {
      if (remotePlaybackActive) return;
      reportTimeline('playing');
      setState(s => ({ ...s, playbackState: "playing", error: null }));
    };
    const onPause = () => {
      if (sharedAudio.paused && !explicitlyStopped && !remotePlaybackActive) {
        setState(s => ({ ...s, playbackState: "paused" }));
      }
    };
    const onEnded = () => {
      if (!remotePlaybackActive) setState(s => ({ ...s, playbackState: "stopped", progress: 0 }));
    };
    const onError = (e: Event) => {
      const audio = e.target as HTMLAudioElement;
      const mediaError = audio.error;
      const msg = mediaError ? mediaError.message : "Playback error";
      if (explicitlyStopped || remotePlaybackActive) return;
      if (pendingStreamRequestId === playbackRequestId || failedPlaybackRequestId === playbackRequestId) return;
      logToBackend(`audio error: code=${mediaError?.code} ${msg}`);
      explicitlyStopped = true;
      reportTimeline('stopped', true);
      setState(s => ({ ...s, playbackState: "stopped", error: msg }));
    };
    const onTimeUpdate = () => setState(s => s.remoteMode ? s : ({
        ...s,
        progress: Number.isFinite(sharedAudio.currentTime) ? sharedAudio.currentTime : 0,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (sharedTrack?.duration || 0) / 1000,
      }));
    const onLoadedMetadata = () => setState(s => s.remoteMode ? s : ({
        ...s,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (sharedTrack?.duration || 0) / 1000,
      }));
    const onDurationChange = () => setState(s => s.remoteMode ? s : ({
        ...s,
        duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
          ? sharedAudio.duration
          : (sharedTrack?.duration || 0) / 1000,
      }));
    const onTrackChange = () => setState(s => ({
      ...s,
      track: sharedTrack,
      progress: 0,
      duration: sharedTrack ? (sharedTrack.duration || 0) / 1000 : 0,
      playbackState: s.remoteMode ? s.playbackState : sharedTrack ? 'paused' : 'stopped',
      error: null,
    }));
    const onQueueChange = () => setState(s => ({ ...s, queue: sharedQueue.slice(), queueIndex: sharedQueueIndex }));
    const onPlaybackError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; requestId?: number }>).detail;
      if (detail?.requestId != null && detail.requestId !== playbackRequestId) return;
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
      track: sharedTrack,
      playbackState: sharedTrack ? (sharedAudio.paused ? "paused" : "playing") : "stopped",
      progress: Number.isFinite(sharedAudio.currentTime) ? sharedAudio.currentTime : 0,
      duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
        ? sharedAudio.duration
        : (sharedTrack?.duration || 0) / 1000,
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
        setState(s => ({
          ...s,
          remoteMode: settings.playback_target === 'remote' && !!settings.selected_player_id,
          remotePlayerId: settings.selected_player_id || '',
          remotePlayerName: settings.selected_player_name || '',
        }));
        remotePlaybackActive = settings.playback_target === 'remote' && !!settings.selected_player_id;
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
    const requestId = ++playbackRequestId;
    pendingStreamRequestId = 0;
    explicitlyStopped = true;
    if (sharedTrack && !remotePlaybackActive) reportTimeline('stopped', true);
    remotePlaybackActive = true;
    sharedAudio.pause();
    sharedAudio.removeAttribute('src');
    sharedAudio.load();
    try {
      const result: any = await call('play_remote_queue', state.remotePlayerId,
        playable.map(track => track.id), selected.id);
      if (requestId !== playbackRequestId) return { success: false, error: 'Playback request was replaced.' };
      if (!result?.success) return { success: false, error: result?.error || 'Could not start playback on the selected Plex player.' };
      sharedTrack = selected;
      sharedQueue = playable;
      sharedQueueIndex = playable.findIndex(track => track.id === selected.id);
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

  const playTrack = useCallback((streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl = '', loadMore?: () => Promise<TrackInfo[]>) => {
    const audio = audioRef.current;
    if (!audio) {
      logToBackend(`playTrack: audio element not initialized`);
      return;
    }
    const wasRemotePlayback = remotePlaybackActive;
    const requestId = ++playbackRequestId;
    failedPlaybackRequestId = 0;
    pendingStreamRequestId = requestId;

    logToBackend(`playTrack: URL = ${streamUrl.substring(0, 120)}...`);
    explicitlyStopped = false;
    if (sharedTrack && sharedTrack.id !== trackInfo.id && !wasRemotePlayback) reportTimeline('stopped', true);
    remotePlaybackActive = false;
    sharedTrack = trackInfo;
    if (queue?.length) {
      sharedQueue = queue;
      sharedQueueIndex = Math.max(0, sharedQueue.findIndex(item => item.id === trackInfo.id));
    } else if (!sharedQueue.some(item => item.id === trackInfo.id)) {
      sharedQueue = [trackInfo];
      sharedQueueIndex = 0;
    }
    sharedQueueLoader = loadMore || null;
    queueLoadInProgress = false;
    window.dispatchEvent(new Event('deckyplex-queue-change'));
    logToBackend(`queue: set ${sharedQueue.length} track(s), starting at ${sharedQueueIndex + 1}`);
    window.dispatchEvent(new Event('deckyplex-track-change'));
    setState(s => ({ ...s, error: null, playbackState: "paused", track: trackInfo, progress: 0, duration: (trackInfo.duration || 0) / 1000 }));

    // Prefer the direct Plex media part for MP3/FLAC, then try Plex's MP3 transcode.
    logToBackend(`playTrack: using native audio playback`);
    playStreamWithFallback(streamUrl, fallbackStreamUrl, trackInfo.title, requestId).then((started) => {
      if (!started || requestId !== playbackRequestId) return;
      failedPlaybackRequestId = 0;
      logToBackend(`playTrack: playback started successfully`);
      setState(s => ({ ...s, playbackState: "playing" }));
    }).catch((e: Error) => {
      if (requestId !== playbackRequestId) return;
      const errDetail = audio.error
        ? `play() failed: ${e.name} ${e.message}, audio.error.code=${audio.error.code} ${audio.error.message}`
        : `play() failed: ${e.name} ${e.message}`;
      logToBackend(errDetail);
      explicitlyStopped = true;
      failedPlaybackRequestId = requestId;
      pendingStreamRequestId = 0;
      sharedAudio.pause();
      sharedAudio.removeAttribute('src');
      sharedAudio.load();
      setState(s => ({ ...s, error: e.message || "Failed to play", playbackState: "stopped" }));
    });
  }, []);

  const play = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('play');
      return;
    }
    if (audioRef.current) {
      explicitlyStopped = false;
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
      playbackRequestId++;
      pendingStreamRequestId = 0;
      reportTimeline('paused', true);
      audioRef.current.pause();
    }
  }, [state.remoteMode, controlRemotePlayer]);

  const stop = useCallback(() => {
    if (state.remoteMode) {
      void controlRemotePlayer('stop').then(stopped => {
        if (!stopped) return;
        sharedTrack = null;
        sharedQueue = [];
        sharedQueueIndex = -1;
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
    const nextIndex = sharedQueueIndex + 1;
    if (nextIndex < sharedQueue.length) void playQueuedIndex(nextIndex);
    else if (sharedQueueLoader) void loadMoreQueue();
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
    if (sharedQueueIndex > 0) void playQueuedIndex(sharedQueueIndex - 1);
  }, [state.remoteMode, controlRemotePlayer]);

  const playQueueIndex = useCallback((index: number) => {
    if (state.remoteMode) return;
    if (index >= 0 && index < sharedQueue.length) void playQueuedIndex(index);
  }, [state.remoteMode]);

  const addToQueue = useCallback((track: TrackInfo, playNext = false) => {
    if (!track.id) return;
    if (!sharedQueue.length) {
      sharedQueue = [track];
      sharedQueueIndex = -1;
    } else if (playNext) {
      sharedQueue.splice(Math.max(0, sharedQueueIndex + 1), 0, track);
    } else {
      sharedQueue.push(track);
    }
    window.dispatchEvent(new Event('deckyplex-queue-change'));
  }, []);

  const setVolume = useCallback((volume: number) => {
    setState(s => ({ ...s, volume }));
    if (state.remoteMode) {
      void controlRemotePlayer('volume', volume);
      return;
    }
    if (audioRef.current) {
      audioRef.current.volume = volume / 100;
    }
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
