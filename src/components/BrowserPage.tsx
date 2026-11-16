import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  DialogLabel,
  Button,
  Focusable,
  SliderField,
  TextField,
  Spinner,
  ModalRoot,
  Navigation,
  showModal,
} from '@decky/ui';
import { call } from '@decky/api';
import { FaSearch, FaMusic, FaCompactDisc, FaUser, FaHistory, FaListUl, FaPlay } from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';

interface LibraryItem {
  id: string;
  key: string;
  title: string;
  type: string;
  thumb?: string;
  art?: string;
  summary?: string;
  artist?: string;
  year?: number;
  index?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  leafCount?: number;
  viewCount?: number;
  duration?: number;
}

type BrowserTab = 'artists' | 'albums' | 'tracks' | 'recent' | 'recentlyAdded' | 'playlists' | 'search';
type BrowserSubView = { type: 'albums' | 'tracks' | 'search'; title: string; id?: string; queueLabel?: string } | null;
interface ItemCacheEntry { expiresAt: number; items: LibraryItem[]; }

function versionArtwork(url: string, revision: number): string {
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}deckyplex_art=${revision}`;
}
interface BrowserHistoryEntry {
  items: LibraryItem[];
  subView: BrowserSubView;
  searchQuery: string;
  focusedItemId?: string;
}

export function BrowserPage() {
  const { playTrack, playRemoteQueue, remoteMode, remotePlayerName, addToQueue } = usePlayer();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [subView, setSubView] = useState<BrowserSubView>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [gridColumns, setGridColumns] = useState(5);
  const [gridPreferenceSet, setGridPreferenceSet] = useState(false);
  const [artworkRevision, setArtworkRevision] = useState(0);
  const [restoreFocusTick, setRestoreFocusTick] = useState(0);
  const itemCache = useRef(new Map<string, ItemCacheEntry>());
  const firstItemRef = useRef<HTMLDivElement | null>(null);
  const playCollectionRef = useRef<HTMLDivElement | null>(null);
  const gridDialogRef = useRef<{ Close: () => void } | null>(null);
  const gridPromptShown = useRef(false);
  const actionDialogRef = useRef<{ Close: () => void } | null>(null);
  const focusZone = useRef<'sidebar' | 'content'>('sidebar');
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const focusedItemId = useRef<string | undefined>(undefined);
  const pendingFocusId = useRef<string | undefined>(undefined);
  const pendingSearchFocus = useRef(false);
  const enterContentPending = useRef(false);

  const cachedItems = useCallback(async (key: string, ttlMs: number, request: () => Promise<any>) => {
    const cached = itemCache.current.get(key);
    if (cached && cached.expiresAt > Date.now()) return { items: cached.items };
    const result = await request();
    if (Array.isArray(result?.items) && !result?.error) {
      itemCache.current.set(key, { items: result.items, expiresAt: Date.now() + ttlMs });
      setArtworkRevision(revision => revision + 1);
    }
    return result;
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${activeTab}"]`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    setHistory([]);
    setSubView(null);
  }, [activeTab]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      setHistory(history.slice(0, -1));
      setItems(previous.items);
      setSubView(previous.subView);
      setSearchQuery(previous.searchQuery);
      focusedItemId.current = previous.focusedItemId;
      pendingFocusId.current = previous.focusedItemId;
      setRestoreFocusTick(value => value + 1);
    } else {
      Navigation.NavigateBack();
    }
  }, [history]);

  const handleCancel = useCallback((event: Event) => {
    if (history.length === 0 && focusZone.current === 'content') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      window.setTimeout(() => {
        Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>('[data-browser-tab]') || [])
          .find(tab => tab.dataset.browserTab === activeTab)?.focus();
      }, 0);
      return;
    }
    if (history.length === 0 && focusZone.current === 'sidebar') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      Navigation.NavigateBack();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (history.length > 0) goBack();
  }, [history.length, goBack, activeTab]);

  useEffect(() => {
    const onBackKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCancel(event);
    };
    window.addEventListener('keydown', onBackKey, true);
    return () => window.removeEventListener('keydown', onBackKey, true);
  }, [handleCancel]);

  // Check connection status periodically
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const result: any = await call("get_settings");
        const savedColumns = Number(result.grid_columns);
        setGridPreferenceSet(Number.isInteger(savedColumns) && savedColumns >= 3 && savedColumns <= 8);
        if (Number.isInteger(savedColumns) && savedColumns >= 3 && savedColumns <= 8) {
          setGridColumns(savedColumns);
        } else {
          try {
            const previousColumns = Number(window.localStorage.getItem('deckyplex-grid-columns'));
            if (Number.isInteger(previousColumns) && previousColumns >= 3 && previousColumns <= 8) {
              setGridColumns(previousColumns);
            }
          } catch {}
        }
        // The old release kept this preference in webview localStorage. Migrate
        // it once so uninstalling DeckyPlex cannot leave a stale value behind.
        try { window.localStorage.removeItem('deckyplex-grid-columns'); } catch {}
        const wasConnected = connected;
        setConnected(!!(result.has_plex_token && result.selected_server_id));
        if (!wasConnected && result.has_plex_token && result.selected_server_id) {
          loadSections();
        }
      } catch (e) {
        setConnected(false);
      }
    };
    checkConnection();
    const interval = setInterval(checkConnection, 15000);
    return () => clearInterval(interval);
  }, [connected]);

  useEffect(() => {
    if (loading || focusZone.current === 'sidebar') return;
    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (pendingFocusId.current) {
          const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-browser-item-id]') || [])
            .find(element => element.dataset.browserItemId === pendingFocusId.current);
          if (target) {
            target.focus();
            pendingFocusId.current = undefined;
            return;
          }
        }
        if (pendingSearchFocus.current) {
          pendingSearchFocus.current = false;
          firstItemRef.current?.focus();
          return;
        }
        if (enterContentPending.current) {
          enterContentPending.current = false;
          if (subView?.type === 'tracks') playCollectionRef.current?.focus();
          else if (activeTab === 'search') contentRef.current?.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
          else firstItemRef.current?.focus();
          return;
        }
        if (items.length > 0 && (subView?.type === 'tracks' || subView?.type === 'albums')) {
          if (subView.type === 'tracks') playCollectionRef.current?.focus();
          else firstItemRef.current?.focus();
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [loading, items, subView, activeTab, restoreFocusTick]);

  const saveGridColumns = useCallback(async (columns = gridColumns) => {
    try {
      const result: any = await call('set_settings', { grid_columns: columns });
      if (result?.error) throw new Error(result.error);
      setGridColumns(columns);
      setGridPreferenceSet(true);
    } catch {
      setError('Could not save browser layout preference. You can change it later in Settings > Browser.');
    }
  }, [gridColumns]);

  const previewGridColumns = useCallback((columns: number) => {
    setGridColumns(columns);
    void saveGridColumns(columns);
  }, [saveGridColumns]);

  const openGridColumnsDialog = useCallback(() => {
    const close = () => gridDialogRef.current?.Close();
    gridDialogRef.current = showModal(<GridColumnsDialog initialColumns={gridColumns}
      onPreview={previewGridColumns} onClose={close} />,
      window, { strTitle: 'Browser layout', bNeverPopOut: true });
  }, [gridColumns, previewGridColumns]);

  const openTrackOptions = useCallback((track: {
    id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string;
  }) => {
    const close = () => actionDialogRef.current?.Close();
    actionDialogRef.current = showModal(<TrackOptionsDialog track={track} addToQueue={addToQueue} onClose={close} />,
      window, { strTitle: track.title, bNeverPopOut: true });
  }, [addToQueue]);

  useEffect(() => {
    if (!connected || gridPreferenceSet || gridPromptShown.current) return;
    gridPromptShown.current = true;
    const timer = window.setTimeout(openGridColumnsDialog, 300);
    return () => window.clearTimeout(timer);
  }, [connected, gridPreferenceSet, openGridColumnsDialog]);

  const loadSections = useCallback(async () => {
    try {
      const result: any = await call("get_library_sections");
      if (result.sections && result.sections.length > 0) {
        if (!selectedSection) {
          setSelectedSection(result.sections[0].id);
        }
      }
    } catch (e) {
      console.error("Failed to load sections:", e);
    }
  }, [selectedSection]);

  // Load data when tab changes
  useEffect(() => {
    if (!connected || !selectedSection || subView) return;
    if (activeTab === 'search') { setItems([]); return; }
    loadTabData(activeTab);
  }, [activeTab, connected, selectedSection, subView]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    setLoading(true);
    setError(null);
    try {
      let result: any;
      const cacheKey = `tab:${selectedSection}:${tab}`;
      const ttl = tab === 'recent' ? 15000 : tab === 'playlists' ? 60000 : 300000;
      if (tab === 'recent') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_played', selectedSection, 100));
      } else if (tab === 'recentlyAdded') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_added', selectedSection, 100));
      } else if (tab === 'playlists') {
        result = await cachedItems(cacheKey, ttl, () => call('get_audio_playlists', 100));
      } else {
        const typeFilter = tab === 'artists' ? 'artist' : tab === 'albums' ? 'album' : 'track';
        result = await cachedItems(cacheKey, ttl, () => call("get_section_contents", selectedSection, typeFilter, 100));
      }
      if (result.error) {
        setError(result.error);
        setItems([]);
      } else if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load items.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [selectedSection, cachedItems]);

  const loadAlbums = useCallback(async (artistId: string, artistName?: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'albums', title: artistName || 'Albums', id: artistId });
    try {
      const result: any = await cachedItems(`children:${artistId}`, 300000, () => call("get_metadata_children", artistId));
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load albums.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  const loadPlaylistTracks = useCallback(async (playlistId: string, playlistName: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: playlistName || 'Playlist', id: playlistId, queueLabel: 'Play Playlist' });
    try {
      const result: any = await cachedItems(`playlist:${playlistId}`, 60000, () => call('get_playlist_tracks', playlistId, 200));
      if (Array.isArray(result.items)) setItems(result.items);
      else { setItems([]); if (result.error) setError(result.error); }
    } catch {
      setError('Failed to load playlist tracks.');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  const loadTracks = useCallback(async (albumId: string, albumName?: string) => {
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: albumName || 'Tracks', id: albumId, queueLabel: 'Play Album' });
    try {
      const result: any = await cachedItems(`children:${albumId}`, 300000, () => call("get_metadata_children", albumId));
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      setError("Failed to load tracks.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current }]);
    pendingSearchFocus.current = true;
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const cacheKey = `search:${selectedSection}:${searchQuery.trim().toLowerCase()}`;
      const result: any = await cachedItems(cacheKey, 30000, () => call("search_library", searchQuery, selectedSection, 30));
      if (Array.isArray(result.items)) {
        setItems(result.items);
        if (result.items.length === 0) pendingSearchFocus.current = false;
      } else {
        pendingSearchFocus.current = false;
      }
    } catch (e) {
      setError("Search failed.");
    } finally {
      setLoading(false);
    }
  }, [searchQuery, selectedSection, items, subView, cachedItems]);

  const startTrackQueue = useCallback(async (sourceItems: LibraryItem[], startId?: string) => {
    try {
      const trackQueue = sourceItems.filter(entry => entry.type === 'track').map(entry => ({
        id: entry.id,
        sectionId: selectedSection,
        title: entry.title || 'Unknown',
        artist: entry.grandparentTitle || entry.artist || '',
        album: entry.parentTitle || '',
        duration: entry.duration || 0,
        thumb: versionArtwork(entry.thumb || '', artworkRevision),
      }));
      if (!trackQueue.length) throw new Error('No tracks found to play.');
      const trackInfo = trackQueue.find(track => track.id === startId) || trackQueue[0];
      itemCache.current.delete(`tab:${selectedSection}:recent`);
      if (remoteMode) {
        const result = await playRemoteQueue(trackQueue, trackInfo.id);
        if (!result.success) setError(result.error || 'Could not start playback on the selected remote player.');
        return;
      }
      // Get stream URL first, then play — playTrack must be called with a valid URL
      // so audio.play() can start immediately from this call stack.
      const result: any = await call("play_track", trackInfo.id, selectedSection);
      console.log(`[DeckyPlex] play_track result:`, result);
      if (!result?.success) {
        const message = result?.error || "Plex did not return a playable audio stream.";
        setError(message);
        console.error(`[DeckyPlex] play_track error:`, message);
        return;
      }
      if (result.stream_url) {
        console.log(`[DeckyPlex] Got stream URL, starting playback`);
        playTrack(result.stream_url, trackInfo, trackQueue, result.fallback_stream_url || '');
      } else {
        setError("Plex returned no audio stream URL.");
      }
    } catch (e) {
      console.error(`[DeckyPlex] play_track exception:`, e);
      setError("Failed to play track.");
    }
  }, [selectedSection, playTrack, playRemoteQueue, remoteMode, artworkRevision]);

  const handlePlayTrack = useCallback((item: LibraryItem) => {
    void startTrackQueue(items, item.id);
  }, [items, startTrackQueue]);

  const handlePlayCollection = useCallback(async () => {
    if (!subView) return;
    if (subView.type === 'albums' && subView.id) {
      setLoading(true);
      setError(null);
      try {
        const result: any = await cachedItems(`artistTracks:${subView.id}`, 300000,
          () => call('get_artist_tracks', subView.id));
        if (result.error) throw new Error(result.error);
        await startTrackQueue(result.items || []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load artist tracks.');
      } finally {
        setLoading(false);
      }
    } else {
      await startTrackQueue(items);
    }
  }, [subView, cachedItems, startTrackQueue, items]);

  const handleItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'artist') {
      loadAlbums(item.id, item.title);
    } else if (item.type === 'album') {
      loadTracks(item.id, item.title);
    } else if (item.type === 'playlist') {
      loadPlaylistTracks(item.id, item.title);
    } else if (item.type === 'track') {
      handlePlayTrack(item);
    }
  }, [loadAlbums, loadTracks, loadPlaylistTracks, handlePlayTrack]);

  const handleSearchItemClick = useCallback((item: LibraryItem) => {
    if (item.type === 'track') {
      handlePlayTrack(item);
    } else if (item.type === 'album') {
      loadTracks(item.id, item.title);
    } else if (item.type === 'artist') {
      loadAlbums(item.id, item.title);
    }
  }, [loadAlbums, loadTracks, handlePlayTrack]);

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const gridView = subView?.type === 'albums' || (!subView && ['artists', 'albums', 'recentlyAdded', 'playlists'].includes(activeTab));

  const renderItemRow = (item: LibraryItem, idx: number | string, onClick: () => void) => {
    const imageUrl = versionArtwork(item.type === 'artist' ? (item.art || item.thumb || '') : (item.thumb || item.art || ''), artworkRevision);
    const fallbackIcon = item.type === 'track' ? <FaMusic /> : item.type === 'album' ? <FaCompactDisc /> : item.type === 'playlist' ? <FaListUl /> : <FaUser />;
    if (gridView) {
      return (
        <Focusable
          key={item.id}
          ref={idx === 0 ? firstItemRef : undefined}
          data-browser-item-id={item.id}
          onFocus={() => { focusedItemId.current = item.id; }}
          onActivate={onClick}
          onClick={onClick}
          onCancel={handleCancel}
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0.35rem', gap: '0.3rem' }}
        >
          <div style={{ width: '100%', aspectRatio: '1 / 1', overflow: 'hidden', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {imageUrl ? <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ opacity: 0.6, fontSize: '1.5rem' }}>{fallbackIcon}</span>}
          </div>
          <div style={{ fontWeight: 500, lineHeight: '1.2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
            {item.title || '(unknown)'}
          </div>
          {(item.type === 'album' && (item.artist || item.grandparentTitle || item.parentTitle)) && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {item.artist || item.grandparentTitle || item.parentTitle}
            </div>
          )}
          {item.type === 'playlist' && item.leafCount != null && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, margin: 0 }}>{item.leafCount} tracks</div>
          )}
        </Focusable>
      );
    }
    const rowDetails = (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
            {imageUrl ? (
              <div style={{
                width: '40px',
                height: '40px',
                borderRadius: '4px',
                overflow: 'hidden',
                flexShrink: 0,
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}>
                <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ) : (
              <div style={{ minWidth: '1.5rem', textAlign: 'center' }}>
                {fallbackIcon}
              </div>
            )}
            <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', gap: '0.1rem', overflow: 'hidden' }}>
              <div style={{ fontWeight: 500, lineHeight: '1.15', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                {item.title || '(unknown)'}
              </div>
              {item.type === 'track' && (item.grandparentTitle || item.artist || item.parentTitle) && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                  {[item.grandparentTitle || item.artist, item.parentTitle].filter(Boolean).join(' · ')}
                </div>
              )}
              {item.type === 'album' && (item.artist || item.grandparentTitle || item.parentTitle) && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                  {[item.artist || item.grandparentTitle || item.parentTitle, item.leafCount != null ? `${item.leafCount} tracks` : '', item.year || ''].filter(Boolean).join(' · ')}
                </div>
              )}
              {item.type === 'playlist' && item.leafCount != null && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, margin: 0 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                </div>
              )}
              {item.type !== 'album' && item.year && (
                <div style={{ fontSize: '0.75rem', lineHeight: '1.1', opacity: 0.6, margin: 0 }}>
                  {item.year}
                </div>
              )}
            </div>
            {item.type === 'track' && item.duration && (
              <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6, minWidth: '3rem', textAlign: 'right', flexShrink: 0 }}>
                {formatDuration(item.duration)}
              </DialogBodyText>
            )}
      </div>
    );
    const rowStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const, padding: '0.1rem 0.35rem', borderBottom: '1px solid rgba(255,255,255,0.08)' };
    if (item.type === 'track') {
      const trackInfo = { id: item.id, sectionId: selectedSection, title: item.title, artist: item.grandparentTitle || item.artist || '', album: item.parentTitle || '', duration: item.duration || 0, thumb: versionArtwork(item.thumb || '', artworkRevision) };
      return (
        <Focusable
          key={item.id}
            ref={idx === 0 ? firstItemRef : undefined}
            data-browser-item-id={item.id}
            onFocus={() => { focusedItemId.current = item.id; }}
            onActivate={onClick}
            onClick={onClick}
            onCancel={handleCancel}
            onSecondaryActionDescription="Options"
            onSecondaryButton={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTrackOptions(trackInfo);
            }}
            style={rowStyle}
          >
            {rowDetails}
        </Focusable>
      );
    }
    return (
      <Focusable key={item.id} ref={idx === 0 ? firstItemRef : undefined} data-browser-item-id={item.id}
        onFocus={() => { focusedItemId.current = item.id; }} onActivate={onClick} onClick={onClick}
        onCancel={handleCancel} style={rowStyle}>
        {rowDetails}
      </Focusable>
    );
  };

  const renderContent = () => {
    if (!connected) {
      return (
        <PanelSection>
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.7 }}>
              Please log in to Plex in Settings to browse your music library.
            </DialogBodyText>
          </PanelSectionRow>
        </PanelSection>
      );
    }

    return (
      <PanelSection>
        <PanelSectionRow>
          <DialogLabel style={{ flex: 1, minWidth: 0 }}>
            {subView?.title || (activeTab === 'recentlyAdded' ? 'Recently Added' : activeTab === 'recent' ? 'Recently Played' : activeTab === 'playlists' ? 'Playlists' : activeTab === 'search' ? 'Search' : activeTab === 'tracks' ? 'Songs' : activeTab[0].toUpperCase() + activeTab.slice(1))}
          </DialogLabel>
          {loading && <Spinner style={{ width: '18px', height: '18px', flexShrink: 0 }} />}
          {subView && (subView.type === 'albums' || subView.type === 'tracks') && (
            <Button ref={playCollectionRef} onClick={handlePlayCollection} onCancelButton={handleCancel} disabled={loading}>
              <FaPlay /><span style={{ marginLeft: '0.3rem' }}>{remoteMode ? 'Play remotely' : subView.type === 'albums' ? 'Play Artist' : subView.queueLabel || 'Play All'}</span>
            </Button>
          )}
        </PanelSectionRow>

        {remoteMode && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#9fc8ff', fontSize: '0.8rem' }}>
              Playback target: {remotePlayerName || 'remote Plex player'}
            </DialogBodyText>
          </PanelSectionRow>
        )}

        {!subView && activeTab === 'search' && (
          <PanelSectionRow>
            <div style={{ width: '100%', padding: '0.55rem 0 0.7rem', boxSizing: 'border-box' }}>
              <Focusable flow-children="horizontal" onCancel={handleCancel} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
              <TextField
                label=""
                style={{ flex: '1 1 32rem', minWidth: '320px', width: '32rem', maxWidth: '70vw', boxSizing: 'border-box' }}
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                placeholder="Search artists, albums, tracks..."
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
              />
              <Button onClick={handleSearch}>
                <FaSearch />
              </Button>
            </Focusable>
            </div>
          </PanelSectionRow>
        )}

        {error && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
          </PanelSectionRow>
        )}

        {gridView && !gridPreferenceSet && (
          <PanelSectionRow><Button onClick={openGridColumnsDialog}>Choose browser grid width</Button></PanelSectionRow>
        )}

        {!loading && !error && items.length > 0 && (
          <PanelSectionRow>
            <div style={{ width: '100%', paddingTop: subView?.type === 'search' ? '0.45rem' : 0, boxSizing: 'border-box' }}>
            {gridView ? (
              <Focusable flow-children="geometric" onCancel={handleCancel} style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            ) : (
              <Focusable flow-children="column" onCancel={handleCancel} style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            )}
            </div>
          </PanelSectionRow>
        )}

        {!loading && !error && items.length === 0 && !subView && activeTab !== 'search' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              No items found.
            </DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'search' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No results found.</DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'albums' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No albums found for this artist.</DialogBodyText>
          </PanelSectionRow>
        )}
        {!loading && !error && items.length === 0 && subView?.type === 'tracks' && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>No tracks found.</DialogBodyText>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  };

  const tabKeys: BrowserTab[] = ['artists', 'albums', 'tracks', 'recent', 'recentlyAdded', 'playlists', 'search'];
  const tabConfig = [
    { title: 'Artists', icon: <FaUser /> },
    { title: 'Albums', icon: <FaCompactDisc /> },
    { title: 'Songs', icon: <FaMusic /> },
    { title: 'Recently Played', icon: <FaHistory /> },
    { title: 'Recently Added', icon: <FaCompactDisc /> },
    { title: 'Playlists', icon: <FaListUl /> },
    { title: 'Search', icon: <FaSearch /> },
  ];

  const enterContent = () => {
    focusZone.current = 'content';
    enterContentPending.current = true;
    if (!loading && (items.length > 0 || activeTab === 'search')) {
      enterContentPending.current = false;
      if (activeTab === 'search') contentRef.current?.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
      else firstItemRef.current?.focus();
    }
  };

  return (
    <Focusable onCancel={handleCancel} style={{ display: 'contents' }}>
    <div
      onFocusCapture={(event) => {
        focusZone.current = event.target instanceof HTMLElement && event.target.closest('[data-browser-zone="sidebar"]') ? 'sidebar' : 'content';
      }}
      style={{ display: 'flex', gap: '0.65rem', marginTop: '40px', height: 'calc(100% - 40px)', minHeight: 0, overflow: 'hidden' }}
    >
      <div data-browser-zone="sidebar" ref={sidebarRef}
        style={{ width: '22%', minWidth: '180px', maxWidth: '260px', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.1)', padding: '0.35rem 0.45rem 0.5rem 0.2rem', overflowY: 'auto' }}>
        <DialogLabel style={{ display: 'block', padding: '0.5rem 0.65rem 0.8rem' }}>DeckyPlex</DialogLabel>
        <Focusable flow-children="column" onCancel={handleCancel} style={{ display: 'flex', flexDirection: 'column' }}>
          {tabConfig.map((config, idx) => (
            <Focusable
              key={tabKeys[idx]}
              data-browser-tab={tabKeys[idx]}
              onFocus={() => {
                focusZone.current = 'sidebar';
                if (activeTab !== tabKeys[idx]) setActiveTab(tabKeys[idx]);
              }}
              onActivate={enterContent}
              onClick={enterContent}
              style={{ display: 'flex', alignSelf: 'stretch', width: '100%', height: '42px', minHeight: '42px', boxSizing: 'border-box', alignItems: 'center', gap: '0.55rem', padding: '0 0.65rem', borderRadius: '4px', whiteSpace: 'nowrap' }}
            >
              <span style={{ display: 'inline-flex', width: '1.1rem', justifyContent: 'center', flexShrink: 0 }}>{config.icon}</span>
              <span style={{ fontWeight: activeTab === tabKeys[idx] ? 600 : 400 }}>{config.title}</span>
            </Focusable>
          ))}
        </Focusable>
      </div>
      <div data-browser-zone="content" ref={contentRef} style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingRight: '0.35rem' }}>
        {renderContent()}
      </div>
    </div>
    </Focusable>
  );
}

function GridColumnsDialog({ initialColumns, onPreview, onClose }: {
  initialColumns: number;
  onPreview: (columns: number) => void;
  onClose: () => void;
}) {
  const [columns, setColumns] = useState(initialColumns);
  return (
    <ModalRoot closeModal={onClose} onCancel={onClose} onOK={onClose}>
      <PanelSection title="Choose grid width">
        <PanelSectionRow>
          <SliderField label={`${columns} columns`} min={3} max={8} step={1} value={columns}
            onChange={(value: number) => { const next = Math.round(value); setColumns(next); onPreview(next); }} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.7 }}>You can change this later in Settings → Browser.</DialogBodyText>
        </PanelSectionRow>
      </PanelSection>
    </ModalRoot>
  );
}

function TrackOptionsDialog({ track, addToQueue, onClose }: {
  track: { id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string };
  addToQueue: (track: { id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string }, playNext?: boolean) => void;
  onClose: () => void;
}) {
  return (
    <ModalRoot closeModal={onClose} onCancel={onClose}>
      <PanelSection title={track.title}>
        <PanelSectionRow><DialogBodyText>{track.artist}{track.album ? ` · ${track.album}` : ''}</DialogBodyText></PanelSectionRow>
        <PanelSectionRow><Button onClick={() => { addToQueue(track, true); onClose(); }}>Play Next</Button></PanelSectionRow>
        <PanelSectionRow><Button onClick={() => { addToQueue(track); onClose(); }}>Add to Queue</Button></PanelSectionRow>
      </PanelSection>
    </ModalRoot>
  );
}
