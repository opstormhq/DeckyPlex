import { useEffect, useState } from 'react';
import { call } from '@decky/api';
import {
  Button,
  SliderField,
  PanelSection,
  PanelSectionRow,
  DialogLabel,
  DialogBodyText,
  Focusable,
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
} from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function QuickPlayer() {
  const [plexConnected, setPlexConnected] = useState(false);
  const [shufflingAll, setShufflingAll] = useState(false);
  const [shuffleError, setShuffleError] = useState('');
  const [showQueue, setShowQueue] = useState(false);
  const {
    playbackState,
    track,
    volume,
    error,
    progress,
    duration,
    remoteMode,
    remotePlayerName,
    playTrack,
    playRemoteQueue,
    beginPlaybackRequest,
    play,
    pause,
    stop,
    skipNext,
    skipPrevious,
    setVolume,
    seek,
    queue,
    queueIndex,
    playQueueIndex,
  } = usePlayer();

  useEffect(() => {
    let mounted = true;
    const refreshConnection = async () => {
      try {
        const settings: any = await call('get_settings');
        if (mounted) {
          setPlexConnected(Boolean(settings?.has_plex_token && settings?.selected_server_id && settings?.selected_server_url));
        }
      } catch {
        if (mounted) setPlexConnected(false);
      }
    };
    refreshConnection();
    const timer = setInterval(refreshConnection, 10000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const isPlaying = playbackState === 'playing';
  const isPaused = playbackState === 'paused';
  const isStopped = playbackState === 'stopped';

  const albumArtUrl = track?.thumb || null;

  const shuffleAllSongs = async () => {
    if (shufflingAll) return;
    const playbackToken = remoteMode ? undefined : beginPlaybackRequest();
    setShufflingAll(true);
    setShuffleError('');
    try {
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

      if (remoteMode) {
        const result = await playRemoteQueue(queue, queue[0]?.id);
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
  const hasTrack = !!track;
  const statusColor = !plexConnected ? '#777777' : isPlaying ? '#44ff44' : isPaused ? '#ffaa00' : error ? '#ff4444' : '#4488ff';
  const statusText = !plexConnected ? 'Not connected to Plex' : isPlaying ? 'Playing' : isPaused ? 'Paused' : error ? error : 'Ready';

  return (
    <PanelSection title="">
      <PanelSectionRow>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '0.2rem 0.5rem 0.45rem', boxSizing: 'border-box' }}><DialogLabel>Quick Player</DialogLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: 'auto' }}>
          <span style={{ fontSize: '0.75rem', opacity: 0.8, fontWeight: 400 }}>{statusText}</span>
          <div
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: statusColor,
            }}
          />
          </div>
        </div>
      </PanelSectionRow>

      {remoteMode && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#9fc8ff', fontSize: '0.8rem' }}>
            Controlling {remotePlayerName || 'remote Plex player'}
          </DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Error Message */}
      {error && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>
            {error}
          </DialogBodyText>
        </PanelSectionRow>
      )}

      {shuffleError && (
        <PanelSectionRow>
          <DialogBodyText style={{ color: '#ff6b6b' }}>{shuffleError}</DialogBodyText>
        </PanelSectionRow>
      )}

      {/* Track Info */}
      <PanelSectionRow>
        <div style={{ display: 'flex', gap: '1.1rem', alignItems: 'center', width: '100%', padding: '0.5rem 0.5rem 0.35rem', marginTop: '0.2rem', boxSizing: 'border-box' }}>
          {/* Album Art */}
          <div
            style={{
              width: '80px',
              height: '80px',
              borderRadius: '4px',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            {albumArtUrl ? (
              <img
                src={albumArtUrl}
                alt="Album art"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <DialogBodyText style={{ opacity: 0.3 }}>♪</DialogBodyText>
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
              {track?.title || 'No track selected'}
            </DialogLabel>
            {(track?.artist || track?.album) && <DialogBodyText style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {[track?.artist, track?.album].filter(Boolean).join(' · ')}
            </DialogBodyText>}
          </div>
        </div>
      </PanelSectionRow>

      {/* Progress Bar */}
      {hasTrack && (
        <PanelSectionRow>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, minWidth: '2.5rem' }}>
              {formatTime(progress)}
            </DialogBodyText>
            <div
              style={{
                flex: 1,
                height: '4px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: '2px',
                cursor: 'pointer',
                position: 'relative',
              }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const pct = x / rect.width;
                seek(pct * (duration || 0));
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
            <DialogBodyText style={{ fontSize: '0.7rem', opacity: 0.6, minWidth: '2.5rem' }}>
              {formatTime(duration)}
            </DialogBodyText>
          </div>
        </PanelSectionRow>
      )}

      {/* Playback Controls */}
      <PanelSectionRow>
        <Focusable flow-children="horizontal" style={{ display: 'flex', justifyContent: 'center', gap: '1rem', padding: '0.65rem 0.55rem', marginTop: '0.4rem' }}>
          <Button onClick={() => skipPrevious()} disabled={!hasTrack}>
            <FaStepBackward />
          </Button>
          <Button onClick={() => seek(Math.max(0, progress - 10))} disabled={!hasTrack}>
            <FaBackward />
          </Button>
          <Button onClick={() => isPlaying ? pause() : play()} disabled={!hasTrack}>
            {isPlaying ? <FaPause /> : <FaPlay />}
          </Button>
          <Button onClick={() => seek(Math.min(duration, progress + 10))} disabled={!hasTrack}>
            <FaForward />
          </Button>
          <Button onClick={() => skipNext()} disabled={!hasTrack}>
            <FaStepForward />
          </Button>
          <Button onClick={() => stop()} disabled={!hasTrack || isStopped}>
            <FaStop />
          </Button>
        </Focusable>
      </PanelSectionRow>

      <PanelSectionRow>
        <div style={{ width: '100%', padding: '0.3rem 0.5rem 0.75rem', boxSizing: 'border-box' }}>
          <Button onClick={shuffleAllSongs} disabled={!plexConnected || shufflingAll} style={{ width: '100%' }}>
            <FaRandom />
            <span style={{ marginLeft: '0.5rem' }}>{shufflingAll ? 'Starting shuffle…' : 'Shuffle all songs'}</span>
          </Button>
        </div>
      </PanelSectionRow>

      <PanelSectionRow>
        <div style={{ width: '100%', padding: '0 0.5rem', boxSizing: 'border-box' }}>
          <Button onClick={() => setShowQueue(value => !value)} disabled={!queue.length} style={{ width: '100%' }}>
            <span>{showQueue ? 'Hide queue' : `Queue${queue.length ? ` · ${queueIndex + 1}/${queue.length}` : ''}`}</span>
          </Button>
        </div>
      </PanelSectionRow>
      {showQueue && (
        <PanelSectionRow>
          <div style={{ width: '100%', maxHeight: 'min(390px, 42vh)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '0 0.5rem', boxSizing: 'border-box' }}>
            <Focusable flow-children="column" style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
              {queue.slice(Math.max(0, queueIndex)).map((queuedTrack, index) => {
                const actualIndex = Math.max(0, queueIndex) + index;
                return <Button key={`${queuedTrack.id}-${actualIndex}`} onClick={() => playQueueIndex(actualIndex)} style={{ width: '100%', minHeight: '0', height: '30px', padding: '0.05rem 0.35rem', fontSize: '0.82rem', justifyContent: 'flex-start', opacity: actualIndex === queueIndex ? 1 : 0.75 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{actualIndex === queueIndex ? '▶ ' : ''}{queuedTrack.title} <span style={{ opacity: 0.65 }}>— {queuedTrack.artist}</span></span>
                </Button>;
              })}
            </Focusable>
          </div>
        </PanelSectionRow>
      )}

      {/* Volume Control */}
      <PanelSectionRow>
        {SliderField ? (
          <div style={{ width: '100%', padding: '0.2rem 0.5rem 0.1rem', boxSizing: 'border-box', overflow: 'hidden' }}><SliderField
            label="Volume"
            min={0}
            max={100}
            value={volume}
            onChange={(value: number) => setVolume(value)}
          /></div>
        ) : (
          <DialogBodyText style={{ opacity: 0.5 }}>
            Volume: {volume}%
          </DialogBodyText>
        )}
      </PanelSectionRow>

    </PanelSection>
  );
}
