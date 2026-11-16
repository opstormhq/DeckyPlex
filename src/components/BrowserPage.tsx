import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  DialogLabel,
  ButtonItem,
  Button,
  Focusable,
  SliderField,
  TextField,
  Spinner,
  SidebarNavigation,
  Navigation,
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
}

export function BrowserPage() {
  const { playTrack } = usePlayer();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [connected, setConnected] = useState(false);
  const [subView, setSubView] = useState<BrowserSubView>(null);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [gridColumns, setGridColumns] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem('deckyplex-grid-columns'));
      return Number.isInteger(saved) && saved >= 3 && saved <= 8 ? saved : 5;
    } catch {
      return 5;
    }
  });
  const [artworkRevision, setArtworkRevision] = useState(0);
  const itemCache = useRef(new Map<string, ItemCacheEntry>());

  useEffect(() => {
    try {
      window.localStorage.setItem('deckyplex-grid-columns', String(gridColumns));
    } catch (e) {
      console.warn('[DeckyPlex] Could not save grid column preference:', e);
    }
  }, [gridColumns]);

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
    } else {
      Navigation.NavigateBack();
    }
  }, [history]);

  useEffect(() => {
    const onBackKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && history.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        goBack();
      }
    };
    window.addEventListener('keydown', onBackKey, true);
    return () => window.removeEventListener('keydown', onBackKey, true);
  }, [history, goBack]);

  // Check connection status periodically
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const result: any = await call("get_settings");
        const wasConnected = connected;
        setConnected(!!(result.plex_token && result.selected_server_id));
        if (!wasConnected && result.plex_token && result.selected_server_id) {
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
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
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
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
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
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
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
    setHistory(previous => [...previous, { items, subView, searchQuery }]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const cacheKey = `search:${selectedSection}:${searchQuery.trim().toLowerCase()}`;
      const result: any = await cachedItems(cacheKey, 30000, () => call("search_library", searchQuery, selectedSection, 30));
      if (Array.isArray(result.items)) {
        setItems(result.items);
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
  }, [selectedSection, playTrack, artworkRevision]);

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
          key={idx}
          onActivate={onClick}
          onClick={onClick}
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0.35rem', gap: '0.3rem' }}
        >
          <div style={{ width: '100%', aspectRatio: '1 / 1', overflow: 'hidden', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {imageUrl ? <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ opacity: 0.6, fontSize: '1.5rem' }}>{fallbackIcon}</span>}
          </div>
          <DialogBodyText style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.title || '(unknown)'}
          </DialogBodyText>
          {(item.type === 'album' && (item.artist || item.grandparentTitle || item.parentTitle)) && (
            <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.artist || item.grandparentTitle || item.parentTitle}
            </DialogBodyText>
          )}
          {item.type === 'playlist' && item.leafCount != null && (
            <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.65 }}>{item.leafCount} tracks</DialogBodyText>
          )}
        </Focusable>
      );
    }
    return (
      <Focusable
        key={idx}
        flow-children="horizontal"
        onActivate={onClick}
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', width: '100%', gap: '0.75rem',
          padding: '0.45rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            width: '100%',
          }}>
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
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <DialogBodyText style={{ fontWeight: 500 }}>
                {item.title || '(unknown)'}
              </DialogBodyText>
              {item.type === 'track' && item.parentTitle && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.parentTitle}
                </DialogBodyText>
              )}
              {item.type === 'album' && (item.artist || item.grandparentTitle || item.parentTitle) && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.artist || item.grandparentTitle || item.parentTitle}
                </DialogBodyText>
              )}
              {item.type === 'album' && item.leafCount != null && item.leafCount > 0 && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                  {item.year ? ` • ${item.year}` : ''}
                </DialogBodyText>
              )}
              {item.type === 'playlist' && item.leafCount != null && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.leafCount} track{item.leafCount === 1 ? '' : 's'}
                </DialogBodyText>
              )}
              {item.type !== 'album' && item.year && (
                <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                  {item.year}
                </DialogBodyText>
              )}
            </div>
            {item.type === 'track' && item.duration && (
              <DialogBodyText style={{ fontSize: '0.75rem', opacity: 0.6, minWidth: '3rem', textAlign: 'right' }}>
                {formatDuration(item.duration)}
              </DialogBodyText>
            )}
          </div>
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
          {subView && <ButtonItem onClick={goBack}>← Back</ButtonItem>}
          <DialogLabel style={{ flex: 1, minWidth: 0 }}>
            {subView?.title || (activeTab === 'recentlyAdded' ? 'Recently Added' : activeTab === 'recent' ? 'Recently Played' : activeTab === 'playlists' ? 'Playlists' : activeTab === 'search' ? 'Search' : activeTab === 'tracks' ? 'Songs' : activeTab[0].toUpperCase() + activeTab.slice(1))}
          </DialogLabel>
          {loading && <Spinner style={{ width: '18px', height: '18px', flexShrink: 0 }} />}
          {subView && (subView.type === 'albums' || subView.type === 'tracks') && (
            <Button onClick={handlePlayCollection} disabled={loading}>
              <FaPlay /><span style={{ marginLeft: '0.3rem' }}>{subView.type === 'albums' ? 'Play Artist' : subView.queueLabel || 'Play All'}</span>
            </Button>
          )}
        </PanelSectionRow>

        {!subView && activeTab === 'search' && (
          <PanelSectionRow>
            <Focusable flow-children="horizontal" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
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
          </PanelSectionRow>
        )}

        {error && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
          </PanelSectionRow>
        )}

        {gridView && items.length > 0 && (
          <PanelSectionRow>
            <SliderField
              label={`Grid columns: ${gridColumns}`}
              min={3}
              max={8}
              step={1}
              value={gridColumns}
              onChange={(value: number) => setGridColumns(Math.round(value))}
              showValue={false}
            />
          </PanelSectionRow>
        )}

        {!loading && !error && items.length > 0 && (
          <PanelSectionRow>
            {gridView ? (
              <Focusable flow-children="grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </div>
            )}
          </PanelSectionRow>
        )}

        {!loading && !error && items.length === 0 && !subView && (
          <PanelSectionRow>
            <DialogBodyText style={{ opacity: 0.5 }}>
              {activeTab === 'search' ? 'Enter a search term above to find music.' : 'No items found.'}
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

  // SidebarNavigation pages - each tab triggers setActiveTab via effect
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

  const pages = tabConfig.map((config, idx) => ({
    title: config.title,
    icon: config.icon,
    content: (
      <TabActivator tab={tabKeys[idx]} onActivate={setActiveTab}>
        {renderContent()}
      </TabActivator>
    ),
  }));

  return (
    <div style={{ marginTop: '40px', height: 'calc(100% - 40px)' }}>
      <SidebarNavigation
        title="DeckyPlex"
        showTitle
        pages={pages}
      />
    </div>
  );
}

function TabActivator({ tab, onActivate, children }: { tab: BrowserTab; onActivate: (t: BrowserTab) => void; children: React.ReactNode }) {
  useEffect(() => {
    onActivate(tab);
  }, [tab, onActivate]);
  return <>{children}</>;
}
