import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PanelSection,
  PanelSectionRow,
  DialogBodyText,
  DialogLabel,
  Button,
  Focusable,
  TextField,
  Spinner,
  ModalRoot,
  ConfirmModal,
  Navigation,
  GamepadButton,
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
interface ItemCacheEntry { expiresAt: number; items: LibraryItem[]; hasMore?: boolean; }

function versionArtwork(url: string, revision: number): string {
  if (!url) return '';
  return `${url}${url.includes('?') ? '&' : '?'}deckyplex_art=${revision}`;
}
interface BrowserHistoryEntry {
  items: LibraryItem[];
  subView: BrowserSubView;
  searchQuery: string;
  focusedItemId?: string;
  scrollTop: number;
}
interface TabFocusPosition { itemId: string; scrollTop: number; }

export function BrowserPage() {
  const { playTrack, playRemoteQueue, beginPlaybackRequest, remoteMode, remotePlayerName, addToQueue } = usePlayer();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const activeTabRef = useRef<BrowserTab>(activeTab);
  activeTabRef.current = activeTab;
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [tabHasMore, setTabHasMore] = useState(false);
  const [focusTreeVersion, setFocusTreeVersion] = useState(0);
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
  const pendingScrollTop = useRef<number | undefined>(undefined);
  const tabFocusPositions = useRef(new Map<BrowserTab, TabFocusPosition>());
  const pendingSearchFocus = useRef(false);
  const pendingSearchInputFocus = useRef(false);
  const loadingMoreRef = useRef(false);
  const tabLoadRequestId = useRef(0);
  const restoringHistoryRef = useRef(false);
  const enterContentPending = useRef(false);

  const selectTab = (tab: BrowserTab) => {
    if (tab === activeTabRef.current) return;
    activeTabRef.current = tab;
    // Invalidate outstanding root and pagination requests synchronously when
    // focus moves between categories. The effect below then loads only the new tab.
    tabLoadRequestId.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setItems([]);
    setTabHasMore(false);
    setError(null);
    setLoading(tab !== 'search');
    setActiveTab(tab);
  };

  const keepFocusedElementVisible = (element: HTMLElement) => {
    window.requestAnimationFrame(() => {
      const viewport = contentRef.current;
      if (!viewport || !viewport.contains(element)) return;
      const item = element.closest<HTMLElement>('[data-browser-item-id]') || element;
      const itemRect = item.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const edgePadding = 28;
      // Steam overlays a footer on the bottom of routed plugin views. Keep a
      // generous safe area there so focused cards and the last track stay readable.
      const visibleBottom = Math.min(viewportRect.bottom, window.innerHeight - 150);
      if (itemRect.bottom > visibleBottom - edgePadding) {
        viewport.scrollTop += itemRect.bottom - (visibleBottom - edgePadding);
      } else if (itemRect.top < viewportRect.top + edgePadding) {
        viewport.scrollTop -= (viewportRect.top + edgePadding) - itemRect.top;
      }
      const itemId = item.dataset.browserItemId;
      if (itemId && !subView) tabFocusPositions.current.set(activeTab, { itemId, scrollTop: viewport.scrollTop });
    });
  };

  const cachedItems = useCallback(async (key: string, ttlMs: number, request: () => Promise<any>) => {
    const cached = itemCache.current.get(key);
    if (cached && cached.expiresAt > Date.now()) return { items: cached.items, has_more: cached.hasMore };
    const result = await request();
    if (Array.isArray(result?.items) && !result?.error) {
      itemCache.current.set(key, { items: result.items, hasMore: result.has_more, expiresAt: Date.now() + ttlMs });
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
    tabLoadRequestId.current++;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setHistory([]);
    setSubView(null);
  }, [activeTab]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      tabLoadRequestId.current++;
      restoringHistoryRef.current = previous.subView === null;
      setHistory(history.slice(0, -1));
      setItems(previous.items);
      setSubView(previous.subView);
      setSearchQuery(previous.searchQuery);
      focusedItemId.current = previous.focusedItemId;
      // Returning from a search result should restore the search form itself.
      // Search inputs don't have a browser item id, so generic history focus
      // restoration otherwise leaves focus nowhere and the next B exits.
      pendingSearchInputFocus.current = activeTab === 'search' && previous.subView === null;
      pendingFocusId.current = pendingSearchInputFocus.current ? undefined : previous.focusedItemId;
      pendingScrollTop.current = previous.scrollTop;
      setRestoreFocusTick(value => value + 1);
    } else {
      Navigation.NavigateBack();
    }
  }, [history, activeTab]);

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
        if (pendingSearchInputFocus.current) {
          pendingSearchInputFocus.current = false;
          contentRef.current?.querySelector<HTMLElement>('input')?.focus();
          return;
        }
        if (pendingFocusId.current) {
          const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-browser-item-id]') || [])
            .find(element => element.dataset.browserItemId === pendingFocusId.current);
          if (target) {
            if (pendingScrollTop.current != null && contentRef.current) {
              contentRef.current.scrollTop = pendingScrollTop.current;
              pendingScrollTop.current = undefined;
            }
            target.focus({ preventScroll: true });
            pendingFocusId.current = undefined;
            return;
          }
          pendingFocusId.current = undefined;
          pendingScrollTop.current = undefined;
          enterContentPending.current = true;
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
  }, playlistId?: string) => {
    const close = () => actionDialogRef.current?.Close();
    actionDialogRef.current = showModal(<TrackOptionsDialog track={track} playlistId={playlistId} addToQueue={addToQueue} onClose={close} />,
      window, { strTitle: track.title, bNeverPopOut: true });
  }, [addToQueue]);

  const openPlaylistOptions = useCallback((playlist: LibraryItem) => {
    const close = () => actionDialogRef.current?.Close();
    const handleDeleted = (playlistId: string) => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      itemCache.current.delete(`playlist:${playlistId}`);
      setItems(current => current.filter(item => item.id !== playlistId));
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
      close();
    };
    actionDialogRef.current = showModal(<PlaylistOptionsDialog playlist={playlist} onDeleted={handleDeleted} onClose={close} />,
      window, { strTitle: playlist.title, bNeverPopOut: true });
  }, [selectedSection]);

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
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    if (activeTab === 'search') {
      tabLoadRequestId.current++;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setLoading(false);
      setTabHasMore(false);
      setItems([]);
      return;
    }
    loadTabData(activeTab);
  }, [activeTab, connected, selectedSection, subView]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    const requestId = ++tabLoadRequestId.current;
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setError(null);
    const cacheKey = `tab:${selectedSection}:${tab}`;
    const cached = itemCache.current.get(cacheKey);
    const expectedTypes: Partial<Record<BrowserTab, string[]>> = {
      artists: ['artist'], albums: ['album'], tracks: ['track'], recent: ['track'],
      recentlyAdded: ['album'], playlists: ['playlist'],
    };
    const cachedTabItems = cached && expectedTypes[tab]
      ? cached.items.filter(item => expectedTypes[tab]?.includes(item.type))
      : cached?.items;
    const cacheIsFresh = !!cached && cached.expiresAt > Date.now();
    const ttl = tab === 'recent' ? 15000 : tab === 'playlists' ? 60000 : 300000;
    if (cached) {
      setItems(cachedTabItems || []);
      setTabHasMore(Boolean(cached.hasMore));
    } else {
      setItems([]);
      setTabHasMore(false);
    }
    setLoading(!cacheIsFresh);
    if (cacheIsFresh) return;
    try {
      let result: any;
      if (tab === 'recent') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_played', selectedSection, 100));
      } else if (tab === 'recentlyAdded') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_added', selectedSection, 100));
      } else if (tab === 'playlists') {
        result = await cachedItems(cacheKey, ttl, () => call('get_audio_playlists', 100));
      } else {
        const typeFilter = tab === 'artists' ? 'artist' : tab === 'albums' ? 'album' : 'track';
        result = await cachedItems(cacheKey, ttl, () => call("get_section_contents", selectedSection, typeFilter, 100, 0));
      }
      if (requestId !== tabLoadRequestId.current) return;
      if (tab === 'artists' || tab === 'albums' || tab === 'tracks') setTabHasMore(Boolean(result.has_more));
      if (result.error) {
        if (!cached) {
          setError(result.error);
          setItems([]);
        }
      } else if (Array.isArray(result.items)) {
        if (requestId !== tabLoadRequestId.current) return;
        const tabItems = expectedTypes[tab]
          ? result.items.filter((item: LibraryItem) => expectedTypes[tab]?.includes(item.type))
          : result.items;
        const firstPageIds = new Set(tabItems.map((item: LibraryItem) => item.id));
        const mergedItems = cached
          ? [...tabItems, ...(cachedTabItems || []).filter(item => !firstPageIds.has(item.id))]
          : tabItems;
        setItems(mergedItems);
        itemCache.current.set(cacheKey, {
          items: mergedItems,
          hasMore: Boolean(result.has_more),
          expiresAt: Date.now() + ttl,
        });
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      if (!cached) {
        setError("Failed to load items.");
        setItems([]);
      }
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [selectedSection, cachedItems]);

  useEffect(() => {
    const refreshPlaylists = () => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      if (activeTab === 'playlists' && !subView) void loadTabData('playlists');
    };
    window.addEventListener('deckyplex-playlists-change', refreshPlaylists);
    return () => window.removeEventListener('deckyplex-playlists-change', refreshPlaylists);
  }, [selectedSection, activeTab, subView, loadTabData]);

  const loadMoreTabPage = useCallback(async () => {
    if (!tabHasMore || loadingMoreRef.current || !selectedSection || subView || !['artists', 'albums', 'tracks'].includes(activeTab)) return;
    const requestId = tabLoadRequestId.current;
    const requestedTab = activeTab;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const focusedId = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('[data-browser-item-id]')?.dataset.browserItemId
      : focusedItemId.current;
    const savedScrollTop = contentRef.current?.scrollTop || 0;
    try {
      const typeFilter = activeTab === 'artists' ? 'artist' : activeTab === 'albums' ? 'album' : 'track';
      const offset = items.length;
      const cacheKey = `tab:${selectedSection}:${activeTab}:${offset}`;
      const result: any = await cachedItems(cacheKey, 300000,
        () => call('get_section_contents', selectedSection, typeFilter, 100, offset));
      if (requestId !== tabLoadRequestId.current || requestedTab !== activeTab) return;
      if (result.error) {
        setError(result.error);
        return;
      }
      const nextPage: LibraryItem[] = Array.isArray(result.items) ? result.items : [];
      const existing = new Set(items.map(item => item.id));
      const mergedItems = [...items, ...nextPage.filter(item => !existing.has(item.id))];
      if (focusedId) {
        pendingFocusId.current = focusedId;
        pendingScrollTop.current = savedScrollTop;
        setRestoreFocusTick(value => value + 1);
      }
      setItems(mergedItems);
      setTabHasMore(Boolean(result.has_more));
      const baseKey = `tab:${selectedSection}:${activeTab}`;
      itemCache.current.set(baseKey, {
        items: mergedItems,
        hasMore: Boolean(result.has_more),
        expiresAt: Date.now() + 300000,
      });
    } catch (e) {
      if (requestId === tabLoadRequestId.current && requestedTab === activeTab) setError('Could not load more music library items.');
    } finally {
      if (requestId === tabLoadRequestId.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [tabHasMore, selectedSection, subView, activeTab, items.length, cachedItems]);

  const loadAlbums = useCallback(async (artistId: string, artistName?: string) => {
    const requestId = ++tabLoadRequestId.current;
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    setLoading(true);
    setError(null);
    setSubView({ type: 'albums', title: artistName || 'Albums', id: artistId });
    try {
      const result: any = await cachedItems(`children:${artistId}`, 300000, () => call("get_metadata_children", artistId));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Failed to load albums.");
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  const loadPlaylistTracks = useCallback(async (playlistId: string, playlistName: string) => {
    const requestId = ++tabLoadRequestId.current;
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: playlistName || 'Playlist', id: playlistId, queueLabel: 'Play Playlist' });
    try {
      const result: any = await cachedItems(`playlist:${playlistId}`, 60000, () => call('get_playlist_tracks', playlistId, 200));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) setItems(result.items);
      else { setItems([]); if (result.error) setError(result.error); }
    } catch {
      if (requestId !== tabLoadRequestId.current) return;
      setError('Failed to load playlist tracks.');
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  useEffect(() => {
    const refreshVisiblePlaylist = (event: Event) => {
      const playlistId = (event as CustomEvent<{ playlistId?: string }>).detail?.playlistId;
      if (!playlistId) return;
      itemCache.current.delete(`playlist:${playlistId}`);
      if (subView?.type !== 'tracks' || subView.queueLabel !== 'Play Playlist' || subView.id !== playlistId) return;
      const requestId = ++tabLoadRequestId.current;
      setLoading(true);
      setError(null);
      call('get_playlist_tracks', playlistId, 200).then((result: any) => {
        if (requestId !== tabLoadRequestId.current) return;
        if (result?.error) throw new Error(result.error);
        setItems(Array.isArray(result?.items) ? result.items : []);
        itemCache.current.set(`playlist:${playlistId}`, {
          items: Array.isArray(result?.items) ? result.items : [], expiresAt: Date.now() + 60000,
        });
      }).catch((error: any) => {
        if (requestId === tabLoadRequestId.current) setError(error?.message || 'Could not refresh playlist tracks.');
      }).finally(() => {
        if (requestId === tabLoadRequestId.current) setLoading(false);
      });
    };
    window.addEventListener('deckyplex-playlists-change', refreshVisiblePlaylist);
    return () => window.removeEventListener('deckyplex-playlists-change', refreshVisiblePlaylist);
  }, [subView]);

  const loadTracks = useCallback(async (albumId: string, albumName?: string) => {
    const requestId = ++tabLoadRequestId.current;
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    setLoading(true);
    setError(null);
    setSubView({ type: 'tracks', title: albumName || 'Tracks', id: albumId, queueLabel: 'Play Album' });
    try {
      const result: any = await cachedItems(`children:${albumId}`, 300000, () => call("get_metadata_children", albumId));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) {
        setItems(result.items);
      } else {
        setItems([]);
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Failed to load tracks.");
      setItems([]);
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, searchQuery, cachedItems]);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    const requestId = ++tabLoadRequestId.current;
    setHistory(previous => [...previous, { items, subView, searchQuery, focusedItemId: focusedItemId.current, scrollTop: contentRef.current?.scrollTop || 0 }]);
    pendingSearchFocus.current = true;
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const cacheKey = `search:${selectedSection}:${searchQuery.trim().toLowerCase()}`;
      const result: any = await cachedItems(cacheKey, 30000, () => call("search_library", searchQuery, selectedSection, 30));
      if (requestId !== tabLoadRequestId.current) return;
      if (Array.isArray(result.items)) {
        setItems(result.items);
        if (result.items.length === 0) pendingSearchFocus.current = false;
      } else {
        pendingSearchFocus.current = false;
      }
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Search failed.");
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [searchQuery, selectedSection, items, subView, cachedItems]);

  const startTrackQueue = useCallback(async (sourceItems: LibraryItem[], startId?: string) => {
    try {
      const fullTrackQueue = sourceItems.filter(entry => entry.type === 'track').map(entry => ({
        id: entry.id,
        sectionId: selectedSection,
        title: entry.title || 'Unknown',
        artist: entry.grandparentTitle || entry.artist || '',
        album: entry.parentTitle || '',
        duration: entry.duration || 0,
        thumb: versionArtwork(entry.thumb || '', artworkRevision),
      }));
      if (!fullTrackQueue.length) throw new Error('No tracks found to play.');
      const selectedIndex = startId == null ? 0 : fullTrackQueue.findIndex(track => String(track.id) === String(startId));
      const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const trackInfo = fullTrackQueue[startIndex];
      const trackQueue = fullTrackQueue.slice(startIndex);
      itemCache.current.delete(`tab:${selectedSection}:recent`);
      if (remoteMode) {
        const result = await playRemoteQueue(fullTrackQueue, trackInfo.id);
        if (!result.success) setError(result.error || 'Could not start playback on the selected remote player.');
        return;
      }
      const playbackToken = beginPlaybackRequest();
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
        playTrack(result.stream_url, trackInfo, trackQueue, result.fallback_stream_url || '', undefined, playbackToken);
      } else {
        setError("Plex returned no audio stream URL.");
      }
    } catch (e) {
      console.error(`[DeckyPlex] play_track exception:`, e);
      setError("Failed to play track.");
    }
  }, [selectedSection, playTrack, playRemoteQueue, beginPlaybackRequest, remoteMode, artworkRevision]);

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
    focusedItemId.current = item.id;
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
    focusedItemId.current = item.id;
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

  const handleGridDirection = (event: import('@decky/ui').GamepadEvent) => {
    if (subView || event.detail.button !== GamepadButton.DIR_UP) return;
    const focusedId = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('[data-browser-item-id]')?.dataset.browserItemId
      : undefined;
    const focusedIndex = items.findIndex(item => item.id === (focusedId || focusedItemId.current));
    const isTopRow = gridView ? focusedIndex >= 0 && focusedIndex < gridColumns : focusedIndex === 0;
    if (isTopRow) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const jumpToListTop = (event: import('@decky/ui').GamepadEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!items.length) return;
    if (contentRef.current) contentRef.current.scrollTop = 0;
    const firstItem = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[data-browser-item-id]') || [])
      .find(element => element.dataset.browserItemId === items[0].id);
    if (firstItem) firstItem.focus({ preventScroll: true });
  };

  const renderItemRow = (item: LibraryItem, idx: number | string, onClick: () => void) => {
    const imageUrl = versionArtwork(item.type === 'artist' ? (item.art || item.thumb || '') : (item.thumb || item.art || ''), artworkRevision);
    const fallbackIcon = item.type === 'track' ? <FaMusic /> : item.type === 'album' ? <FaCompactDisc /> : item.type === 'playlist' ? <FaListUl /> : <FaUser />;
    if (gridView) {
      return (
        <Focusable
          key={item.id}
          ref={idx === 0 ? firstItemRef : undefined}
          data-browser-item-id={item.id}
          onFocus={() => {
            focusedItemId.current = item.id;
            if (!subView) tabFocusPositions.current.set(activeTab, { itemId: item.id, scrollTop: contentRef.current?.scrollTop || 0 });
            if (typeof idx === 'number' && idx >= items.length - 6) void loadMoreTabPage();
          }}
          onActivate={onClick}
          onClick={onClick}
          onCancel={handleCancel}
          onSecondaryActionDescription={item.type === 'playlist' ? 'Options' : undefined}
          onSecondaryButton={item.type === 'playlist' ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPlaylistOptions(item);
          } : undefined}
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
          onFocus={() => {
            focusedItemId.current = item.id;
            if (!subView) tabFocusPositions.current.set(activeTab, { itemId: item.id, scrollTop: contentRef.current?.scrollTop || 0 });
            if (typeof idx === 'number' && idx >= items.length - 6) void loadMoreTabPage();
          }}
            onActivate={onClick}
            onClick={onClick}
            onCancel={handleCancel}
            onSecondaryActionDescription="Options"
            onSecondaryButton={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const playlistId = subView?.type === 'tracks' && subView.queueLabel === 'Play Playlist' ? subView.id : undefined;
              openTrackOptions(trackInfo, playlistId);
            }}
            style={rowStyle}
          >
            {rowDetails}
        </Focusable>
      );
    }
    return (
      <Focusable key={item.id} ref={idx === 0 ? firstItemRef : undefined} data-browser-item-id={item.id}
        onFocus={() => {
          focusedItemId.current = item.id;
          if (!subView) tabFocusPositions.current.set(activeTab, { itemId: item.id, scrollTop: contentRef.current?.scrollTop || 0 });
        }} onActivate={onClick} onClick={onClick}
        onCancel={handleCancel}
        onSecondaryActionDescription={item.type === 'playlist' ? 'Options' : undefined}
        onSecondaryButton={item.type === 'playlist' ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPlaylistOptions(item);
        } : undefined}
        style={rowStyle}>
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
            <Button key={`play-collection-${focusTreeVersion}`} ref={playCollectionRef} onClick={handlePlayCollection} onCancelButton={handleCancel} disabled={loading}>
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
              <Focusable flow-children="geometric" onCancel={handleCancel} onGamepadDirection={handleGridDirection}
                onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            ) : (
              <Focusable key={`list-${activeTab}-${subView?.type || 'root'}-${subView?.id || ''}-${focusTreeVersion}`} flow-children="column" onCancel={handleCancel}
                onGamepadDirection={handleGridDirection} onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => subView?.type === 'search' ? handleSearchItemClick(item) : handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            )}
            </div>
          </PanelSectionRow>
        )}
        {loadingMore && (
          <PanelSectionRow>
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%', padding: '0.35rem 0' }}>
              <Spinner style={{ width: '18px', height: '18px', flexShrink: 0 }} />
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
    const savedPosition = tabFocusPositions.current.get(activeTab);
    enterContentPending.current = !savedPosition;
    if (savedPosition) {
      pendingFocusId.current = savedPosition.itemId;
      pendingScrollTop.current = savedPosition.scrollTop;
      setRestoreFocusTick(value => value + 1);
    }
    if (!loading && (items.length > 0 || activeTab === 'search')) {
      if (!savedPosition) {
        enterContentPending.current = false;
        if (activeTab === 'search') contentRef.current?.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
        else firstItemRef.current?.focus();
      }
    }
  };

  return (
    <Focusable onCancel={handleCancel} style={{ display: 'contents' }}>
    <div
      onFocusCapture={(event) => {
        focusZone.current = event.target instanceof HTMLElement && event.target.closest('[data-browser-zone="sidebar"]') ? 'sidebar' : 'content';
        if (focusZone.current === 'content' && event.target instanceof HTMLElement) {
          keepFocusedElementVisible(event.target);
        }
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
                selectTab(tabKeys[idx]);
              }}
              onActivate={enterContent}
              onClick={enterContent}
              style={{ display: 'flex', alignSelf: 'stretch', width: '100%', height: '42px', minHeight: '42px', boxSizing: 'border-box', alignItems: 'center', gap: '0.55rem', padding: '0 0.65rem', marginBottom: '0.3rem', border: `1px solid ${activeTab === tabKeys[idx] ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'}`, background: activeTab === tabKeys[idx] ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)', borderRadius: '4px', whiteSpace: 'nowrap' }}
            >
              <span style={{ display: 'inline-flex', width: '1.1rem', justifyContent: 'center', flexShrink: 0 }}>{config.icon}</span>
              <span style={{ fontWeight: 400 }}>{config.title}</span>
            </Focusable>
          ))}
        </Focusable>
      </div>
        <div data-browser-zone="content" ref={contentRef} style={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', overflowY: 'auto', padding: '0.75rem 0.5rem 150px 0', boxSizing: 'border-box', scrollPaddingBottom: '150px' }}>
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
  const changeColumns = (next: number) => {
    const value = Math.max(3, Math.min(8, next));
    setColumns(value);
    onPreview(value);
  };
  const handleDirection = (event: import('@decky/ui').GamepadEvent) => {
    if (event.detail.button === GamepadButton.DIR_LEFT) {
      event.preventDefault();
      changeColumns(columns - 1);
    } else if (event.detail.button === GamepadButton.DIR_RIGHT) {
      event.preventDefault();
      changeColumns(columns + 1);
    }
  };
  return (
    <ModalRoot closeModal={onClose} onCancel={onClose} onOK={onClose}>
      <PanelSection title="Choose grid width">
        <PanelSectionRow>
          <Focusable
            flow-children="horizontal"
            onGamepadDirection={handleDirection}
            onActivate={onClose}
            onClick={onClose}
            role="slider"
            aria-label="Grid columns"
            aria-valuemin={3}
            aria-valuemax={8}
            aria-valuenow={columns}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                changeColumns(columns + (event.key === 'ArrowRight' ? 1 : -1));
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClose();
              }
            }}
            style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: '4px', background: 'rgba(255,255,255,0.06)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
              <span>Grid columns</span><strong>{columns}</strong>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '0.28rem' }}>
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} style={{ height: '0.45rem', borderRadius: '3px', background: index < columns - 2 ? '#66c0f4' : 'rgba(255,255,255,0.2)' }} />
              ))}
            </div>
          </Focusable>
        </PanelSectionRow>
        <PanelSectionRow>
          <DialogBodyText style={{ opacity: 0.7 }}>Use left and right to adjust. Press A to save; B closes.</DialogBodyText>
        </PanelSectionRow>
      </PanelSection>
    </ModalRoot>
  );
}

function PlaylistOptionsDialog({ playlist, onDeleted, onClose }: {
  playlist: LibraryItem;
  onDeleted: (playlistId: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const confirmDelete = () => {
    let confirmation: { Close: () => void } | null = null;
    const closeConfirmation = () => confirmation?.Close();
    const deletePlaylist = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const result: any = await call('delete_audio_playlist', playlist.id);
        if (!result?.success) throw new Error(result?.error || 'Could not delete playlist.');
        closeConfirmation();
        onDeleted(playlist.id);
      } catch (error: any) {
        setMessage(error?.message || 'Could not delete playlist.');
        closeConfirmation();
      } finally {
        setBusy(false);
      }
    };
    confirmation = showModal(
      <ConfirmModal
        strTitle="Delete Playlist"
        strDescription={`Delete “${playlist.title}”? This cannot be undone.`}
        strOKButtonText="Delete Playlist"
        strCancelButtonText="Keep Playlist"
        bAlertDialog
        bDestructiveWarning
        onOK={() => { void deletePlaylist(); }}
        onCancel={closeConfirmation}
        closeModal={closeConfirmation}
      />,
      window,
      { strTitle: 'Delete Playlist', bNeverPopOut: true },
    );
  };

  return (
    <ModalRoot closeModal={onClose} onCancel={onClose}>
      <PanelSection title={playlist.title}>
        <PanelSectionRow><DialogBodyText>{playlist.leafCount ?? 0} tracks</DialogBodyText></PanelSectionRow>
        <PanelSectionRow>
          <Button disabled={busy} onClick={confirmDelete} onOKButton={(event) => { event.preventDefault(); confirmDelete(); }}>
            {busy ? 'Deleting…' : 'Delete Playlist'}
          </Button>
        </PanelSectionRow>
        {!!message && <PanelSectionRow><DialogBodyText style={{ color: '#ff7777' }}>{message}</DialogBodyText></PanelSectionRow>}
      </PanelSection>
    </ModalRoot>
  );
}

function TrackOptionsDialog({ track, playlistId, addToQueue, onClose }: {
  track: { id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string };
  playlistId?: string;
  addToQueue: (track: { id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string }, playNext?: boolean) => void;
  onClose: () => void;
}) {
  const [view, setView] = useState<'actions' | 'playlists' | 'new'>('actions');
  const [playlists, setPlaylists] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const playlistLoadInProgress = useRef(false);
  const playlistActionInProgress = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, loading, playlists.length]);

  const showPlaylists = async () => {
    if (playlistLoadInProgress.current) return;
    playlistLoadInProgress.current = true;
    setView('playlists');
    setLoading(true);
    setMessage('Loading playlists…');
    try {
      const result: any = await call('get_audio_playlists', 100);
      if (result?.error) throw new Error(result.error);
      setPlaylists(result?.items || []);
      setMessage('');
    } catch (error: any) {
      setMessage(error?.message || 'Could not load playlists.');
    } finally {
      playlistLoadInProgress.current = false;
      setLoading(false);
    }
  };

  const addToPlaylist = async (playlistId: string) => {
    if (playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      const result: any = await call('add_track_to_playlist', playlistId, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not add track to playlist.');
      setMessage(`Added to ${result.playlist || 'playlist'}.`);
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not add track to playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const createPlaylist = async () => {
    if (playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      const result: any = await call('create_audio_playlist', playlistName, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not create playlist.');
      setMessage(`Created ${result.playlist || playlistName} and added this song.`);
      setPlaylists(items => [{ id: result.id, key: '', title: result.playlist || playlistName, type: 'playlist' }, ...items]);
      setView('playlists');
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId: result.id } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not create playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const removeFromPlaylist = async () => {
    if (!playlistId || playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      const result: any = await call('remove_track_from_playlist', playlistId, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not remove track from playlist.');
      setMessage(`Removed from ${result.playlist || 'playlist'}.`);
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
    } catch (error: any) {
      setMessage(error?.message || 'Could not remove track from playlist.');
    } finally {
      playlistActionInProgress.current = false;
      setBusy(false);
    }
  };

  const handleDialogCancel = () => {
    if (busy) return;
    if (view === 'new') {
      setMessage('');
      setView('playlists');
    } else if (view === 'playlists') {
      setView('actions');
    } else {
      onClose();
    }
  };

  return (
    <ModalRoot closeModal={onClose} onCancel={handleDialogCancel}>
      <div ref={menuRef}>
      <PanelSection key={view} title={view === 'actions' ? track.title : view === 'new' ? 'New Playlist' : 'Add to Playlist'}>
        <PanelSectionRow><DialogBodyText>{track.artist}{track.album ? ` · ${track.album}` : ''}</DialogBodyText></PanelSectionRow>
        {view === 'actions' && <>
          <PanelSectionRow><Button onClick={() => { addToQueue(track, true); onClose(); }}>Play Next</Button></PanelSectionRow>
          <PanelSectionRow><Button onClick={() => { addToQueue(track); onClose(); }}>Add to Queue</Button></PanelSectionRow>
          <PanelSectionRow><Button onClick={() => void showPlaylists()} onOKButton={(event) => { event.preventDefault(); void showPlaylists(); }}>Add to Playlist</Button></PanelSectionRow>
          {playlistId && <PanelSectionRow><Button disabled={busy} onClick={() => void removeFromPlaylist()} onOKButton={(event) => { event.preventDefault(); void removeFromPlaylist(); }}>Remove from Playlist</Button></PanelSectionRow>}
        </>}
        {view === 'playlists' && <>
          {loading && <PanelSectionRow><DialogBodyText style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Spinner style={{ width: '18px', height: '18px' }} /> Loading playlists…</DialogBodyText></PanelSectionRow>}
          {!loading && playlists.length === 0 && !message && <PanelSectionRow><DialogBodyText>No audio playlists yet. Create one for this song.</DialogBodyText></PanelSectionRow>}
          {!loading && playlists.map(playlist => <PanelSectionRow key={playlist.id}><Button disabled={busy} onClick={() => void addToPlaylist(playlist.id)} onOKButton={(event) => { event.preventDefault(); void addToPlaylist(playlist.id); }}>{playlist.title}</Button></PanelSectionRow>)}
          {!loading && <PanelSectionRow><Button disabled={busy} onClick={() => { setPlaylistName(''); setMessage(''); setView('new'); }} onOKButton={(event) => { event.preventDefault(); setPlaylistName(''); setMessage(''); setView('new'); }}>New Playlist</Button></PanelSectionRow>}
        </>}
        {view === 'new' && <>
          <PanelSectionRow><TextField label="Playlist name" value={playlistName} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPlaylistName(e.target.value)} /></PanelSectionRow>
          <PanelSectionRow><Button disabled={busy || !playlistName.trim()} onClick={() => void createPlaylist()} onOKButton={(event) => { event.preventDefault(); void createPlaylist(); }}>{busy ? 'Creating…' : 'Create Playlist'}</Button></PanelSectionRow>
        </>}
        {!!message && <PanelSectionRow><DialogBodyText style={{ color: /^(Added to|Created|Removed from)/.test(message) ? '#78d99a' : '#ff7777' }}>{message}</DialogBodyText></PanelSectionRow>}
      </PanelSection>
      </div>
    </ModalRoot>
  );
}
