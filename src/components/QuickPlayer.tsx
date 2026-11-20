import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { call } from '@decky/api';
import {
  Button,
  SliderField,
  PanelSection,
  PanelSectionRow,
  DialogLabel,
  DialogBodyText,
  Focusable,
  GamepadButton,
  NavEntryPositionPreferences,
  type GamepadEvent,
} from '@decky/ui';
import {
  FaPlay,
  FaPause,
  FaForward,
  FaBackward,
  FaStepForward,
  FaStepBackward,
  FaStop,
  FaRandom,
  FaFilm,
} from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';
import { InlineSpinner } from './InlineSpinner';
import { playGamePipEpisode, removeGamePipEpisode, seekGamePip, setGamePipVolume, stopGamePip, toggleGamePipPlayback, useGamePipPlayback } from './GamePip';
import { VideoScrubber } from './VideoScrubber';
import { useViewerPlayback } from './VideoPlayback';
import { episodeLabel } from './VideoQueue';

const rowInset: CSSProperties = { width: '100%', minWidth: 0, paddingInline: '0.5rem', boxSizing: 'border-box' };
type QuickPlayerSettings = {
  has_plex_token?: boolean;
  selected_server_id?: string;
  selected_server_url?: string;
  browse_all_media?: boolean;
  hide_quick_login?: boolean;
  quick_player_maintain_x?: boolean;
};
let lastQuickSettings: QuickPlayerSettings | null = null;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function QuickPlayer({ onLogin, onBrowse, onExpandPip, children }: {
  onLogin: () => void; onBrowse: () => void; onExpandPip: () => void; children: ReactNode;
}) {
  const [settings, setSettings] = useState(lastQuickSettings);
  const plexConnected = !!(settings?.has_plex_token && settings.selected_server_id && settings.selected_server_url);
  const topAction = settings?.has_plex_token ? (settings.browse_all_media ? 'all' : 'music')
    : settings && !settings.hide_quick_login ? 'login' : null;
  const maintainControlPosition = settings?.quick_player_maintain_x === true;
  const [shufflingAll, setShufflingAll] = useState(false);
  const [shuffleError, setShuffleError] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const [failedMusicArt, setFailedMusicArt] = useState('');
  const [relayedMusicArt, setRelayedMusicArt] = useState({ key: '', src: '' });
  const queueContainerRef = useRef<HTMLDivElement | null>(null);
  const queueToggleRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const playPauseRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const pendingQueueFocusId = useRef<string | null>(null);
  const {
    playbackState,
    playbackPending: musicPending,
    track,
    volume: musicVolume,
    localVolume,
    volumeSliderRevision,
    error,
    progress: musicProgress,
    duration: musicDuration,
    remoteMode,
    remoteQueueEditable,
    loadMusicArtwork,
    companionMode,
    remotePlayerName,
    playTrack,
    playRemoteQueue,
    readMusicPlaybackTarget,
    beginPlaybackRequest,
    play,
    pause,
    stop,
    skipNext,
    skipPrevious,
    setVolume,
    setLocalVolume,
    seek,
    queue,
    queueIndex,
    playQueueIndex,
    removeFromQueue,
  } = usePlayer();
  const pip = useGamePipPlayback();
  const viewer = useViewerPlayback();
  const video = pip?.item ?? viewer?.item;
  const videoActive = !!video;
  const episodes = pip?.episodes ?? viewer?.episodes ?? [];
  const episodeIndex = episodes.findIndex(episode => episode.id === video?.id);
  const previousEpisode = episodeIndex > 0 ? episodes[episodeIndex - 1] : undefined;
  const nextEpisode = episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const playEpisode = pip ? playGamePipEpisode : viewer?.playEpisode;
  const canSelectEpisode = !!playEpisode && (pip ? !pip.busy : !viewer?.transferring);
  const progress = pip ? pip.playback?.position || 0 : viewer?.position ?? musicProgress;
  const duration = pip ? pip.playback?.duration || 0 : viewer?.duration ?? musicDuration;
  const volume = pip?.volume ?? viewer?.volume ?? (remoteMode ? musicVolume : localVolume);
  const volumeSource = pip ? 'pip' : viewer ? 'video' : remoteMode ? 'remote' : 'local';
  const playbackPending = pip?.busy ?? viewer?.busy ?? (musicPending || playbackState === 'starting');
  const seekPlayback = pip ? seekGamePip : viewer?.seek ?? seek;
  const activeQueue: { id: string; title: string; artist: string; playQueueItemID?: string }[] = videoActive
    ? episodes.map(episode => ({ id: episode.id, title: episodeLabel(episode), artist: episode.grandparentTitle || '' }))
    : queue;
  const activeQueueIndex = videoActive ? episodeIndex : queueIndex;
  const playQueueEntry = (index: number) => {
    if (videoActive) {
      const episode = episodes[index];
      if (episode && canSelectEpisode) void playEpisode?.(episode.id);
    } else playQueueIndex(index);
  };

  useEffect(() => {
    setShowQueue(false);
  }, [videoActive]);

  useEffect(() => {
    if (!activeQueue.length) {
      pendingQueueFocusId.current = null;
      setShowQueue(false);
    }
  }, [activeQueue.length]);

  useEffect(() => {
    if (!showQueue || !pendingQueueFocusId.current) return;
    const nextId = pendingQueueFocusId.current;
    pendingQueueFocusId.current = null;
    const rows = Array.from(queueContainerRef.current?.querySelectorAll<HTMLElement>('[data-queue-track-id]') || []);
    rows.find(row => row.dataset.queueTrackId === nextId)?.focus();
  }, [queue, pip?.episodes, viewer?.episodes, showQueue]);

  const handleRemoveQueueTrack = (index: number) => {
    const nextTrack = queue[index + 1] || queue[index - 1];
    pendingQueueFocusId.current = nextTrack?.id || null;
    removeFromQueue(index);
    if (queue.length <= 1) {
      setShowQueue(false);
      restoreControls();
    }
  };

  const removeQueueEntry = (id: string, index: number) => {
    if (!videoActive) {
      handleRemoveQueueTrack(index);
      return;
    }
    const episode = episodes[index];
    if (!episode || episode.id !== id || id === video?.id || !canSelectEpisode) return;
    pendingQueueFocusId.current = (episodes[index + 1] || episodes[index - 1])?.id || null;
    if (pip) removeGamePipEpisode(episode.id);
    else viewer?.removeEpisode(episode.id);
  };

  useEffect(() => {
    let mounted = true;
    let requestId = 0;
    const refreshConnection = async (validate = false) => {
      const id = ++requestId;
      const apply = (value: QuickPlayerSettings) => {
        if (!mounted || id !== requestId || !value) return;
        lastQuickSettings = value;
        setSettings(value);
      };
      try {
        apply(await call<[], QuickPlayerSettings>('get_settings'));
        if (validate) apply(await call<[], QuickPlayerSettings>('get_quick_player_settings'));
      } catch {}
    };
    const refreshSaved = () => void refreshConnection();
    void refreshConnection(true);
    const timer = setInterval(() => void refreshConnection(true), 10000);
    window.addEventListener('deckyplex-settings-change', refreshSaved);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('deckyplex-settings-change', refreshSaved);
    };
  }, []);

  const isPlaying = pip ? pip.playback?.status === 'playing' : viewer?.playing ?? (playbackState === 'playing');
  const isPaused = videoActive ? !isPlaying : playbackState === 'paused';
  const isStopped = playbackState === 'stopped';

  const musicArtKey = track ? `${track.sourceServerId || ''}:${track.id}:${track.thumb}` : '';
  const needsArtworkRelay = !videoActive && !!musicArtKey && (!track?.thumb || failedMusicArt === musicArtKey);
  const artwork = video ? video.poster || video.thumb
    : needsArtworkRelay ? relayedMusicArt.key === musicArtKey ? relayedMusicArt.src : '' : track?.thumb;
  const subtitle = video ? video.grandparentTitle || video.parentTitle : [track?.artist, track?.album].filter(Boolean).join(' · ');

  useEffect(() => {
    if (!needsArtworkRelay || !track?.id) return;
    let active = true;
    void loadMusicArtwork(track.id, track.sourceServerId).then(src => {
      if (active) setRelayedMusicArt({ key: musicArtKey, src });
    });
    return () => { active = false; };
  }, [needsArtworkRelay, musicArtKey, track?.id, track?.sourceServerId, loadMusicArtwork]);

  const showPlayerTop = () => {
    window.requestAnimationFrame(() => headingRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' }));
  };

  const restoreControls = () => {
    playPauseRef.current?.focus({ preventScroll: true });
    showPlayerTop();
  };

  const collapseQueue = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    setShowQueue(false);
    if (activeQueue.length) {
      window.requestAnimationFrame(() => queueToggleRef.current?.focus());
    } else {
      restoreControls();
    }
  };

  const shuffleAllSongs = async () => {
    if (shufflingAll) return;
    setShufflingAll(true);
    setShuffleError('');
    try {
      const playerId = await readMusicPlaybackTarget();
      const playbackToken = playerId ? undefined : beginPlaybackRequest();
      const sectionsResult: any = await call('get_library_sections');
      if (sectionsResult?.error) throw new Error(sectionsResult.error);
      const section = sectionsResult?.sections?.[0];
      if (!section) throw new Error('No Plex music library was found.');
      const firstPage: any = await call('get_track_page', section.id, 0, 25, true);
      if (firstPage?.error) throw new Error(firstPage.error);
      const toTrack = (item: any): { id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string } => ({
        id: String(item.id),
        sectionId: String(section.id),
        title: item.title || 'Unknown',
        artist: item.grandparentTitle || item.artist || '',
        album: item.parentTitle || '',
        duration: item.duration || 0,
        thumb: item.thumb || '',
      });
      const queue: ReturnType<typeof toTrack>[] = (firstPage.items || []).filter((item: any) => item.type === 'track').map(toTrack);
      if (!queue.length) throw new Error('No songs were found in your music library.');

      if (playerId) {
        const result = await playRemoteQueue(playerId, queue, queue[0]?.id);
        if (!result.success) throw new Error(result.error || 'Could not start shuffled playback.');
      } else {
        const seenIds = new Set(queue.map(item => item.id));
        const loadMore = async () => {
          const page: any = await call('get_track_page', section.id, 0, 25, true);
          if (page?.error) throw new Error(page.error);
          const tracks = (page.items || []).filter((item: any) => item.type === 'track')
            .map(toTrack).filter((item: any) => !seenIds.has(item.id));
          for (const item of tracks) seenIds.add(item.id);
          for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
          }
          return tracks;
        };
        for (let i = queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue[i], queue[j]] = [queue[j], queue[i]];
        }
        const stream: any = await call('play_track', queue[0].id, section.id);
        if (!stream?.success || !stream.stream_url) {
          throw new Error(stream?.error || 'Plex did not return a playable audio stream.');
        }
        playTrack(stream.stream_url, queue[0], queue, stream.fallback_stream_url || '', loadMore, playbackToken);
      }
    } catch (e: any) {
      setShuffleError(e?.message || 'Could not shuffle the music library.');
    } finally {
      setShufflingAll(false);
    }
  };

  // Status: green=playing, orange=paused, blue=ready (default), red=error
  const hasTrack = !!(video || track);
  const canPlay = videoActive ? (pip ? !pip.busy : !!viewer?.ready)
    : remoteMode ? hasTrack && !isStopped && !playbackPending : hasTrack || queue.length > 0;
  const canStop = videoActive || (hasTrack && !isStopped && (!remoteMode || !musicPending));
  const canSeek = videoActive ? canPlay && duration > 0 : hasTrack;
  const canSkipPrevious = videoActive ? canSelectEpisode && !!previousEpisode : hasTrack;
  const canSkipNext = videoActive ? canSelectEpisode && !!nextEpisode : hasTrack;
  const trackInfoFocusable = hasTrack && !topAction;
  const TrackInfo = trackInfoFocusable ? Focusable : 'div';
  const videoError = !pip && !!viewer?.error;
  const statusColor = videoActive ? (videoError ? '#ff4444' : isPaused ? '#ffaa00' : '#44ff44') : error ? '#ff4444' : companionMode ? (isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : '#4488ff') : !plexConnected ? '#777777' : isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : '#4488ff';
  const statusText = videoActive ? `${pip ? 'PiP' : 'Video'} · ${playbackPending ? 'Loading…' : videoError ? 'Playback error' : isPaused ? 'Paused' : 'Playing'}`
    : playbackPending ? 'Loading playback…' : error ? 'Error' : companionMode ? 'Remote play' : !plexConnected ? 'Not connected to Plex' : isPlaying ? 'Playing' : isPaused ? 'Paused' : 'Ready';

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onButtonDown = (input: Event) => {
      const event = input as GamepadEvent;
      const active = document.activeElement;
      if (!active || !player.contains(active)) return;
      const atControls = controlsRef.current?.contains(active);
      if (event.detail?.button !== GamepadButton.CANCEL) return;
      if (active.closest('[data-video-scrubbing]')) return;
      if (!showQueue && atControls) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.detail.is_repeat) return;
      if (showQueue) {
        collapseQueue(event);
      } else {
        restoreControls();
      }
    };
    player.addEventListener('vgp_onbuttondown', onButtonDown, true);
    return () => player.removeEventListener('vgp_onbuttondown', onButtonDown, true);
  });

  return (
    <div ref={playerRef}>
    <PanelSection title="">
      <PanelSectionRow>
        <div ref={headingRef} onFocusCapture={showPlayerTop}
          style={{ ...rowInset, display: 'flex', flexDirection: 'column', gap: '0.3rem', paddingBlock: '0.2rem 0.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.35rem' }}>
            {topAction ? (
              <Button onClick={topAction === 'login' ? onLogin : onBrowse}
                style={{ flexShrink: 0, minHeight: '30px', minWidth: '4.5rem', padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}>
                {topAction === 'all' ? 'Browse Media' : topAction === 'music' ? 'Browse Music' : 'Log in'}
              </Button>
            ) : <DialogLabel style={{ margin: 0 }}>Quick Player</DialogLabel>}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
              <span role="status" style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 400 }}>{statusText}</span>
              {playbackPending ? <InlineSpinner /> : <span aria-hidden="true" style={{
                width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusColor, flexShrink: 0,
              }} />}
            </div>
          </div>
        </div>
      </PanelSectionRow>

      {!videoActive && remoteMode && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#9fc8ff', fontSize: '0.8rem' }}>
            Controlling {remotePlayerName || 'remote Plex player'}
          </DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Error Message */}
      {!videoActive && error && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>
            {error}
          </DialogBodyText>
        </PanelSectionRow>
      )}

      {!videoActive && shuffleError && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>{shuffleError}</DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Track Info */}
      <PanelSectionRow>
        <TrackInfo tabIndex={trackInfoFocusable ? 0 : undefined}
          onFocus={trackInfoFocusable ? showPlayerTop : undefined}
          style={{ ...rowInset, display: 'flex', gap: '1.1rem', alignItems: 'center', paddingBlock: '0.5rem 0.35rem', marginTop: '0.2rem' }}>
          {/* Album Art */}
          <div
            style={{
              width: video ? '60px' : '80px',
              height: video ? '90px' : '80px',
              borderRadius: '4px',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {artwork ? (
              <img
                key={artwork}
                src={artwork}
                alt=""
                onError={videoActive ? undefined : () => {
                  if (needsArtworkRelay) setRelayedMusicArt({ key: musicArtKey, src: '' });
                  else setFailedMusicArt(musicArtKey);
                }}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <DialogBodyText style={{ opacity: 0.3 }}>{video ? <FaFilm /> : '♪'}</DialogBodyText>
            )}
          </div>

          {/* Track Details */}
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', justifyContent: 'center', gap: '0.2rem', minWidth: 0, paddingRight: '0.25rem' }}>
            <DialogLabel
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                lineHeight: 1.15,
                margin: 0,
              }}
            >
              {(video && episodeLabel(video)) || track?.title || 'No track selected'}
            </DialogLabel>
            {subtitle && <DialogBodyText style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {subtitle}
            </DialogBodyText>}
          </div>
        </TrackInfo>
      </PanelSectionRow>

      {/* Progress Bar */}
      {videoActive && duration > 0 ? (
        <PanelSectionRow>
          <div style={rowInset}>
            <VideoScrubber key={video?.id} position={progress} duration={duration} disabled={!canSeek} seek={seekPlayback} />
          </div>
        </PanelSectionRow>
      ) : hasTrack && !videoActive && (
        <PanelSectionRow>
          <div style={{ ...rowInset, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, width: '2.5rem', margin: 0 }}>
              {formatTime(progress)}
            </DialogBodyText>
            <div
              style={{
                flex: 1,
                height: '4px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: '2px',
                cursor: canSeek ? 'pointer' : 'default',
                position: 'relative',
              }}
              onClick={(e) => {
                if (!canSeek) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const pct = x / rect.width;
                seekPlayback(pct * (duration || 0));
              }}
            >
              <div
                style={{
                width: `${duration > 0 ? Math.min(100, Math.max(0, (progress / duration) * 100)) : 0}%`,
                  height: '100%',
                  backgroundColor: '#4a9eff',
                  borderRadius: '2px',
                  transition: 'width 0.1s linear',
                }}
              />
            </div>
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, width: '2.5rem', textAlign: 'right', margin: 0 }}>
              {formatTime(duration)}
            </DialogBodyText>
          </div>
        </PanelSectionRow>
      )}

      {/* Playback Controls */}
      <PanelSectionRow>
        <Focusable ref={controlsRef} flow-children="horizontal"
          navEntryPreferPosition={maintainControlPosition ? NavEntryPositionPreferences.MAINTAIN_X : NavEntryPositionPreferences.PREFERRED_CHILD}
          style={{ ...rowInset, display: 'flex', justifyContent: 'center', gap: '1rem', paddingBlock: '0.65rem', marginTop: '0.4rem' }}>
          <Button aria-label={videoActive ? 'Previous episode' : 'Previous track'}
            onClick={() => { if (canSkipPrevious) previousEpisode ? void playEpisode?.(previousEpisode.id) : skipPrevious(); }}
            aria-disabled={!canSkipPrevious} style={{ opacity: canSkipPrevious ? 1 : 0.5 }}>
            <FaStepBackward />
          </Button>
          <Button aria-label="Back 10 seconds" onClick={() => { if (canSeek) seekPlayback(Math.max(0, progress - 10)); }}
            aria-disabled={!canSeek} style={{ opacity: canSeek ? 1 : 0.5 }}>
            <FaBackward />
          </Button>
          <Button ref={playPauseRef} preferredFocus={!maintainControlPosition}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            onClick={() => {
              if (!canPlay) return;
              if (pip) toggleGamePipPlayback();
              else if (viewer) viewer.toggle();
              else if (isPlaying) pause();
              else if (hasTrack || remoteMode) play();
              else if (queue.length) playQueueIndex(Math.max(0, queueIndex));
            }}
            aria-disabled={!canPlay} style={{ opacity: canPlay ? 1 : 0.5 }}>
            {isPlaying ? <FaPause /> : <FaPlay />}
          </Button>
          <Button aria-label="Forward 10 seconds" onClick={() => { if (canSeek) seekPlayback(Math.min(duration, progress + 10)); }}
            aria-disabled={!canSeek} style={{ opacity: canSeek ? 1 : 0.5 }}>
            <FaForward />
          </Button>
          <Button aria-label={videoActive ? 'Next episode' : 'Next track'}
            onClick={() => { if (canSkipNext) nextEpisode ? void playEpisode?.(nextEpisode.id) : skipNext(); }}
            aria-disabled={!canSkipNext} style={{ opacity: canSkipNext ? 1 : 0.5 }}>
            <FaStepForward />
          </Button>
          <Button aria-label="Stop" onClick={() => { if (canStop) (pip ? stopGamePip : viewer?.stop ?? stop)(); }}
            aria-disabled={!canStop} style={{ opacity: canStop ? 1 : 0.5 }}>
            <FaStop />
          </Button>
        </Focusable>
      </PanelSectionRow>

      {(!videoActive || pip || viewer?.expand || viewer?.popOut) && <PanelSectionRow>
        <Focusable flow-children="horizontal" style={{ ...rowInset, display: 'flex', gap: '0.4rem', paddingBlock: '0.3rem 0.75rem' }}>
          {videoActive ? <>
            {(pip || viewer?.expand) && <Button onClick={pip ? onExpandPip : viewer?.expand}
              disabled={playbackPending} style={{ flex: 1 }}>Full screen</Button>}
            {!pip && viewer?.popOut && <Button onClick={viewer.popOut}
              disabled={playbackPending || !viewer.ready} style={{ flex: 1 }}>Pop out</Button>}
          </>
          : <Button onClick={shuffleAllSongs} disabled={!plexConnected || shufflingAll} style={{ width: '100%', gap: '0.5rem' }}>
            {shufflingAll ? <InlineSpinner /> : <FaRandom />}
            <span>{shufflingAll ? 'Starting shuffle…' : 'Shuffle all songs'}</span>
          </Button>}
        </Focusable>
      </PanelSectionRow>}

      {(!videoActive || episodes.length > 0) && <PanelSectionRow>
        <div style={rowInset}>
          <Button ref={queueToggleRef} onClick={() => setShowQueue(value => !value)}
            onCancelButton={showQueue ? collapseQueue : undefined} disabled={!activeQueue.length}
            style={{ width: '100%', minHeight: '30px' }}>
            <span>{showQueue ? 'Hide queue' : `Queue${activeQueue.length ? ` · ${activeQueueIndex < 0 ? `${activeQueue.length} queued` : `${activeQueueIndex + 1}/${activeQueue.length}`}` : ''}`}</span>
          </Button>
        </div>
      </PanelSectionRow>}
      {showQueue && !!activeQueue.length && (
        <PanelSectionRow>
          <div ref={queueContainerRef} style={{ width: '100%', maxHeight: 'min(390px, 42vh)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 0.5rem', boxSizing: 'border-box' }}>
            <Focusable flow-children="column" onCancel={collapseQueue} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              {activeQueue.slice(Math.max(0, activeQueueIndex)).map((queuedTrack, index) => {
                const actualIndex = Math.max(0, activeQueueIndex) + index;
                const current = actualIndex === activeQueueIndex;
                const canEdit = videoActive ? !current && canSelectEpisode
                  : remoteMode ? remoteQueueEditable && !musicPending && !current && !!queuedTrack.playQueueItemID : true;
                const canPlayEntry = videoActive ? canSelectEpisode : !remoteMode;
                const queueKey = videoActive ? queuedTrack.id
                  : remoteMode && queuedTrack.playQueueItemID ? queuedTrack.playQueueItemID : `${queuedTrack.id}-${actualIndex}`;
                return <Button key={queueKey} ref={(element: HTMLDivElement | null) => { if (element) element.dataset.queueTrackId = queuedTrack.id; }}
                  aria-disabled={!canPlayEntry} onClick={canPlayEntry ? () => playQueueEntry(actualIndex) : undefined}
                  onSecondaryActionDescription={canEdit ? 'Remove from queue' : undefined}
                  onSecondaryButton={!canEdit ? undefined : event => {
                    event.preventDefault();
                    event.stopPropagation();
                    removeQueueEntry(queuedTrack.id, actualIndex);
                  }}
                  style={{ width: '100%', minWidth: 0, minHeight: 0, height: '24px', padding: '0 0.35rem', fontSize: '0.8rem', lineHeight: 1.15, justifyContent: 'flex-start', overflow: 'hidden', boxSizing: 'border-box', opacity: current ? 1 : 0.75 }}>
                  <span style={{ display: 'block', width: '100%', maxWidth: '100%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{current ? '▶ ' : ''}{queuedTrack.title} {queuedTrack.artist && <span style={{ opacity: 0.65 }}>— {queuedTrack.artist}</span>}</span>
                </Button>;
              })}
            </Focusable>
          </div>
        </PanelSectionRow>
      )}

      {/* Volume Control */}
      <PanelSectionRow>
        <div style={{ ...rowInset, paddingBlock: '0.55rem 0.2rem' }}>
          <SliderField
            key={`${volumeSource}:${volumeSliderRevision}`}
            label="Volume"
            layout="below"
            childrenContainerWidth="max"
            bottomSeparator="none"
            min={0}
            max={100}
            value={volume}
            onChange={value => {
              if (!videoActive) {
                setVolume(value);
                return;
              }
              setLocalVolume(value);
              if (pip) setGamePipVolume(value);
              else viewer?.setVolume(value);
            }}
          />
        </div>
      </PanelSectionRow>
    </PanelSection>
    <div style={{ paddingInline: '0.5rem' }}>
      {children}
    </div>
    </div>
  );
}
