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
  playTrack: (streamUrl: string, trackInfo: TrackInfo) => void;
  play: () => void;
  pause: () => void;
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

// Send a debug message from the browser to the backend log file
function logToBackend(message: string) {
  call("log_message", message).catch(() => {});
}

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

    const onPlay = () => setState(s => ({ ...s, playbackState: "playing" }));
    const onPause = () => setState(s => ({ ...s, playbackState: "paused" }));
    const onEnded = () => setState(s => ({ ...s, playbackState: "stopped", progress: 0 }));
    const onError = (e: Event) => {
      const audio = e.target as HTMLAudioElement;
      const mediaError = audio.error;
      const msg = mediaError ? mediaError.message : "Playback error";
      logToBackend(`audio error: code=${mediaError?.code} ${msg}`);
      setState(s => ({ ...s, playbackState: "stopped", error: msg }));
    };
    const onTimeUpdate = () => setState(s => ({
      ...s,
      progress: sharedAudio.currentTime,
      duration: isNaN(sharedAudio.duration) ? 0 : sharedAudio.duration,
    }));
    const onLoadedMetadata = () => setState(s => ({
      ...s,
      duration: isNaN(sharedAudio.duration) ? 0 : sharedAudio.duration,
    }));
    const onTrackChange = () => setState(s => ({ ...s, track: sharedTrack }));

    sharedAudio.addEventListener('play', onPlay);
    sharedAudio.addEventListener('pause', onPause);
    sharedAudio.addEventListener('ended', onEnded);
    sharedAudio.addEventListener('error', onError);
    sharedAudio.addEventListener('timeupdate', onTimeUpdate);
    sharedAudio.addEventListener('loadedmetadata', onLoadedMetadata);
    window.addEventListener('deckyplex-track-change', onTrackChange);

    return () => {
      sharedAudio.removeEventListener('play', onPlay);
      sharedAudio.removeEventListener('pause', onPause);
      sharedAudio.removeEventListener('ended', onEnded);
      sharedAudio.removeEventListener('error', onError);
      sharedAudio.removeEventListener('timeupdate', onTimeUpdate);
      sharedAudio.removeEventListener('loadedmetadata', onLoadedMetadata);
      window.removeEventListener('deckyplex-track-change', onTrackChange);
    };
  }, []);

  const playTrack = useCallback((streamUrl: string, trackInfo: TrackInfo) => {
    const audio = audioRef.current;
    if (!audio) {
      logToBackend(`playTrack: audio element not initialized`);
      return;
    }

    logToBackend(`playTrack: URL = ${streamUrl.substring(0, 120)}...`);
    sharedTrack = trackInfo;
    window.dispatchEvent(new Event('deckyplex-track-change'));
    setState(s => ({ ...s, error: null, playbackState: "paused", track: trackInfo, progress: 0 }));

    // Stop any current playback
    audio.pause();

    // Plex returns one MP3 stream, which the Steam WebView can play directly.
    logToBackend(`playTrack: using native audio playback`);
    audio.src = streamUrl;
    audio.play().then(() => {
      logToBackend(`playTrack: playback started successfully`);
      setState(s => ({ ...s, playbackState: "playing" }));
    }).catch((e: Error) => {
      const errDetail = audio.error
        ? `play() failed: ${e.name} ${e.message}, audio.error.code=${audio.error.code} ${audio.error.message}`
        : `play() failed: ${e.name} ${e.message}`;
      logToBackend(errDetail);
      setState(s => ({ ...s, error: e.message || "Failed to play", playbackState: "stopped" }));
    });
  }, []);

  const play = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.play().catch((e: Error) => {
        setState(s => ({ ...s, error: e.message || "Failed to play" }));
      });
    }
  }, []);

  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
  }, []);

  const skipNext = useCallback(() => {
    // Skip ahead 10 seconds (full next track requires play queue integration)
    if (audioRef.current) {
      audioRef.current.currentTime = Math.min(
        audioRef.current.currentTime + 10,
        audioRef.current.duration || 0
      );
    }
  }, []);

  const skipPrevious = useCallback(() => {
    // Skip back 10 seconds (or restart if near beginning)
    if (audioRef.current) {
      if (audioRef.current.currentTime > 3) {
        audioRef.current.currentTime = 0;
      } else {
        audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime - 10);
      }
    }
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
