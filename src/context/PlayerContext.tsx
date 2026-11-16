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
}

interface PlayerContextType extends PlayerState {
  playTrack: (streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl?: string) => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  skipNext: () => void;
  skipPrevious: () => void;
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
let queueAdvanceInProgress = false;
let playbackRequestId = 0;
let pendingStreamRequestId = 0;
let lastTimelineReportAt = 0;
let lastTimelineReportKey = '';
let explicitlyStopped = false;
let lastDiagnosedSource = '';

// Send a debug message from the browser to the backend log file
function logToBackend(message: string) {
  call("log_message", message).catch(() => {});
}

function reportTimeline(state: 'playing' | 'paused' | 'stopped', force = false) {
  if (!sharedTrack?.id) return;
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
  sharedQueue = [];
  sharedQueueIndex = -1;
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
  if (!nextTrack || queueAdvanceInProgress) return;
  queueAdvanceInProgress = true;
  const requestId = ++playbackRequestId;
  logToBackend(`queue: loading track ${index + 1}/${sharedQueue.length}: ${nextTrack.title}`);
  try {
    const result: any = await call('play_track', nextTrack.id, nextTrack.sectionId);
    if (requestId !== playbackRequestId) return;
    if (!result?.success || !result.stream_url) throw new Error(result?.error || 'Could not load queued track');
    logToBackend(`queue: stream URL for ${nextTrack.id} = ${String(result.stream_url).substring(0, 120)}...`);
    reportTimeline('stopped', true);
    sharedQueueIndex = index;
    sharedTrack = nextTrack;
    explicitlyStopped = false;
    window.dispatchEvent(new Event('deckyplex-track-change'));
    await playStreamWithFallback(result.stream_url, result.fallback_stream_url || '', nextTrack.title, requestId);
  } catch (e: any) {
    if (requestId !== playbackRequestId) return;
    const mediaError = sharedAudio.error;
    const detail = `${e?.name || 'Error'} ${e?.message || 'Could not load queued track'}`;
    const message = mediaError
      ? `${detail}; media error code=${mediaError.code} ${mediaError.message || ''}`
      : detail;
    logToBackend(`queue: failed to load track ${nextTrack.title}: ${message}`);
    window.dispatchEvent(new CustomEvent('deckyplex-playback-error', { detail: message }));
  } finally {
    queueAdvanceInProgress = false;
  }
}

// Keep queue progression attached to the shared media element, so it continues
// even when Decky unmounts the browser and sidebar React trees.
sharedAudio.addEventListener('play', () => reportTimeline('playing'));
sharedAudio.addEventListener('error', () => {
  const source = sharedAudio.currentSrc || sharedAudio.src;
  if (sharedAudio.src && source !== sharedAudio.src) return;
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
  logToBackend(`queue: track ended at ${sharedQueueIndex + 1}/${sharedQueue.length}`);
  reportTimeline('stopped', true);
  if (sharedQueueIndex + 1 < sharedQueue.length) {
    void playQueuedIndex(sharedQueueIndex + 1);
  } else {
    stopSharedPlayback(false);
  }
});
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
  });

  // Initialize audio element once
  useEffect(() => {
    audioRef.current = sharedAudio;

    const onPlay = () => {
      reportTimeline('playing');
      setState(s => ({ ...s, playbackState: "playing", error: null }));
    };
    const onPause = () => {
      if (sharedAudio.paused && !explicitlyStopped) {
        setState(s => ({ ...s, playbackState: "paused" }));
      }
    };
    const onEnded = () => setState(s => ({ ...s, playbackState: "stopped", progress: 0 }));
    const onError = (e: Event) => {
      const audio = e.target as HTMLAudioElement;
      const mediaError = audio.error;
      const msg = mediaError ? mediaError.message : "Playback error";
      if (explicitlyStopped) return;
      logToBackend(`audio error: code=${mediaError?.code} ${msg}`);
      if (pendingStreamRequestId === playbackRequestId) return;
      explicitlyStopped = true;
      reportTimeline('stopped', true);
      setState(s => ({ ...s, playbackState: "stopped", error: msg }));
    };
    const onTimeUpdate = () => setState(s => ({
      ...s,
      progress: Number.isFinite(sharedAudio.currentTime) ? sharedAudio.currentTime : 0,
      duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
        ? sharedAudio.duration
        : (sharedTrack?.duration || 0) / 1000,
    }));
    const onLoadedMetadata = () => setState(s => ({
      ...s,
      duration: Number.isFinite(sharedAudio.duration) && sharedAudio.duration > 0
        ? sharedAudio.duration
        : (sharedTrack?.duration || 0) / 1000,
    }));
    const onDurationChange = () => setState(s => ({
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
      playbackState: sharedTrack ? 'paused' : 'stopped',
      error: null,
    }));
    const onPlaybackError = (event: Event) => {
      const message = (event as CustomEvent<string>).detail || 'Could not load queued track';
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
      window.removeEventListener('deckyplex-playback-error', onPlaybackError);
    };
  }, []);

  const playTrack = useCallback((streamUrl: string, trackInfo: TrackInfo, queue?: TrackInfo[], fallbackStreamUrl = '') => {
    const audio = audioRef.current;
    if (!audio) {
      logToBackend(`playTrack: audio element not initialized`);
      return;
    }
    const requestId = ++playbackRequestId;

    logToBackend(`playTrack: URL = ${streamUrl.substring(0, 120)}...`);
    explicitlyStopped = false;
    if (sharedTrack && sharedTrack.id !== trackInfo.id) reportTimeline('stopped', true);
    sharedTrack = trackInfo;
    if (queue?.length) {
      sharedQueue = queue;
      sharedQueueIndex = Math.max(0, sharedQueue.findIndex(item => item.id === trackInfo.id));
    } else if (!sharedQueue.some(item => item.id === trackInfo.id)) {
      sharedQueue = [trackInfo];
      sharedQueueIndex = 0;
    }
    logToBackend(`queue: set ${sharedQueue.length} track(s), starting at ${sharedQueueIndex + 1}`);
    window.dispatchEvent(new Event('deckyplex-track-change'));
    setState(s => ({ ...s, error: null, playbackState: "paused", track: trackInfo, progress: 0, duration: (trackInfo.duration || 0) / 1000 }));

    // Prefer the direct Plex media part for MP3/FLAC, then try Plex's MP3 transcode.
    logToBackend(`playTrack: using native audio playback`);
    playStreamWithFallback(streamUrl, fallbackStreamUrl, trackInfo.title, requestId).then((started) => {
      if (!started || requestId !== playbackRequestId) return;
      logToBackend(`playTrack: playback started successfully`);
      setState(s => ({ ...s, playbackState: "playing" }));
    }).catch((e: Error) => {
      if (requestId !== playbackRequestId) return;
      const errDetail = audio.error
        ? `play() failed: ${e.name} ${e.message}, audio.error.code=${audio.error.code} ${audio.error.message}`
        : `play() failed: ${e.name} ${e.message}`;
      logToBackend(errDetail);
      setState(s => ({ ...s, error: e.message || "Failed to play", playbackState: "stopped" }));
    });
  }, []);

  const play = useCallback(() => {
    if (audioRef.current) {
      explicitlyStopped = false;
      audioRef.current.play().catch((e: Error) => {
        setState(s => ({ ...s, error: e.message || "Failed to play" }));
      });
    }
  }, []);

  const pause = useCallback(() => {
    if (audioRef.current) {
      playbackRequestId++;
      pendingStreamRequestId = 0;
      reportTimeline('paused', true);
      audioRef.current.pause();
    }
  }, []);

  const stop = useCallback(() => {
    stopSharedPlayback(true);
    setState(s => ({ ...s, playbackState: "stopped", track: null, progress: 0, duration: 0 }));
  }, []);

  const skipNext = useCallback(() => {
    if (sharedQueueIndex + 1 < sharedQueue.length) void playQueuedIndex(sharedQueueIndex + 1);
  }, []);

  const skipPrevious = useCallback(() => {
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0;
      return;
    }
    if (sharedQueueIndex > 0) void playQueuedIndex(sharedQueueIndex - 1);
  }, []);

  const setVolume = useCallback((volume: number) => {
    setState(s => ({ ...s, volume }));
    if (audioRef.current) {
      audioRef.current.volume = volume / 100;
    }
  }, []);

  const seek = useCallback((time: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, []);

  return (
    <PlayerContext.Provider
      value={{
        ...state,
        playTrack,
        play,
        pause,
        stop,
        skipNext,
        skipPrevious,
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
