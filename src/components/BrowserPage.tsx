import { Fragment, memo, useState, useEffect, useCallback, useRef, type CSSProperties } from 'react';
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
  Navigation,
  GamepadButton,
  showModal,
  type GamepadEvent,
} from '@decky/ui';
import { call, toaster } from '@decky/api';
import {
  FaSearch, FaMusic, FaCompactDisc, FaUser, FaHistory, FaListUl, FaPlay, FaFilm, FaImage, FaHome, FaBars,
  FaStepForward, FaListOl, FaPlus, FaMinus,
  FaSortAlphaDown, FaSortAlphaUp, FaClock, FaCalendarAlt, FaTrash, FaArrowLeft,
} from 'react-icons/fa';
import { usePlayer } from '../context/PlayerContext';
import { InlineSpinner } from './InlineSpinner';
import { gamePipFullscreenEvent, getEpisodeQueue, queueGamePipEpisodeNext, stopGamePip, takeGamePipFullscreen,
  useGamePipEpisodeQueue, videoProgressEvent, type VideoItem, type VideoResume } from './GamePip';
import { MediaViewer, type VideoPresentation } from './MediaViewer';
import { showPlaybackStartDialog } from './PlaybackStartDialog';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { FocusOutlineStyles, focusOutlineProps } from './FocusOutline';
import { collectionResumes, episodeLabel, insertNextEpisode, queueFromEpisode, resumeEpisode, resumePosition } from './VideoQueue';

interface LibraryItem {
  id: string;
  key: string;
  title: string;
  titleSort?: string;
  type: string;
  thumb?: string;
  poster?: string;
  gridThumb?: string;
  gridPoster?: string;
  art?: string;
  summary?: string;
  artist?: string;
  year?: number;
  index?: number;
  parentIndex?: number;
  parentTitle?: string;
  grandparentTitle?: string;
  leafCount?: number;
  viewCount?: number;
  viewOffset?: number;
  duration?: number;
  sectionId?: string;
}

type LibraryTab = `library:${string}`;
type BrowserTab = 'artists' | 'albums' | 'tracks' | 'recent' | 'recentlyAdded' | 'playlists' | 'search' | 'videoHome' | LibraryTab;
type BrowserSubView = { type: 'albums' | 'tracks' | 'search' | 'media'; title: string; id?: string; queueLabel?: string; mediaType?: string } | null;
interface LibrarySection { id: string; name: string; type: string; }
interface ItemCacheEntry { expiresAt: number; items: LibraryItem[]; hasMore?: boolean; nextOffset?: number; }

function sectionForTab(tab: BrowserTab) {
  return tab.startsWith('library:') ? tab.slice('library:'.length) : '';
}

interface BrowserHistoryEntry {
  items: LibraryItem[];
  subView: BrowserSubView;
  focusedItemId?: string;
  scrollTop: number;
  hasMore: boolean;
}
interface TabFocusPosition { itemId: string; scrollTop: number; }

const browserHeaderStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '0.5rem', height: '2.65rem',
  paddingInline: '0.35rem', marginBottom: '0.5rem', boxSizing: 'border-box',
};
const browserHeaderScrollMargin = `calc(${browserHeaderStyle.height} + ${browserHeaderStyle.marginBottom} + 0.5rem)`;
const DEFAULT_GRID_COLUMNS = 6;
const BROWSER_FOOTER_CLEARANCE = 150;
const ALPHABET_HOLD_DELAY = 450;
const PAGE_SIZE = 36;
const LIBRARY_CACHE_TTL = 600000;
const VIDEO_HOME_ROWS = [
  { id: 'continue', title: 'Continue Watching', ttl: 15000 },
  { id: 'next', title: 'Watch Next', ttl: 15000 },
  { id: 'movies', title: 'Recently Added Movies', ttl: 60000 },
  { id: 'shows', title: 'Recently Added TV', ttl: 60000 },
  { id: 'watchlist', title: 'Watchlist', ttl: 60000 },
] as const;
const VIDEO_SORTS = [
  { id: 'titleSort:asc', title: 'Title A–Z', Icon: FaSortAlphaDown },
  { id: 'titleSort:desc', title: 'Title Z–A', Icon: FaSortAlphaUp },
  { id: 'addedAt:desc', title: 'Recently added', Icon: FaClock },
  { id: 'originallyAvailableAt:desc', title: 'Newest release', Icon: FaCalendarAlt },
];

function alphabetGroup(title: string) {
  const initial = title.trimStart().normalize('NFD').replace(/^\p{M}+/u, '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(initial) ? initial : '#';
}
type VideoHomeRow = typeof VIDEO_HOME_ROWS[number]['id'];
type VideoHomeData = Partial<Record<VideoHomeRow, { items: LibraryItem[]; error?: string }>>;

export function BrowserPage() {
  const { playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteMode, remoteTargetSelected, remotePlayerName,
    addToQueue, playbackState, pause, localVolume } = usePlayer();
  return <LibraryBrowser {...{ playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteTargetSelected, remotePlayerName,
    addToQueue, pause, localVolume }} localMusicPlaying={!remoteMode && playbackState === 'playing'} />;
}

type BrowserPlayback = Pick<ReturnType<typeof usePlayer>, 'playTrack' | 'readMusicPlaybackTarget' | 'playRemoteQueue' | 'beginPlaybackRequest'
  | 'remoteTargetSelected' | 'remotePlayerName' | 'addToQueue' | 'pause' | 'localVolume'> & { localMusicPlaying: boolean };
const LibraryBrowser = memo(function LibraryBrowser({
  playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest, remoteTargetSelected, remotePlayerName, addToQueue, localMusicPlaying, pause, localVolume,
}: BrowserPlayback) {
  const pipEpisodeQueue = useGamePipEpisodeQueue();
  const [activeTab, setActiveTab] = useState<BrowserTab>('artists');
  const activeTabRef = useRef<BrowserTab>(activeTab);
  activeTabRef.current = activeTab;
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [playbackRequests, setPlaybackRequests] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState('');
  const [tabHasMore, setTabHasMore] = useState(false);
  const [focusTreeVersion, setFocusTreeVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSection, setSelectedSection] = useState<string>('');
  const [libraries, setLibraries] = useState<LibrarySection[]>([]);
  const [homeData, setHomeData] = useState<VideoHomeData>({});
  const [videoSorts, setVideoSorts] = useState<Record<string, string>>({});
  const [loadingLibraries, setLoadingLibraries] = useState(false);
  const [showAllMedia, setShowAllMedia] = useState(false);
  const [overGamePip, setOverGamePip] = useState(false);
  const [librarySelectionKey, setLibrarySelectionKey] = useState('');
  const [serverId, setServerId] = useState('');
  const [checkingConnection, setCheckingConnection] = useState(true);
  const connected = !!serverId;
  const [subView, setSubView] = useState<BrowserSubView>(null);
  const collectionRequest = useRef<{ key: string; episodes: Promise<VideoItem[]> } | null>(null);
  const [viewerItem, setViewerItem] = useState<LibraryItem | null>(null);
  const [viewerResume, setViewerResume] = useState<VideoResume | null>(null);
  const [viewerPresentation, setViewerPresentation] = useState<VideoPresentation | null>(null);
  const [viewerStartPosition, setViewerStartPosition] = useState<number | undefined>();
  const [viewerQueue, setViewerQueueState] = useState<VideoItem[] | null>(null);
  const latestViewerQueue = useRef<VideoItem[] | null>(null);
  const setViewerQueue = useCallback((value: React.SetStateAction<VideoItem[] | null>) => {
    const queue = typeof value === 'function' ? value(latestViewerQueue.current) : value;
    latestViewerQueue.current = queue;
    setViewerQueueState(queue);
  }, []);
  const viewerExpanded = !!viewerItem;
  const combinedArtists = libraries.filter(library => library.type === 'artist').length > 1;
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [gridColumns, setGridColumns] = useState(DEFAULT_GRID_COLUMNS);
  const [gridPreferenceSet, setGridPreferenceSet] = useState(false);
  const [restoreFocusTick, setRestoreFocusTick] = useState(0);
  const itemCache = useRef(new Map<string, ItemCacheEntry>());
  const pendingItems = useRef(new Map<string, Promise<any>>());
  const firstItemRef = useRef<HTMLDivElement | null>(null);
  const sortButtonRef = useRef<HTMLDivElement | null>(null);
  const playCollectionRef = useRef<HTMLDivElement | null>(null);
  const lastCollectionItem = useRef<HTMLElement | null>(null);
  const gridDialogRef = useRef<{ Close: () => void } | null>(null);
  const gridPromptShown = useRef(false);
  const actionDialogRef = useRef<{ Close: () => void } | null>(null);
  const focusZone = useRef<'sidebar' | 'content'>('sidebar');
  const browserRef = useRef<HTMLDivElement | null>(null);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const moreItemsRef = useRef<HTMLDivElement | null>(null);
  const focusScrollFrame = useRef(0);
  const fastVerticalNavigation = useRef(false);
  const contentScrollAnimation = useRef<{ top: number; frame: number } | null>(null);
  const alphabetOverlayRef = useRef<HTMLDivElement | null>(null);
  const alphabetHold = useRef<{ button: GamepadButton; item: HTMLElement; timer: number | null } | null>(null);
  const searchFormRef = useRef<HTMLDivElement | null>(null);
  const focusedItemId = useRef<string | undefined>(undefined);
  const pendingFocusId = useRef<string | undefined>(undefined);
  const pendingSortFocus = useRef<{ tab: BrowserTab; sort: string; ready: boolean } | null>(null);
  const pendingScrollTop = useRef<number | undefined>(undefined);
  const tabFocusPositions = useRef(new Map<BrowserTab, TabFocusPosition>());
  const pendingSearchFocus = useRef(false);
  const pendingSearchInputFocus = useRef(false);
  const loadingMoreRef = useRef(false);
  const tabLoadRequestId = useRef(0);
  const restoringHistoryRef = useRef(false);
  const enterContentPending = useRef(false);
  const viewerOrigin = useRef<{ itemId?: string; scrollTop: number }>({ scrollTop: 0 });

  const cancelContentScroll = useCallback(() => {
    if (contentScrollAnimation.current) window.cancelAnimationFrame(contentScrollAnimation.current.frame);
    contentScrollAnimation.current = null;
  }, []);

  const hideAlphabetOverlay = useCallback(() => {
    const hold = alphabetHold.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    alphabetHold.current = null;
    const overlay = alphabetOverlayRef.current;
    if (overlay && !overlay.hidden) overlay.hidden = true;
  }, []);

  const updateAlphabetOverlay = useCallback((item: HTMLElement) => {
    const hold = alphabetHold.current;
    if (!hold) return;
    const overlay = alphabetOverlayRef.current;
    const title = item.dataset.browserSortTitle;
    if (!title || !contentRef.current?.contains(item)) {
      hideAlphabetOverlay();
      return;
    }
    hold.item = item;
    if (!overlay || hold.timer != null) return;
    const label = alphabetGroup(title);
    if (overlay.textContent !== label) overlay.textContent = label;
    overlay.hidden = false;
  }, [hideAlphabetOverlay]);

  const invalidateTabLoad = useCallback(() => {
    cancelContentScroll();
    hideAlphabetOverlay();
    loadingMoreRef.current = false;
    lastCollectionItem.current = null;
    setLoadingMore(false);
    setPaginationError('');
    return ++tabLoadRequestId.current;
  }, [cancelContentScroll, hideAlphabetOverlay]);

  const selectTab = useCallback((tab: BrowserTab) => {
    if (tab === activeTabRef.current) return;
    activeTabRef.current = tab;
    // Invalidate outstanding root and pagination requests synchronously when
    // focus moves between categories. The effect below then loads only the new tab.
    invalidateTabLoad();
    pendingSortFocus.current = null;
    enterContentPending.current = false;
    pendingSearchFocus.current = false;
    pendingSearchInputFocus.current = false;
    setItems([]);
    setTabHasMore(false);
    setError(null);
    setLoading(tab !== 'search');
    setActiveTab(tab);
  }, [invalidateTabLoad]);

  const openSearch = useCallback(() => {
    if (activeTabRef.current !== 'search') {
      selectTab('search');
    } else if (subView && subView.type !== 'search') {
      invalidateTabLoad();
      setSubView(null);
      setHistory([]);
      setError(null);
    }
    restoringHistoryRef.current = false;
    pendingFocusId.current = undefined;
    pendingScrollTop.current = undefined;
    pendingSearchFocus.current = false;
    enterContentPending.current = false;
    pendingSearchInputFocus.current = true;
    setRestoreFocusTick(value => value + 1);
  }, [selectTab, subView, invalidateTabLoad]);

  const keepFocusedElementVisible = (element: HTMLElement, sidebar = false) => {
    cancelContentScroll();
    hideAlphabetOverlay();
    window.cancelAnimationFrame(focusScrollFrame.current);
    focusScrollFrame.current = window.requestAnimationFrame(() => {
      const viewport = sidebar ? sidebarRef.current : contentRef.current;
      if (!viewport || !viewport.contains(element) || element !== document.activeElement) return;
      const itemRect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      // Steam overlays a footer on the bottom of routed plugin views. Keep a
      // safe area for the sidebar and header controls.
      const visibleBottom = Math.min(viewportRect.bottom, window.innerHeight - (sidebar ? 110 : BROWSER_FOOTER_CLEARANCE));
      const edgePadding = 28;
      const bottomOverflow = itemRect.bottom - (visibleBottom - edgePadding);
      const topOverflow = viewportRect.top + edgePadding - itemRect.top;
      const offset = bottomOverflow > 0 ? bottomOverflow : -Math.max(0, topOverflow);
      if (offset === 0) return;
      if (sidebar) viewport.scrollTop += offset;
      else viewport.scrollBy({ top: offset, behavior: 'smooth' });
    });
  };

  useEffect(() => () => {
    window.cancelAnimationFrame(focusScrollFrame.current);
    cancelContentScroll();
  }, [cancelContentScroll]);

  const cachedItems = useCallback(async (key: string, ttlMs: number, request: () => Promise<any>) => {
    const cache = itemCache.current;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return { items: cached.items, has_more: cached.hasMore, next_offset: cached.nextOffset };
    const pending = pendingItems.current;
    const existing = pending.get(key);
    if (existing) return existing;
    const load = request().then(result => {
      if (cache === itemCache.current && Array.isArray(result?.items) && !result?.error) {
        cache.set(key, { items: result.items, hasMore: result.has_more,
          nextOffset: result.next_offset, expiresAt: Date.now() + ttlMs });
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, load);
    return load;
  }, []);

  useEffect(() => {
    if (viewerExpanded || pendingSortFocus.current || pendingSearchInputFocus.current
        || pendingFocusId.current || pendingScrollTop.current != null) return;
    const frame = window.requestAnimationFrame(() => {
      const sidebar = sidebarRef.current;
      const focused = document.activeElement;
      if (!sidebar || sidebar.contains(focused) || contentRef.current?.contains(focused)) return;
      const target = sidebar.querySelector<HTMLElement>(`[data-browser-tab="${activeTabRef.current}"]`)
        ?? sidebar.querySelector<HTMLElement>('[data-browser-tab]');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, connected, loadingLibraries, viewerExpanded]);

  useEffect(() => {
    invalidateTabLoad();
    setHistory([]);
    setSubView(null);
  }, [activeTab, invalidateTabLoad]);

  const goBack = useCallback(() => {
    const previous = history[history.length - 1];
    if (previous) {
      invalidateTabLoad();
      enterContentPending.current = false;
      pendingSearchFocus.current = false;
      setLoading(false);
      setError(null);
      restoringHistoryRef.current = previous.subView === null;
      setHistory(history.slice(0, -1));
      setItems(previous.items);
      setTabHasMore(previous.hasMore);
      setSubView(previous.subView);
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
  }, [history, activeTab, invalidateTabLoad]);

  const focusBrowserTab = (scrollTop?: number) => {
    window.requestAnimationFrame(() => {
      if (scrollTop != null && contentRef.current) contentRef.current.scrollTop = scrollTop;
      sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${activeTabRef.current}"]`)?.focus();
    });
  };

  const restoreBrowserFocus = () => {
    const { itemId, scrollTop } = viewerOrigin.current;
    pendingFocusId.current = itemId;
    pendingScrollTop.current = itemId ? scrollTop : undefined;
    if (itemId) setRestoreFocusTick(value => value + 1);
    else focusBrowserTab(scrollTop);
  };

  const closeMedia = () => {
    setViewerItem(null);
    setViewerQueue(null);
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(undefined);
    restoreBrowserFocus();
  };

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
      if (event.key === 'Escape' && !viewerExpanded && !gridDialogRef.current && !actionDialogRef.current) handleCancel(event);
    };
    window.addEventListener('keydown', onBackKey, true);
    return () => window.removeEventListener('keydown', onBackKey, true);
  }, [handleCancel, viewerExpanded]);

  // Check connection status periodically
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const checkConnection = async () => {
      const id = ++requestId;
      try {
        const result: any = await call("get_settings");
        if (!active || id !== requestId) return;
        const savedColumns = Number(result.grid_columns);
        const validColumns = Number.isInteger(savedColumns) && savedColumns >= 3 && savedColumns <= 9;
        setGridPreferenceSet(validColumns);
        if (!gridDialogRef.current) {
          setGridColumns(validColumns ? savedColumns : DEFAULT_GRID_COLUMNS);
        }
        setShowAllMedia(Boolean(result.browse_all_media));
        setOverGamePip(result.over_game_pip === true);
        setLibrarySelectionKey((result.library_selection_ids || []).join(','));
        setServerId(result.has_plex_token ? result.selected_server_id || '' : '');
      } catch (e) {
        if (active && id === requestId) setServerId('');
      } finally {
        if (active && id === requestId) setCheckingConnection(false);
      }
    };
    checkConnection();
    const interval = setInterval(checkConnection, 15000);
    window.addEventListener('deckyplex-settings-change', checkConnection);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('deckyplex-settings-change', checkConnection);
    };
  }, []);

  const shelf = sectionForTab(activeTab);
  const sorting = videoSorts[shelf] || VIDEO_SORTS[0].id;
  const sortable = !subView && libraries.some(library => library.id === shelf
    && (library.type === 'movie' || library.type === 'show'));

  useEffect(() => {
    if (viewerExpanded || ((loading || loadingLibraries) && !pendingSearchInputFocus.current)
      || (!pendingSortFocus.current && focusZone.current === 'sidebar' && !enterContentPending.current
      && !pendingSearchFocus.current && !pendingSearchInputFocus.current && pendingScrollTop.current == null)) return;
    let secondFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const sortFocus = pendingSortFocus.current;
        if (sortFocus) {
          // Wait for the chosen sort's data after Steam restores focus from the modal.
          const sortedPage = itemCache.current.get(`tab:${shelf}:${activeTab}:${sorting}`);
          if (!sortFocus.ready || sortFocus.tab !== activeTab || sortFocus.sort !== sorting || actionDialogRef.current
              || (sortedPage?.items !== items && !error)) return;
          const target = firstItemRef.current ?? sortButtonRef.current;
          if (!target) return;
          pendingSortFocus.current = null;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          target.focus({ preventScroll: true });
          return;
        }
        if (pendingSearchInputFocus.current) {
          const input = searchFormRef.current?.querySelector('input');
          if (!input) return;
          pendingSearchInputFocus.current = false;
          pendingScrollTop.current = undefined;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          input.focus({ preventScroll: true });
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
          const target = firstItemRef.current ?? searchFormRef.current?.querySelector('input');
          target?.focus();
          return;
        }
        if (enterContentPending.current) {
          if (activeTab === 'videoHome' && !subView && !firstItemRef.current) return;
          if (contentRef.current) contentRef.current.scrollTop = 0;
          enterContentPending.current = false;
          if (!subView && activeTab === 'search') contentRef.current?.querySelector<HTMLElement>('input,button,[tabindex]')?.focus();
          else firstItemRef.current?.focus({ preventScroll: true });
          return;
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [loading, loadingLibraries, items, subView, activeTab, restoreFocusTick, viewerExpanded, shelf, sorting, error,
    checkingConnection, connected]);

  const saveGridColumns = useCallback(async (columns: number) => {
    const result: any = await call('set_settings', { grid_columns: columns });
    if (result?.error) throw new Error(result.error);
    setGridColumns(columns);
    setGridPreferenceSet(true);
  }, []);

  const openGridColumnsDialog = useCallback(() => {
    if (gridDialogRef.current) return;
    gridPromptShown.current = true;
    const clearDialog = () => {
      if (gridDialogRef.current === dialog) gridDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const dialog = showModal(<GridColumnsDialog initialColumns={gridColumns}
      onPreview={setGridColumns} onConfirm={saveGridColumns} onClose={close} />,
      window, { strTitle: 'Browser layout', bNeverPopOut: true, fnOnClose: clearDialog });
    gridDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [gridColumns, saveGridColumns]);

  const openTrackOptions = useCallback((track: {
    id: string; sectionId: string; title: string; artist: string; album: string; duration: number; thumb: string;
  }, playlistId?: string) => {
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const dialog = showModal(<TrackOptionsDialog track={{ ...track, sourceServerId: serverId }}
      playlistId={playlistId} addToQueue={addToQueue} onClose={close} />,
      window, { strTitle: track.title, bNeverPopOut: true, fnOnClose: clearDialog });
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [addToQueue, serverId]);

  const openPlaylistOptions = useCallback((playlist: LibraryItem) => {
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = () => { clearDialog(); dialog.Close(); };
    const handleDeleted = (playlistId: string) => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      itemCache.current.delete(`playlist:${playlistId}`);
      setItems(current => current.filter(item => item.id !== playlistId));
      window.dispatchEvent(new CustomEvent('deckyplex-playlists-change', { detail: { playlistId } }));
      close();
    };
    const dialog = showModal(<PlaylistOptionsDialog playlist={playlist} onDeleted={handleDeleted} onClose={close} />,
      window, { strTitle: playlist.title, bNeverPopOut: true, fnOnClose: clearDialog });
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  }, [selectedSection]);

  useEffect(() => {
    if (!connected || gridPreferenceSet || gridPromptShown.current) return;
    const timer = window.setTimeout(openGridColumnsDialog, 300);
    return () => window.clearTimeout(timer);
  }, [connected, gridPreferenceSet, openGridColumnsDialog]);

  useEffect(() => {
    setViewerItem(null);
    setViewerQueue(null);
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(undefined);
    if (!serverId) {
      setSelectedSection('');
      setLibraries([]);
      setLoadingLibraries(false);
      return;
    }
    let active = true;
    invalidateTabLoad();
    setSelectedSection('');
    setLibraries([]);
    setHomeData({});
    setVideoSorts({});
    setItems([]);
    setSubView(null);
    setHistory([]);
    itemCache.current = new Map();
    pendingItems.current = new Map();
    tabFocusPositions.current.clear();
    restoringHistoryRef.current = false;
    selectTab('artists');
    setLoadingLibraries(true);
    setError(null);
    void call<[boolean], { sections?: LibrarySection[]; error?: string }>('get_library_sections', showAllMedia)
      .then(result => {
        if (!active) return;
        if (result?.error) throw new Error(result.error);
        if (!result?.sections?.length) throw new Error('No selected Plex libraries were found. Check Settings › Server.');
        setSelectedSection(result.sections.find(section => section.type === 'artist')?.id || '');
        setLibraries(result.sections);
        const firstMediaLibrary = result.sections.find(section => section.type !== 'artist');
        if (firstMediaLibrary && !result.sections.some(section => section.type === 'artist') && activeTabRef.current === 'artists') {
          const tab: BrowserTab = result.sections.some(section => section.type === 'movie' || section.type === 'show')
            ? 'videoHome' : `library:${firstMediaLibrary.id}`;
          selectTab(tab);
          window.requestAnimationFrame(() => {
            if (active && focusZone.current === 'sidebar' && activeTabRef.current === tab) {
              sidebarRef.current?.querySelector<HTMLElement>(`[data-browser-tab="${tab}"]`)?.focus();
            }
          });
        }
      })
      .catch(error => {
        if (!active) return;
        setLoading(false);
        setError(error instanceof Error ? error.message : 'Could not load Plex libraries.');
      })
      .finally(() => { if (active) setLoadingLibraries(false); });
    return () => { active = false; };
  }, [serverId, showAllMedia, librarySelectionKey, invalidateTabLoad]);

  useEffect(() => {
    if (!serverId) return;
    const restoreVideo = () => {
      const resume = takeGamePipFullscreen(serverId);
      if (!resume) return;
      viewerOrigin.current = { scrollTop: contentRef.current?.scrollTop || 0 };
      setViewerQueue(resume.episodes?.length ? resume.episodes : null);
      setViewerResume(resume);
      setViewerPresentation(null);
      setViewerStartPosition(undefined);
      setViewerItem(resume.item);
    };
    window.addEventListener(gamePipFullscreenEvent, restoreVideo);
    restoreVideo();
    return () => window.removeEventListener(gamePipFullscreenEvent, restoreVideo);
  }, [serverId]);

  useEffect(() => {
    if (viewerItem?.type !== 'episode' || !serverId) return;
    if (viewerQueue) return;
    let active = true;
    void getEpisodeQueue(viewerItem.id, serverId).then(episodes => {
      if (active && episodes?.length) {
        const upcoming = queueFromEpisode(episodes, viewerItem.id);
        if (!upcoming.length) return;
        setViewerQueue(previous => previous ?? upcoming);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [viewerItem, viewerQueue, serverId]);

  const openSortMenu = (event?: GamepadEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (!sortable || actionDialogRef.current) return;
    const clearDialog = () => {
      if (actionDialogRef.current === dialog) actionDialogRef.current = null;
    };
    const close = (sort?: string) => {
      if (actionDialogRef.current !== dialog) return;
      actionDialogRef.current = null;
      dialog.Close();
      if (!sort || activeTabRef.current !== activeTab) return;
      tabFocusPositions.current.delete(activeTab);
      pendingFocusId.current = undefined;
      pendingScrollTop.current = undefined;
      enterContentPending.current = false;
      pendingSortFocus.current = { tab: activeTab, sort, ready: sort === sorting };
      if (sort !== sorting) {
        invalidateTabLoad();
        setVideoSorts(current => ({ ...current, [shelf]: sort }));
      }
      setRestoreFocusTick(value => value + 1);
    };
    const dialog = showModal(
      <ModalRoot closeModal={() => close()} onCancel={() => close()} onOK={() => {}}>
        <ChoiceDialogBody title="Sort by">
          <ChoiceDialogList>
            {VIDEO_SORTS.map(({ id, title, Icon }) => (
              <ChoiceDialogRow key={id} title={title} icon={<Icon />} preferredFocus={id === sorting}
                selected={id === sorting} badge={id === sorting ? 'Selected' : undefined} onChoose={() => close(id)} />
            ))}
          </ChoiceDialogList>
        </ChoiceDialogBody>
      </ModalRoot>, window, { strTitle: 'Sort library', bNeverPopOut: true, fnOnClose: clearDialog },
    );
    actionDialogRef.current = dialog;
    void dialog.ClosedPromise?.then(clearDialog, clearDialog);
  };

  useEffect(() => {
    if (!connected || loadingLibraries || subView || activeTab !== 'videoHome') return;
    let active = true;
    const rows: VideoHomeData = {};
    const hasMovies = libraries.some(library => library.type === 'movie');
    const hasTV = libraries.some(library => library.type === 'show');
    if (!hasMovies) rows.movies = { items: [] };
    if (!hasTV) rows.shows = { items: [] };
    setLoading(false);
    const loadRow = (row: typeof VIDEO_HOME_ROWS[number]) => {
      void cachedItems(`video-home:${row.id}`, row.ttl,
        () => call('get_video_home', row.id)).then(result => {
        if (!active) return;
        const items: LibraryItem[] = result?.items || [];
        if (row.id === 'continue') {
          const next = (item: LibraryItem) => item.type === 'episode' && !item.viewOffset;
          rows.next = { items: items.filter(next) };
          rows.continue = { items: items.filter(item => !next(item)), error: result?.error };
        } else rows[row.id] = { items, error: result?.error };
      }).catch(() => {
        if (active) rows[row.id] = { items: [], error: 'Could not load this section.' };
        if (active && row.id === 'continue') rows.next = { items: [] };
      }).finally(() => {
        if (!active) return;
        setHomeData({ ...rows });
        setItems(VIDEO_HOME_ROWS.flatMap(entry => rows[entry.id]?.items || []));
      });
    };
    setHomeData({ ...rows });
    for (const row of VIDEO_HOME_ROWS) {
      if (row.id !== 'next' && !rows[row.id]) loadRow(row);
    }
    const refreshContinueWatching = () => {
      const refresh = () => {
        if (!active) return;
        itemCache.current.delete('video-home:continue');
        loadRow(VIDEO_HOME_ROWS[0]);
      };
      const pending = pendingItems.current.get('video-home:continue');
      if (pending) void pending.then(refresh, refresh);
      else refresh();
    };
    window.addEventListener(videoProgressEvent, refreshContinueWatching);
    return () => {
      active = false;
      window.removeEventListener(videoProgressEvent, refreshContinueWatching);
    };
  }, [activeTab, connected, libraries, loadingLibraries, subView, cachedItems]);

  // Load data when tab changes
  useEffect(() => {
    if (!connected || loadingLibraries || subView) return;
    if (restoringHistoryRef.current) {
      restoringHistoryRef.current = false;
      return;
    }
    if (activeTab === 'videoHome') return;
    if (activeTab === 'search') {
      invalidateTabLoad();
      setLoading(false);
      setTabHasMore(false);
      setItems([]);
      return;
    }
    const libraryId = sectionForTab(activeTab);
    if (libraryId ? libraries.some(library => library.id === libraryId) : selectedSection) loadTabData(activeTab);
  }, [activeTab, connected, selectedSection, libraries, loadingLibraries, subView, sorting, invalidateTabLoad]);

  const loadTabData = useCallback(async (tab: BrowserTab) => {
    const requestId = invalidateTabLoad();
    setError(null);
    const libraryId = sectionForTab(tab);
    const cacheKey = `tab:${libraryId || selectedSection}:${tab}${libraryId ? `:${sorting}` : ''}`;
    const finishSortFocus = () => {
      const focus = pendingSortFocus.current;
      if (focus?.tab === tab && focus.sort === sorting && !focus.ready) {
        focus.ready = true;
        setRestoreFocusTick(value => value + 1);
      }
    };
    const cached = itemCache.current.get(cacheKey);
    const expectedTypes: Partial<Record<BrowserTab, string[]>> = {
      artists: ['artist'], albums: ['album'], tracks: ['track'], recent: ['track'],
      recentlyAdded: ['album'], playlists: ['playlist'],
    };
    const cachedTabItems = cached && expectedTypes[tab]
      ? cached.items.filter(item => expectedTypes[tab]?.includes(item.type))
      : cached?.items;
    const cacheIsFresh = !!cached && cached.expiresAt > Date.now();
    const ttl = tab === 'recent' ? 15000 : tab === 'playlists' ? 60000 : LIBRARY_CACHE_TTL;
    if (cached) {
      setItems(cachedTabItems || []);
      setTabHasMore(Boolean(cached.hasMore));
    } else {
      setItems([]);
      setTabHasMore(false);
    }
    setLoading(!cached);
    if (cacheIsFresh) {
      finishSortFocus();
      return;
    }
    try {
      let result: any;
      if (libraryId) {
        result = await cachedItems(cacheKey, ttl, () => call('get_section_contents', libraryId, '', PAGE_SIZE, 0, sorting));
      } else if (tab === 'artists' && combinedArtists) {
        result = await cachedItems(cacheKey, ttl, () => call('get_music_artists', PAGE_SIZE, 0));
      } else if (tab === 'recent') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_played', selectedSection, 100));
      } else if (tab === 'recentlyAdded') {
        result = await cachedItems(cacheKey, ttl, () => call('get_recently_added', selectedSection, 100));
      } else if (tab === 'playlists') {
        result = await cachedItems(cacheKey, ttl, () => call('get_audio_playlists', 100));
      } else {
        const typeFilter = tab === 'artists' ? 'artist' : tab === 'albums' ? 'album' : 'track';
        result = await cachedItems(cacheKey, ttl, () => call("get_section_contents", selectedSection, typeFilter, PAGE_SIZE, 0));
      }
      if (requestId !== tabLoadRequestId.current) return;
      if (libraryId || tab === 'artists' || tab === 'albums' || tab === 'tracks') setTabHasMore(Boolean(result.has_more));
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
        const ids = new Set(tabItems.map((item: LibraryItem) => item.id));
        const keepMusicPages = cached && !libraryId && cached.hasMore && (cachedTabItems?.length || 0) > tabItems.length;
        const displayedItems = keepMusicPages
          ? [...tabItems, ...(cachedTabItems || []).filter(item => !ids.has(item.id))]
          : tabItems;
        setItems(displayedItems);
        itemCache.current.set(cacheKey, {
          items: displayedItems,
          hasMore: Boolean(result.has_more),
          nextOffset: keepMusicPages ? cached.nextOffset ?? displayedItems.length : result.next_offset ?? result.items.length,
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
      if (requestId === tabLoadRequestId.current) {
        setLoading(false);
        finishSortFocus();
      }
    }
  }, [selectedSection, combinedArtists, sorting, cachedItems]);

  useEffect(() => {
    const refreshPlaylists = () => {
      itemCache.current.delete(`tab:${selectedSection}:playlists`);
      if (activeTab === 'playlists' && !subView) void loadTabData('playlists');
    };
    window.addEventListener('deckyplex-playlists-change', refreshPlaylists);
    return () => window.removeEventListener('deckyplex-playlists-change', refreshPlaylists);
  }, [selectedSection, activeTab, subView, loadTabData]);

  const loadMoreTabPage = useCallback(async () => {
    const mediaLibrary = sectionForTab(activeTab);
    const section = mediaLibrary || selectedSection;
    if (!tabHasMore || loadingMoreRef.current || !section || subView
      || (!mediaLibrary && !['artists', 'albums', 'tracks'].includes(activeTab))) return;
    const requestId = tabLoadRequestId.current;
    const requestedTab = activeTab;
    loadingMoreRef.current = true;
    setPaginationError('');
    setLoadingMore(true);
    try {
      const typeFilter = mediaLibrary ? '' : activeTab === 'artists' ? 'artist' : activeTab === 'albums' ? 'album' : 'track';
      const baseKey = `tab:${section}:${activeTab}${mediaLibrary ? `:${sorting}` : ''}`;
      const offset = itemCache.current.get(baseKey)?.nextOffset ?? items.length;
      const cacheKey = `${baseKey}:${offset}`;
      const result: any = await cachedItems(cacheKey, LIBRARY_CACHE_TTL,
        () => activeTab === 'artists' && combinedArtists
          ? call('get_music_artists', PAGE_SIZE, offset)
          : call('get_section_contents', section, typeFilter, PAGE_SIZE, offset, sorting));
      if (requestId !== tabLoadRequestId.current || requestedTab !== activeTab) return;
      if (result.error) {
        setPaginationError('Could not load more library items.');
        return;
      }
      const nextPage: LibraryItem[] = Array.isArray(result.items) ? result.items : [];
      const existing = new Set(items.map(item => item.id));
      const mergedItems = [...items, ...nextPage.filter(item => !existing.has(item.id))];
      const nextOffset = result.next_offset ?? offset + nextPage.length;
      const hasMore = Boolean(result.has_more) && nextOffset > offset;
      setItems(mergedItems);
      setTabHasMore(hasMore);
      itemCache.current.set(baseKey, {
        items: mergedItems,
        hasMore,
        nextOffset,
        expiresAt: Date.now() + LIBRARY_CACHE_TTL,
      });
    } catch (e) {
      if (requestId === tabLoadRequestId.current && requestedTab === activeTab) setPaginationError('Could not load more library items.');
    } finally {
      if (requestId === tabLoadRequestId.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [tabHasMore, selectedSection, combinedArtists, subView, activeTab, items.length, sorting, cachedItems]);

  // Keep the current page boundary available without restarting the held-input
  // listener when pagination appends rows.
  const nextPageAtBoundary = useRef<{ itemCount: number; load: typeof loadMoreTabPage } | null>(null);
  nextPageAtBoundary.current = !subView && tabHasMore && !paginationError
    ? { itemCount: items.length, load: loadMoreTabPage } : null;

  useEffect(() => {
    const viewport = contentRef.current;
    const target = moreItemsRef.current;
    if (!viewport || !target || !tabHasMore || loading || loadingMore || paginationError || viewerExpanded) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreTabPage();
    }, { root: viewport, rootMargin: '0px 0px 160px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [tabHasMore, loading, loadingMore, paginationError, loadMoreTabPage, viewerExpanded]);

  const loadAlbums = useCallback(async (artistId: string, artistName?: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
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
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const loadPlaylistTracks = useCallback(async (playlistId: string, playlistName: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
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
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  useEffect(() => {
    const refreshVisiblePlaylist = (event: Event) => {
      const playlistId = (event as CustomEvent<{ playlistId?: string }>).detail?.playlistId;
      if (!playlistId) return;
      itemCache.current.delete(`playlist:${playlistId}`);
      if (subView?.type !== 'tracks' || subView.queueLabel !== 'Play Playlist' || subView.id !== playlistId) return;
      const requestId = invalidateTabLoad();
      pendingFocusId.current = focusedItemId.current;
      pendingScrollTop.current = contentRef.current?.scrollTop;
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
  }, [subView, invalidateTabLoad]);

  const loadTracks = useCallback(async (albumId: string, albumName?: string) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    setFocusTreeVersion(version => version + 1);
    enterContentPending.current = true;
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
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) return;
    const requestId = invalidateTabLoad();
    if (subView?.type !== 'search') {
      setHistory(previous => [...previous, { items, subView, focusedItemId: focusedItemId.current, hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    }
    pendingSearchFocus.current = true;
    setItems([]);
    setLoading(true);
    setError(null);
    setSubView({ type: 'search', title: 'Search Results' });
    try {
      const section = showAllMedia || libraries.length > 1 ? '' : selectedSection;
      const cacheKey = `search:${showAllMedia ? 'all' : section}:${query.toLowerCase()}`;
      const result: any = await cachedItems(cacheKey, 30000, () => call("search_library", query, section, 30, showAllMedia));
      if (requestId !== tabLoadRequestId.current) return;
      if (result?.error) throw new Error(result.error);
      setItems(Array.isArray(result?.items) ? result.items : []);
    } catch (e) {
      if (requestId !== tabLoadRequestId.current) return;
      setError("Search failed.");
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [searchQuery, selectedSection, items, subView, tabHasMore, showAllMedia, libraries.length, cachedItems, invalidateTabLoad]);

  const startTrackQueue = useCallback(async (sourceItems: LibraryItem[], startId?: string, requestedTrack?: LibraryItem) => {
    setPlaybackRequests(count => count + 1);
    try {
      const fullTrackQueue = sourceItems.filter(entry => entry.type === 'track').map(entry => ({
        id: entry.id,
        sectionId: entry.sectionId || selectedSection,
        title: entry.title || 'Unknown',
        artist: entry.grandparentTitle || entry.artist || '',
        album: entry.parentTitle || '',
        duration: entry.duration || 0,
        thumb: entry.thumb || '',
      }));
      if (!fullTrackQueue.length) throw new Error('No tracks found to play.');
      let selectedIndex = startId == null ? 0 : fullTrackQueue.findIndex(track => String(track.id) === String(startId));
      if (startId != null && selectedIndex < 0 && requestedTrack) {
        // A click can race a paginated list refresh. Preserve the clicked song
        // as the queue head instead of silently starting at item one.
        const clickedTrack = {
          id: String(requestedTrack.id), sectionId: requestedTrack.sectionId || selectedSection,
          title: requestedTrack.title || 'Unknown',
          artist: requestedTrack.grandparentTitle || requestedTrack.artist || '',
          album: requestedTrack.parentTitle || '', duration: requestedTrack.duration || 0,
          thumb: requestedTrack.thumb || '',
        };
        fullTrackQueue.unshift(clickedTrack);
        selectedIndex = 0;
      }
      const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
      const trackInfo = fullTrackQueue[startIndex];
      const trackQueue = fullTrackQueue.slice(startIndex);
      console.info(`[DeckyPlex] starting queue at ${trackInfo.title} (${startIndex + 1}/${fullTrackQueue.length})`);
      itemCache.current.delete(`tab:${selectedSection}:recent`);
      const playerId = await readMusicPlaybackTarget();
      if (playerId) {
        const result = await playRemoteQueue(playerId, fullTrackQueue, trackInfo.id);
        if (!result.success) setError(result.error || 'Could not start playback on the selected remote player.');
        return;
      }
      const playbackToken = beginPlaybackRequest();
      // Get stream URL first, then play — playTrack must be called with a valid URL
      // so audio.play() can start immediately from this call stack.
      const result: any = await call("play_track", trackInfo.id, trackInfo.sectionId);
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
    } finally {
      setPlaybackRequests(count => count - 1);
    }
  }, [selectedSection, playTrack, readMusicPlaybackTarget, playRemoteQueue, beginPlaybackRequest]);

  const handlePlayTrack = useCallback((item: LibraryItem) => {
    void startTrackQueue(items, item.id, item);
  }, [items, startTrackQueue]);

  const handlePlayCollection = useCallback(async () => {
    if (!subView || playbackRequests) return;
    if (subView.type === 'albums' && subView.id) {
      setPlaybackRequests(count => count + 1);
      setError(null);
      try {
        const result: any = await cachedItems(`artistTracks:${subView.id}`, 300000,
          () => call('get_artist_tracks', subView.id));
        if (result.error) throw new Error(result.error);
        await startTrackQueue(result.items || []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load artist tracks.');
      } finally {
        setPlaybackRequests(count => count - 1);
      }
    } else {
      await startTrackQueue(items);
    }
  }, [subView, playbackRequests, cachedItems, startTrackQueue, items]);

  const loadMediaCollection = useCallback(async (item: LibraryItem) => {
    const requestId = invalidateTabLoad();
    setHistory(previous => [...previous, { items, subView, focusedItemId: item.id,
      hasMore: tabHasMore, scrollTop: contentRef.current?.scrollTop || 0 }]);
    enterContentPending.current = true;
    setSubView({ type: 'media', id: item.id, title: item.title, mediaType: item.type });
    setItems([]);
    setTabHasMore(false);
    setLoading(true);
    setError(null);
    try {
      const result = await cachedItems(`children:${item.id}`, 60000, () => call('get_metadata_children', item.id));
      if (requestId !== tabLoadRequestId.current) return;
      if (result?.error) throw new Error(result.error);
      setItems(result?.items || []);
    } catch (error) {
      if (requestId === tabLoadRequestId.current) {
        setError(error instanceof Error ? error.message : 'Could not load this Plex collection.');
      }
    } finally {
      if (requestId === tabLoadRequestId.current) setLoading(false);
    }
  }, [items, subView, tabHasMore, cachedItems, invalidateTabLoad]);

  const openMedia = useCallback((item: LibraryItem, collectionQueue?: VideoItem[], startPosition?: number) => {
    if (item.type !== 'photo') stopGamePip();
    setViewerResume(null);
    setViewerPresentation(null);
    setViewerStartPosition(startPosition);
    const queue = collectionQueue ?? (item.type === 'episode' && subView?.mediaType === 'season'
      ? queueFromEpisode(items.filter(entry => entry.type === 'episode'), item.id) : undefined);
    setViewerQueue(queue?.length ? queue : null);
    viewerOrigin.current = { itemId: collectionQueue ? focusedItemId.current : item.id, scrollTop: contentRef.current?.scrollTop || 0 };
    setViewerItem(item);
  }, [items, subView?.mediaType]);

  const collectionId = subView?.mediaType === 'show' || subView?.mediaType === 'season' ? subView.id : undefined;
  const collectionKey = collectionId && serverId ? `${serverId}:${collectionId}` : '';
  const requestCollection = useCallback(() => {
    if (!collectionKey || !collectionId) return Promise.resolve([]);
    if (collectionRequest.current?.key === collectionKey) return collectionRequest.current.episodes;
    const episodes = getEpisodeQueue(collectionId, serverId);
    collectionRequest.current = { key: collectionKey, episodes };
    // Prefetch and playback share this request. A failed prefetch must allow a later retry.
    void episodes.then(items => {
      if (!items?.length && collectionRequest.current?.episodes === episodes) collectionRequest.current = null;
    }, () => {
      if (collectionRequest.current?.episodes === episodes) collectionRequest.current = null;
    });
    return episodes;
  }, [collectionKey, collectionId, serverId]);

  useEffect(() => {
    if (!collectionKey) return;
    if (viewerExpanded) {
      collectionRequest.current = null;
      return;
    }
    const refresh = () => { void requestCollection().catch(() => {}); };
    const progressChanged = () => {
      collectionRequest.current = null;
      refresh();
    };
    refresh();
    window.addEventListener(videoProgressEvent, progressChanged);
    return () => window.removeEventListener(videoProgressEvent, progressChanged);
  }, [collectionKey, requestCollection, viewerExpanded]);

  const playVideoCollection = async () => {
    if (!collectionKey || !subView || playbackRequests || actionDialogRef.current) return;
    const requestId = tabLoadRequestId.current;
    setPlaybackRequests(count => count + 1);
    setError(null);
    try {
      const collection = await requestCollection();
      if (requestId !== tabLoadRequestId.current) return;
      const first = collection[0];
      if (!first) throw new Error('No episodes are available in this Plex collection.');
      const resume = resumeEpisode(collection);
      if (!resume || !collectionResumes(collection)) {
        openMedia(first, collection, 0);
        return;
      }

      const position = resumePosition(resume.viewOffset || 0, resume.duration || 0);
      actionDialogRef.current = showPlaybackStartDialog({
        title: subView.title,
        actionTitle: subView.mediaType === 'show' ? 'Play series' : 'Play season',
        firstLabel: episodeLabel(first),
        resumeLabel: episodeLabel(resume),
        position,
        onClose: start => {
          actionDialogRef.current = null;
          if (requestId !== tabLoadRequestId.current) return;
          if (start === 'resume') openMedia(resume, queueFromEpisode(collection, resume.id), position);
          if (start === 'beginning') openMedia(first, collection, 0);
        },
      });
    } catch (error) {
      if (requestId === tabLoadRequestId.current) {
        setError(error instanceof Error ? error.message : 'Could not play this Plex collection.');
      }
    } finally {
      setPlaybackRequests(count => count - 1);
    }
  };

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
    } else if (['show', 'season', 'photoalbum'].includes(item.type)) {
      void loadMediaCollection(item);
    } else if (['movie', 'episode', 'clip', 'photo'].includes(item.type)) {
      openMedia(item);
    }
  }, [loadAlbums, loadTracks, loadPlaylistTracks, handlePlayTrack, loadMediaCollection, openMedia]);

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const homeView = !subView && activeTab === 'videoHome';
  const gridView = homeView || subView?.type === 'albums' || subView?.type === 'media'
    || (!subView && (!!sectionForTab(activeTab) || ['artists', 'albums', 'recentlyAdded', 'playlists'].includes(activeTab)));
  const videoCollection = subView?.mediaType === 'show' || subView?.mediaType === 'season';
  const hasCollectionAction = videoCollection || subView?.type === 'albums' || subView?.type === 'tracks';
  const alphabeticallySorted = subView ? subView.type === 'albums'
    : shelf ? sorting.startsWith('titleSort:') : ['artists', 'albums', 'tracks', 'playlists'].includes(activeTab);

  // Steam calls this before positioning its focus ring. A handled scroll
  // replaces its default scroll, including when gamepad focus is virtual.
  const itemScroll = {
    ...focusOutlineProps,
    fnScrollIntoViewHandler: (focused: { Element?: HTMLElement }, previous?: { Element?: HTMLElement }) => {
      const viewport = contentRef.current;
      const item = focused.Element;
      if (!item || !viewport?.contains(item) || !viewport.offsetHeight) return false;
      window.cancelAnimationFrame(focusScrollFrame.current);

      const firstRow = Number(item.dataset.browserItemIndex) < (gridView ? gridColumns : 1)
        && (!homeView || item.hasAttribute('data-browser-home-start'));
      const viewportRect = viewport.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const scale = viewportRect.height / viewport.offsetHeight;
      if (scale <= 0) return false;
      const itemCenter = viewport.scrollTop + ((itemRect.top + itemRect.bottom) / 2 - viewportRect.top) / scale;
      const visibleHeight = Math.max(0, viewport.clientHeight - BROWSER_FOOTER_CLEARANCE);
      const viewportCenter = viewport.clientTop + visibleHeight / 2;
      const maxScroll = viewport.scrollHeight - viewport.clientHeight;
      const top = firstRow ? 0 : Math.max(0, Math.min(maxScroll, itemCenter - viewportCenter));
      const movingBetweenItems = !!previous?.Element?.closest('[data-browser-item-id]') && viewport.contains(previous.Element);
      const activeScroll = contentScrollAnimation.current;
      if (!activeScroll || Math.abs(activeScroll.top - top) > 1) {
        cancelContentScroll();
        const startTop = viewport.scrollTop;
        const distance = top - startTop;
        if (movingBetweenItems && Math.abs(distance) > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const duration = fastVerticalNavigation.current || activeScroll ? 90 : 210;
          const started = performance.now();
          const animation = { top, frame: 0 };
          const step = (time: number) => {
            const progress = Math.max(0, Math.min(1, (time - started) / duration));
            viewport.scrollTop = startTop + distance * (1 - (1 - progress) ** 3);
            if (progress < 1) animation.frame = window.requestAnimationFrame(step);
            else contentScrollAnimation.current = null;
          };
          contentScrollAnimation.current = animation;
          animation.frame = window.requestAnimationFrame(step);
        } else {
          viewport.scrollTop = top;
        }
      }
      updateAlphabetOverlay(item);

      const itemId = item.dataset.browserItemId;
      if (!subView && itemId) tabFocusPositions.current.set(activeTab, { itemId, scrollTop: top });
      return true;
    },
  };

  const scrollContentToTop = useCallback(() => {
    const viewport = contentRef.current;
    if (!viewport) return;
    window.cancelAnimationFrame(focusScrollFrame.current);
    cancelContentScroll();
    viewport.scrollTo({ top: 0, behavior: 'instant' });
  }, [cancelContentScroll]);

  const moveBetweenItems = (event: GamepadEvent, index: number) => {
    const { button } = event.detail;
    if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
    const nextIndex = index + (button === GamepadButton.DIR_UP ? -1 : 1);
    const target = nextIndex < 0 ? playCollectionRef.current ?? searchFormRef.current?.querySelector('input')
      : nextIndex < items.length ? contentRef.current?.querySelector<HTMLElement>(`[data-browser-item-index="${nextIndex}"]`) : null;
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    target.focus({ preventScroll: true });
  };

  const jumpToListTop = (event: import('@decky/ui').GamepadEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!items.length) return;
    scrollContentToTop();
    firstItemRef.current?.focus({ preventScroll: true });
  };

  const renderItemRow = (item: LibraryItem, idx: number, onClick: () => void, firstHomeRow = false) => {
    const sortTitle = alphabeticallySorted ? item.titleSort || item.title : undefined;
    const kind = item.type;
    const showPoster = homeView && kind === 'episode';
    const originalImage = showPoster ? item.poster : kind === 'artist' ? item.art || item.thumb : item.thumb || item.art;
    const imageUrl = (showPoster ? item.gridPoster : item.gridThumb) || originalImage;
    const portrait = showPoster || ['movie', 'show', 'season'].includes(kind);
    const canQueueNext = kind === 'episode' && (pipEpisodeQueue || !!viewerQueue && viewerItem?.type === 'episode');
    const queueNext = (event: GamepadEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pipEpisodeQueue) queueGamePipEpisodeNext(item);
      else if (viewerItem) setViewerQueue(queue => insertNextEpisode(queue ?? [viewerItem], viewerItem.id, item));
    };
    const title = episodeLabel(item);
    const subtitle = showPoster && item.grandparentTitle
      ? title
      : kind === 'album' ? item.artist || item.grandparentTitle || item.parentTitle
      : kind === 'artist' && combinedArtists && !subView ? libraries.find(library => library.id === item.sectionId)?.name
      : undefined;
    const fallbackIcon = kind === 'track' ? <FaMusic />
      : kind === 'album' ? <FaCompactDisc /> : kind === 'playlist' ? <FaListUl />
      : ['movie', 'show', 'season', 'episode', 'clip'].includes(kind) ? <FaFilm />
      : ['photo', 'photoalbum'].includes(kind) ? <FaImage /> : <FaUser />;
    const restoreOriginalImage = (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (originalImage && event.currentTarget.getAttribute('src') !== originalImage) {
        event.currentTarget.src = originalImage;
      }
    };
    const focusItem = () => {
      focusZone.current = 'content';
      focusedItemId.current = item.id;
      if (subView) return;
      if (tabFocusPositions.current.get(activeTab)?.itemId !== item.id) {
        tabFocusPositions.current.set(activeTab, { itemId: item.id, scrollTop: contentRef.current?.scrollTop || 0 });
      }
      if (!paginationError && idx >= items.length - (gridView ? gridColumns * 2 : 6)) void loadMoreTabPage();
    };
    if (gridView) {
      return (
        <Focusable
          key={item.id}
          ref={idx === 0 ? firstItemRef : undefined}
          data-browser-item-id={item.id}
          data-browser-item-index={idx}
          data-browser-sort-title={sortTitle}
          data-browser-card=""
          data-browser-home-start={firstHomeRow || undefined}
          onFocus={focusItem}
          onGamepadFocus={focusItem}
          {...itemScroll}
          onActivate={onClick}
          onClick={onClick}
          onCancel={handleCancel}
          onSecondaryActionDescription={item.type === 'playlist' ? 'Options' : canQueueNext ? 'Play next' : sortable ? 'Sort by' : undefined}
          onSecondaryButton={item.type === 'playlist' ? (event) => {
            event.preventDefault();
            event.stopPropagation();
            openPlaylistOptions(item);
          } : canQueueNext ? queueNext : sortable ? openSortMenu : undefined}
          style={{ display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0 0.35rem 0.35rem', gap: '0.3rem',
            scrollMarginTop: idx < gridColumns && (!homeView || firstHomeRow) ? browserHeaderScrollMargin : undefined }}
        >
          <div style={{ width: '100%', aspectRatio: portrait ? '2 / 3'
              : ['episode', 'clip'].includes(kind) ? '16 / 9' : '1 / 1',
            contain: 'paint', overflow: 'hidden', borderRadius: '4px', backgroundColor: 'rgba(255,255,255,0.1)',
            display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {imageUrl ? <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={restoreOriginalImage}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ opacity: 0.6, fontSize: '1.5rem' }}>{fallbackIcon}</span>}
          </div>
          <div style={{ fontWeight: 500, lineHeight: '1.2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
            {(showPoster ? item.grandparentTitle || title : title) || '(unknown)'}
          </div>
          {subtitle && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
              {subtitle}
            </div>
          )}
          {item.type === 'playlist' && item.leafCount != null && (
            <div style={{ fontSize: '0.75rem', lineHeight: '1.15', opacity: 0.65, margin: 0 }}>{item.leafCount} tracks</div>
          )}
          {item.type === 'movie' && item.year ? (
            <div style={{ fontSize: '0.75rem', opacity: 0.65 }}>{item.year}</div>
          ) : null}
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
                <img src={imageUrl} alt="" loading="lazy" decoding="async" onError={restoreOriginalImage}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
            ) : (
              <div style={{ minWidth: '1.5rem', textAlign: 'center' }}>
                {fallbackIcon}
              </div>
            )}
            <div style={{ display: 'flex', flex: 1, minWidth: 0, flexDirection: 'column', justifyContent: 'center', gap: '0.1rem', overflow: 'hidden' }}>
              <div style={{ fontWeight: 500, lineHeight: '1.15', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', margin: 0 }}>
                {title || '(unknown)'}
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
    const rowStyle = { display: 'block', width: '100%', boxSizing: 'border-box' as const, padding: '0.2rem 0.35rem',
      borderBottom: '1px solid rgba(255,255,255,0.08)', scrollMarginTop: idx === 0 ? browserHeaderScrollMargin : undefined };
    if (item.type === 'track') {
      const trackInfo = { id: item.id, sectionId: item.sectionId || selectedSection, title: item.title, artist: item.grandparentTitle || item.artist || '', album: item.parentTitle || '', duration: item.duration || 0, thumb: item.thumb || '' };
      return (
        <Focusable
          key={item.id}
            ref={idx === 0 ? firstItemRef : undefined}
            data-browser-item-id={item.id}
            data-browser-item-index={idx}
            data-browser-sort-title={sortTitle}
            onFocus={focusItem}
            onGamepadFocus={focusItem}
            {...itemScroll}
            onActivate={onClick}
            onClick={onClick}
            onCancel={handleCancel}
            onGamepadDirection={(event) => moveBetweenItems(event, idx)}
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
      <Focusable key={item.id} ref={idx === 0 ? firstItemRef : undefined} data-browser-item-id={item.id} data-browser-item-index={idx}
        data-browser-sort-title={sortTitle}
        onFocus={focusItem} onGamepadFocus={focusItem} {...itemScroll}
        onActivate={onClick} onClick={onClick}
        onCancel={handleCancel} onGamepadDirection={(event) => moveBetweenItems(event, idx)}
        onSecondaryActionDescription={item.type === 'playlist' ? 'Options' : canQueueNext ? 'Play next' : sortable ? 'Sort by' : undefined}
        onSecondaryButton={item.type === 'playlist' ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          openPlaylistOptions(item);
        } : canQueueNext ? queueNext : sortable ? openSortMenu : undefined}
        style={rowStyle}>
        {rowDetails}
      </Focusable>
    );
  };

  const renderContent = () => {
    const title = subView?.title || tabs.find(tab => tab.key === activeTab)?.title || 'Library';
    const initialLoading = (
      <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minHeight: '2.5rem', paddingInline: '0.35rem' }}>
        <InlineSpinner />
        <DialogBodyText style={{ margin: 0 }}>{checkingConnection ? 'Checking Plex connection…' : 'Loading…'}</DialogBodyText>
      </div>
    );
    if (checkingConnection) {
      return <div>
        <div style={browserHeaderStyle}><DialogLabel style={{ margin: 0 }}>{title}</DialogLabel></div>
        {initialLoading}
      </div>;
    }
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
      <div>
        <div style={browserHeaderStyle}>
          <DialogLabel style={{ flex: 1, minWidth: 0, margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </DialogLabel>
          {playbackRequests > 0 && <InlineSpinner />}
          {sortable && <Button ref={sortButtonRef} onClick={() => openSortMenu()} onCancelButton={handleCancel}>
            {VIDEO_SORTS.find(sort => sort.id === sorting)?.title || 'Sort by'}
          </Button>}
          {remoteTargetSelected && (
            <DialogBodyText style={{ color: '#9fc8ff', fontSize: '0.8rem', margin: 0 }}>
              Playback target: {remotePlayerName || 'remote Plex player'}
            </DialogBodyText>
          )}
          {hasCollectionAction && subView && !loading && (
            <Button key={`play-collection-${focusTreeVersion}`} ref={playCollectionRef}
              onClick={videoCollection ? playVideoCollection : handlePlayCollection} onCancelButton={handleCancel}
              onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}>
              <FaPlay /><span style={{ marginLeft: '0.3rem' }}>{videoCollection
                ? subView.mediaType === 'show' ? 'Play series' : 'Play season'
                : remoteTargetSelected ? 'Play remotely' : subView.type === 'albums' ? 'Play Artist' : subView.queueLabel || 'Play All'}</span>
            </Button>
          )}
        </div>

        {activeTab === 'search' && (!subView || subView.type === 'search') && (
            <div ref={searchFormRef} style={{ width: '100%', padding: '0 0.35rem 0.7rem', boxSizing: 'border-box' }}>
              <Focusable flow-children="horizontal" onCancel={handleCancel} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minWidth: 0 }}>
              <TextField
                label=""
                style={{ flex: '1 1 32rem', minWidth: '320px', width: '32rem', maxWidth: '70vw', boxSizing: 'border-box' }}
                value={searchQuery}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
                placeholder={showAllMedia ? 'Search your Plex libraries…' : 'Search artists, albums, tracks…'}
                onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
              />
              <Button onClick={handleSearch} aria-label="Search">
                <FaSearch />
              </Button>
            </Focusable>
            </div>
        )}

        {error && (
          <PanelSectionRow>
            <DialogBodyText style={{ color: '#ff6b6b' }}>{error}</DialogBodyText>
          </PanelSectionRow>
        )}

        {(loading || loadingLibraries) && initialLoading}
        {homeView && !loadingLibraries && !error && (
          <Focusable flow-children="geometric" onCancel={handleCancel}
            onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}>
            {VIDEO_HOME_ROWS.map((row, rowIndex) => {
              const result = homeData[row.id];
              if (result && !result.error && !result.items.length) return null;
              const startIndex = VIDEO_HOME_ROWS.slice(0, rowIndex)
                .reduce((count, previous) => count + (homeData[previous.id]?.items.length || 0), 0);
              return <section key={row.id} style={{ marginBottom: '1rem' }}>
                <div style={{ padding: '0.25rem 0.35rem 0.5rem' }}>
                  <DialogLabel style={{ margin: 0 }}>{row.title}</DialogLabel>
                </div>
                {!result ? <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginInline: '0.35rem' }}>
                  <InlineSpinner /><span>Loading…</span>
                </div> : result.error ? <DialogBodyText style={{ margin: '0 0.35rem', opacity: 0.7 }}>
                  {result.error}
                </DialogBodyText> :
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem' }}>
                    {result.items.map((item, index) => renderItemRow(item, startIndex + index, () => handleItemClick(item), startIndex === 0))}
                  </div>}
              </section>;
            })}
          </Focusable>
        )}
        {!homeView && !loading && !loadingLibraries && !error && items.length > 0 && (
            <div style={{ width: '100%' }}>
            {gridView ? (
              <Focusable flow-children="geometric" onCancel={handleCancel}
                onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'grid', gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, gap: '0.5rem', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            ) : (
              <Focusable key={`list-${activeTab}-${subView?.type || 'root'}-${subView?.id || ''}-${focusTreeVersion}`} flow-children="column" onCancel={handleCancel}
                onOptionsActionDescription="Jump to top" onOptionsButton={jumpToListTop}
                style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                {items.map((item, idx) => {
                  const handleClick = () => handleItemClick(item);
                  return renderItemRow(item, idx, handleClick);
                })}
              </Focusable>
            )}
            </div>
        )}
        {gridView && !gridPreferenceSet && (
          <PanelSectionRow><Button onClick={openGridColumnsDialog}>Choose browser grid width</Button></PanelSectionRow>
        )}
        {!subView && tabHasMore && <div ref={moreItemsRef} aria-hidden="true" style={{ height: 1 }} />}
        {!subView && paginationError && (
          <PanelSectionRow><Button onClick={() => void loadMoreTabPage()}>Retry loading more</Button></PanelSectionRow>
        )}
        {!subView && loadingMore && (
          <PanelSectionRow>
            <div style={{ display: 'flex', justifyContent: 'center', width: '100%', padding: '0.35rem 0' }}>
              <Spinner style={{ width: '18px', height: '18px', flexShrink: 0 }} />
            </div>
          </PanelSectionRow>
        )}

        {!loading && !loadingLibraries && !error && items.length === 0 && !subView && activeTab !== 'search'
          && (!homeView || VIDEO_HOME_ROWS.every(row => homeData[row.id] && !homeData[row.id]?.error)) && (
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
        {!loading && !error && items.length === 0 && subView?.type === 'media' && (
          <PanelSectionRow><DialogBodyText style={{ opacity: 0.5 }}>No items found.</DialogBodyText></PanelSectionRow>
        )}
      </div>
    );
  };

  const musicTabs = [
    { key: 'artists', title: 'Artists', icon: <FaUser /> },
    { key: 'albums', title: 'Albums', icon: <FaCompactDisc /> },
    { key: 'tracks', title: 'Songs', icon: <FaMusic /> },
    { key: 'recent', title: 'Recently Played', icon: <FaHistory /> },
    { key: 'recentlyAdded', title: 'Recently Added', icon: <FaCompactDisc /> },
    { key: 'playlists', title: 'Playlists', icon: <FaListUl /> },
  ] as const;
  const videoLibraries = libraries.filter(library => library.type !== 'artist');
  const hasVideoHome = videoLibraries.some(library => library.type === 'movie' || library.type === 'show');
  const tabs: { key: BrowserTab; title: string; icon: React.ReactNode }[] = [
    ...(selectedSection || !libraries.length ? musicTabs : []),
    ...(hasVideoHome ? [{ key: 'videoHome' as const, title: 'Home', icon: <FaHome /> }] : []),
    ...videoLibraries.map((library): { key: LibraryTab; title: string; icon: React.ReactNode } => ({
      key: `library:${library.id}`,
      title: library.name,
      icon: library.type === 'photo' ? <FaImage /> : <FaFilm />,
    })),
    { key: 'search', title: 'Search', icon: <FaSearch /> },
  ];

  useEffect(() => {
    const browser = browserRef.current;
    if (viewerExpanded || !browser) return;
    const moveAtBoundary = (event: Event, button: GamepadButton, repeat: boolean) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
      // Steam sends controller input to the focused navigation node, which can
      // differ from the DOM's active element when Gaming Mode uses virtual focus.
      const active = event.target as HTMLElement | null;
      if (!active?.closest) return;
      const sidebar = sidebarRef.current;
      const content = contentRef.current;
      let target: HTMLElement | null | undefined;
      if (sidebar?.contains(active)) {
        const tab = active.closest('[data-browser-tab]');
        if (!tab) return;
        const tabs = Array.from(sidebar.querySelectorAll<HTMLElement>('[data-browser-tab]'));
        if (tab !== (button === GamepadButton.DIR_UP ? tabs[0] : tabs[tabs.length - 1])) return;
      } else if (content?.contains(active)) {
        const collection = playCollectionRef.current;
        if (collection?.contains(active)) {
          if (button === GamepadButton.DIR_DOWN) {
            target = lastCollectionItem.current ?? firstItemRef.current;
            lastCollectionItem.current = null;
          }
        } else if (button === GamepadButton.DIR_UP) {
          const card = active.closest<HTMLElement>('[data-browser-item-index]');
          if (!card || Number(card.dataset.browserItemIndex) >= (gridView ? gridColumns : 1)
              || (homeView && !card.hasAttribute('data-browser-home-start'))) return;
          lastCollectionItem.current = collection ? card : null;
          target = collection ?? searchFormRef.current?.querySelector('input');
        } else {
          const page = nextPageAtBoundary.current;
          const hold = alphabetHold.current;
          if (!page || hold?.button !== button || (!repeat && hold.timer != null)) return;
          const card = active.closest<HTMLElement>('[data-browser-item-index]');
          if (!card) return;
          const columns = gridView ? gridColumns : 1;
          const row = Math.floor(Number(card.dataset.browserItemIndex) / columns);
          // A partial next row is still navigable from every column.
          if ((row + 1) * columns < page.itemCount) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          void page.load();
          return;
        }
      } else return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (target?.isConnected) target.focus({ preventScroll: true });
      else if (button === GamepadButton.DIR_DOWN && playCollectionRef.current?.contains(active)) {
        firstItemRef.current?.focus({ preventScroll: true });
      }
    };
    let lastVerticalPress = -Infinity;
    const recordVerticalPress = (button: GamepadButton | undefined, repeat: boolean, target: EventTarget | null) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) {
        fastVerticalNavigation.current = false;
        hideAlphabetOverlay();
        return;
      }
      const now = performance.now();
      fastVerticalNavigation.current = repeat || now - lastVerticalPress < 225;
      lastVerticalPress = now;
      if (alphabetHold.current?.button === button) return;
      hideAlphabetOverlay();

      // Steam can dispatch focus events from the separate Gaming Mode window.
      const item = (target as Element | null)?.closest?.<HTMLElement>('[data-browser-sort-title]');
      if (!item || !contentRef.current?.contains(item)) return;
      const hold: NonNullable<typeof alphabetHold.current> = { button, item, timer: null };
      alphabetHold.current = hold;
      hold.timer = window.setTimeout(() => {
        if (alphabetHold.current !== hold) return;
        hold.timer = null;
        updateAlphabetOverlay(hold.item);
      }, ALPHABET_HOLD_DELAY);
    };
    const onButtonDown = (event: Event) => {
      const detail = (event as GamepadEvent).detail;
      const repeat = detail?.is_repeat === true;
      recordVerticalPress(detail?.button, repeat, event.target);
      if (detail?.button === GamepadButton.START && connected && !gridDialogRef.current && !actionDialogRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!detail.is_repeat) openSearch();
        return;
      }
      moveAtBoundary(event, detail?.button, repeat);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const button = event.key === 'ArrowUp' ? GamepadButton.DIR_UP : GamepadButton.DIR_DOWN;
      recordVerticalPress(button, event.repeat, event.target);
      moveAtBoundary(event, button, event.repeat);
    };
    const endRepeat = () => {
      fastVerticalNavigation.current = false;
      hideAlphabetOverlay();
    };
    const releaseDirection = (button?: GamepadButton) => {
      if (button !== GamepadButton.DIR_UP && button !== GamepadButton.DIR_DOWN) return;
      if (!alphabetHold.current || alphabetHold.current.button === button) endRepeat();
    };
    const onButtonUp = (event: Event) => releaseDirection((event as GamepadEvent).detail?.button);
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp') releaseDirection(GamepadButton.DIR_UP);
      else if (event.key === 'ArrowDown') releaseDirection(GamepadButton.DIR_DOWN);
    };
    const ownerDocument = browser.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    browser.addEventListener('vgp_onbuttondown', onButtonDown, true);
    browser.addEventListener('keydown', onKeyDown, true);
    ownerDocument.addEventListener('vgp_onbuttonup', onButtonUp, true);
    ownerDocument.addEventListener('keyup', onKeyUp, true);
    ownerWindow?.addEventListener('blur', endRepeat);
    return () => {
      browser.removeEventListener('vgp_onbuttondown', onButtonDown, true);
      browser.removeEventListener('keydown', onKeyDown, true);
      ownerDocument.removeEventListener('vgp_onbuttonup', onButtonUp, true);
      ownerDocument.removeEventListener('keyup', onKeyUp, true);
      ownerWindow?.removeEventListener('blur', endRepeat);
      endRepeat();
    };
  }, [viewerExpanded, gridView, gridColumns, homeView, connected, openSearch, activeTab, sorting, hideAlphabetOverlay, updateAlphabetOverlay]);

  const enterContent = () => {
    focusZone.current = 'content';
    const savedPosition = tabFocusPositions.current.get(activeTab);
    enterContentPending.current = !savedPosition;
    if (savedPosition) {
      pendingFocusId.current = savedPosition.itemId;
      pendingScrollTop.current = savedPosition.scrollTop;
      setRestoreFocusTick(value => value + 1);
    }
    if (!loading && !loadingLibraries && (items.length > 0 || activeTab === 'search')) {
      if (!savedPosition) {
        enterContentPending.current = false;
        if (searchFormRef.current) searchFormRef.current.querySelector('input')?.focus();
        else firstItemRef.current?.focus({ preventScroll: homeView });
      }
    }
  };

  const episodes = viewerItem?.type === 'episode' ? viewerQueue ?? [viewerItem] : [];
  const playEpisode = (id: string, presentation: VideoPresentation) => {
    const next = latestViewerQueue.current?.find(episode => episode.id === id);
    if (!next || viewerItem?.id === id) return false;
    if (viewerOrigin.current.itemId && items.some(entry => entry.id === next.id)) viewerOrigin.current.itemId = next.id;
    setViewerResume(null);
    setViewerPresentation(presentation);
    setViewerStartPosition(undefined);
    setViewerItem(next);
    return true;
  };

  const browser = !viewerExpanded && (
    <Focusable onCancel={handleCancel} style={{ display: 'contents' }}>
      <FocusOutlineStyles />
      <style>{`
        [data-browser-card].deckyplex-focus-outline-active::after { top: -4px; }
        [data-browser-alphabet]:not([hidden]) { display: grid; place-items: center; }
      `}</style>
    <div
      ref={browserRef}
      onFocusCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        const inSidebar = !!event.target.closest('[data-browser-zone="sidebar"]');
        focusZone.current = inSidebar ? 'sidebar' : 'content';
        if (inSidebar || !event.target.closest('[data-browser-item-id]')) {
          keepFocusedElementVisible(event.target, inSidebar);
        }
      }}
      style={{ display: 'flex', gap: '0.65rem', marginTop: '40px', height: 'calc(100% - 40px)', minHeight: 0,
        overflow: 'hidden' }}
    >
      <div data-browser-zone="sidebar" ref={sidebarRef}
        style={{ width: 'clamp(140px, 13vw, 175px)', boxSizing: 'border-box', flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.1)',
          padding: '0.5rem 0.4rem 110px 0.2rem', scrollPaddingBottom: '110px', overflowY: 'auto' }}>
        <div style={browserHeaderStyle}><DialogLabel style={{ margin: 0 }}>DeckyPlex</DialogLabel></div>
        <Focusable flow-children="column" onCancel={handleCancel} style={{ display: 'flex', flexDirection: 'column' }}>
          {tabs.map(({ key: tab, title, icon }) => (
            <Fragment key={tab}>
            {(hasVideoHome ? tab === 'videoHome' : tab === `library:${videoLibraries[0]?.id}`) &&
              <div style={{ margin: '0.45rem 0.65rem 0.35rem', fontSize: '0.73rem', color: '#aeb9c5' }}>Video</div>}
            <Focusable
              data-browser-tab={tab}
              preferredFocus={tab === activeTab}
              onFocus={() => {
                focusZone.current = 'sidebar';
                selectTab(tab);
              }}
              onActivate={enterContent}
              onClick={enterContent}
              onSecondaryActionDescription={sortable && tab === activeTab ? 'Sort by' : undefined}
              onSecondaryButton={sortable && tab === activeTab ? openSortMenu : undefined}
              style={{ display: 'flex', alignSelf: 'stretch', width: '100%', height: '42px', minHeight: '42px', boxSizing: 'border-box', alignItems: 'center', gap: '0.55rem', padding: '0 0.65rem', marginBottom: '0.3rem', border: `1px solid ${activeTab === tab ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'}`, background: activeTab === tab ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.035)', borderRadius: '4px', whiteSpace: 'nowrap' }}
            >
              <span style={{ display: 'inline-flex', width: '1.1rem', justifyContent: 'center', flexShrink: 0 }}>{icon}</span>
              <span style={{ fontWeight: 400, fontSize: '0.85rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{title}</span>
              {tab === 'search' && connected && (
                <span role="img" aria-label="Start button shortcut" title="Start button shortcut"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginLeft: 'auto',
                    width: '1.2rem', height: '1rem', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '4px', fontSize: '0.65rem' }}>
                  <FaBars aria-hidden="true" />
                </span>
              )}
            </Focusable>
            </Fragment>
          ))}
        </Focusable>
      </div>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div data-browser-zone="content" ref={contentRef}
          onWheel={cancelContentScroll} onPointerDown={cancelContentScroll}
          style={{ height: '100%', overflowY: 'auto', scrollBehavior: 'auto', padding: `0.5rem 0.5rem ${BROWSER_FOOTER_CLEARANCE}px 0`,
            boxSizing: 'border-box', scrollPaddingTop: '28px', scrollPaddingBottom: `${BROWSER_FOOTER_CLEARANCE}px` }}>
          {renderContent()}
        </div>
        <div ref={alphabetOverlayRef} data-browser-alphabet="" hidden aria-hidden="true"
          style={{ position: 'absolute', inset: 0, paddingBottom: BROWSER_FOOTER_CLEARANCE, zIndex: 2, pointerEvents: 'none',
            background: 'rgba(12, 16, 21, 0.55)', backdropFilter: 'blur(4px)', color: '#fff',
            fontSize: 'clamp(4rem, 12vw, 8rem)', fontWeight: 700 }} />
      </div>
    </div>
    </Focusable>
  );

  return (
    <>
      {browser}
      {viewerItem && <MediaViewer key={viewerResume ? `${viewerItem.id}-from-pip` : viewerItem.id} item={viewerItem}
        subtitle={viewerItem.grandparentTitle || viewerItem.parentTitle}
        photo={viewerItem.type === 'photo'} initialVolume={localVolume} initialPlayback={viewerResume}
        initialPosition={viewerStartPosition}
        initialPresentation={viewerPresentation} close={closeMedia}
        overGamePip={overGamePip}
        episodes={episodes} episodeQueueReady={!!viewerQueue} playEpisode={playEpisode}
        removeEpisode={id => {
          if (id !== viewerItem.id) setViewerQueue(queue => queue?.filter(episode => episode.id !== id) ?? null);
        }}
        onPlaying={() => { if (localMusicPlaying) pause(); }} />}
    </>
  );
});

function GridColumnsDialog({ initialColumns, onPreview, onConfirm, onClose }: {
  initialColumns: number;
  onPreview: (columns: number) => void;
  onConfirm: (columns: number) => Promise<void>;
  onClose: () => void;
}) {
  const [columns, setColumns] = useState(initialColumns);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const commitInProgress = useRef(false);
  const changeColumns = (next: number) => {
    if (commitInProgress.current) return;
    const value = Math.max(3, Math.min(9, next));
    setColumns(value);
    onPreview(value);
  };
  const saveColumns = async (value: number) => {
    if (commitInProgress.current) return;
    commitInProgress.current = true;
    setSaving(true);
    setError('');
    try {
      await onConfirm(value);
      onClose();
    } catch {
      setError('Could not save the grid width.');
      setSaving(false);
      commitInProgress.current = false;
    }
  };
  const confirm = () => saveColumns(columns);
  const cancel = () => {
    if (commitInProgress.current) return;
    setColumns(DEFAULT_GRID_COLUMNS);
    onPreview(DEFAULT_GRID_COLUMNS);
    void saveColumns(DEFAULT_GRID_COLUMNS);
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
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={confirm} bDisableBackgroundDismiss={saving}>
      <ChoiceDialogBody title="Choose grid width">
        <ChoiceDialogList>
          <Focusable
            {...focusOutlineProps}
            flow-children="horizontal"
            onGamepadDirection={handleDirection}
            onActivate={confirm}
            onClick={confirm}
            onOKActionDescription="Confirm"
            role="slider"
            aria-label="Grid columns"
            aria-valuemin={3}
            aria-valuemax={9}
            aria-valuenow={columns}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                changeColumns(columns + (event.key === 'ArrowRight' ? 1 : -1));
              } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void confirm();
              }
            }}
            style={{ boxSizing: 'border-box', padding: '0.65rem 0.8rem', borderRadius: '0.5rem',
              border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.45rem' }}>
              <span>Grid columns</span><strong>{columns}</strong>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: '0.28rem' }}>
              {Array.from({ length: 9 }, (_, index) => (
                <div key={index} style={{ height: '0.45rem', borderRadius: '3px', background: index < columns ? '#66c0f4' : 'rgba(255,255,255,0.2)' }} />
              ))}
            </div>
          </Focusable>
        </ChoiceDialogList>
        <PanelSectionRow>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem' }}>
            <DialogBodyText style={{ opacity: 0.7, margin: 0 }}>Change anytime in Settings › Interface.</DialogBodyText>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              {saving ? <InlineSpinner /> : <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', border: '1px solid currentColor', borderRadius: '50%', width: '1.15rem', height: '1.15rem', fontSize: '0.75rem' }}>A</span>}
              {saving ? 'Saving…' : 'Confirm'}
            </span>
          </div>
        </PanelSectionRow>
        {error && <PanelSectionRow><DialogBodyText>{error}</DialogBodyText></PanelSectionRow>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}

function PlaylistOptionsDialog({ playlist, onDeleted, onClose }: {
  playlist: LibraryItem;
  onDeleted: (playlistId: string) => void;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const deleting = useRef(false);
  const actionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (busy) return;
    const frame = window.requestAnimationFrame(() => actionRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [confirming, busy]);

  const deletePlaylist = async () => {
    if (deleting.current) return;
    deleting.current = true;
    setBusy(true);
    try {
      const result: any = await call('delete_audio_playlist', playlist.id);
      if (!result?.success) throw new Error(result?.error || 'Could not delete playlist.');
      onDeleted(playlist.id);
    } catch (error: any) {
      setMessage(error?.message || 'Could not delete playlist.');
      setConfirming(false);
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  };

  const cancel = () => {
    if (deleting.current) return;
    if (confirming) setConfirming(false);
    else onClose();
  };

  return (
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={() => {}} bCancelDisabled={busy} bDisableBackgroundDismiss={busy}>
      <ChoiceDialogBody title={confirming ? 'Delete Playlist' : playlist.title}
        subtitle={confirming ? `Permanently delete “${playlist.title}”?` : `${playlist.leafCount ?? 0} tracks`}>
        <ChoiceDialogList>
          {confirming ? <>
            <ChoiceDialogRow key="keep" title="Keep Playlist" icon={<FaArrowLeft />} rowRef={actionRef} preferredFocus disabled={busy} onChoose={cancel} />
            <ChoiceDialogRow key="confirm" title="Delete Playlist" icon={<FaTrash />} destructive disabled={busy}
              onChoose={() => void deletePlaylist()} />
          </> : <ChoiceDialogRow key="ask" title="Delete Playlist" icon={<FaTrash />} rowRef={actionRef} destructive preferredFocus onChoose={() => {
            setMessage('');
            setConfirming(true);
          }} />}
        </ChoiceDialogList>
        {busy && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          <InlineSpinner /> Deleting playlist…
        </div>}
        {!!message && <DialogBodyText style={{ color: '#ff7777' }}>{message}</DialogBodyText>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}

function TrackOptionsDialog({ track, playlistId, addToQueue, onClose }: {
  track: Parameters<ReturnType<typeof usePlayer>['addToQueue']>[0];
  playlistId?: string;
  addToQueue: ReturnType<typeof usePlayer>['addToQueue'];
  onClose: () => void;
}) {
  const [view, setView] = useState<'actions' | 'playlists' | 'new'>('actions');
  const [playlists, setPlaylists] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [playlistName, setPlaylistName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const playlistKeyboard = useRef<{ HideVirtualKeyboard: () => void } | null>(null);
  const queueActionInProgress = useRef(false);
  const playlistLoadInProgress = useRef(false);
  const playlistActionInProgress = useRef(false);

  const queueTrack = async (playNext: boolean) => {
    if (busy || queueActionInProgress.current) return;
    queueActionInProgress.current = true;
    onClose();
    try {
      const result = await addToQueue(track, playNext);
      const message = result.success ? result.warning : result.error || 'Could not update the queue.';
      if (message) void toaster.toast({ title: 'DeckyPlex', body: message });
    } catch (error: any) {
      void toaster.toast({ title: 'DeckyPlex', body: error?.message || 'Could not update the queue.' });
    }
  };

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
    setMessage('');
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
    const name = playlistName.trim();
    if (!name || playlistActionInProgress.current) return;
    playlistActionInProgress.current = true;
    setBusy(true);
    try {
      playlistKeyboard.current?.HideVirtualKeyboard?.();
      const result: any = await call('create_audio_playlist', name, track.id);
      if (!result?.success) throw new Error(result?.error || 'Could not create playlist.');
      setMessage(`Created ${result.playlist || name} and added this song.`);
      setPlaylists(items => [{ id: result.id, key: '', title: result.playlist || name, type: 'playlist' }, ...items]);
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

  const showNewPlaylist = () => {
    setPlaylistName('');
    setMessage('');
    setView('new');
  };

  return (
    <ModalRoot closeModal={onClose} onCancel={handleDialogCancel} onOK={() => {}}>
      <ChoiceDialogBody bodyRef={menuRef} key={view}
        title={view === 'actions' ? track.title : view === 'new' ? 'New Playlist' : 'Add to Playlist'}
        subtitle={view === 'actions' ? [track.artist, track.album].filter(Boolean).join(' · ') : track.title}>
        {view === 'actions' && <ChoiceDialogList>
          <ChoiceDialogRow title="Play Next" icon={<FaStepForward />} disabled={busy} onChoose={() => void queueTrack(true)} />
          <ChoiceDialogRow title="Add to Queue" icon={<FaListOl />} disabled={busy} onChoose={() => void queueTrack(false)} />
          <ChoiceDialogRow title="Add to Playlist" icon={<FaListUl />} disabled={busy} onChoose={() => void showPlaylists()} />
          {playlistId && <ChoiceDialogRow title="Remove from Playlist" icon={<FaMinus />} disabled={busy}
            onChoose={() => void removeFromPlaylist()} />}
        </ChoiceDialogList>}
        {view === 'playlists' && <>
          {loading && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <InlineSpinner /><DialogBodyText style={{ margin: 0 }}>Loading playlists…</DialogBodyText>
          </div>}
          {!loading && playlists.length === 0 && !message && <PanelSectionRow><DialogBodyText>No audio playlists yet. Create one for this song.</DialogBodyText></PanelSectionRow>}
          {!loading && <ChoiceDialogList>
            {playlists.map(playlist => <ChoiceDialogRow key={playlist.id} title={playlist.title} icon={<FaListUl />}
              actionDescription="Add to playlist" disabled={busy} onChoose={() => void addToPlaylist(playlist.id)} />)}
            <ChoiceDialogRow title="New Playlist" icon={<FaPlus />} disabled={busy} onChoose={showNewPlaylist} />
          </ChoiceDialogList>}
        </>}
        {view === 'new' && <ChoiceDialogList>
          <PanelSectionRow>
            <TextField label="Playlist name" value={playlistName} disabled={busy}
              {...{
                refKeyboardHandle: playlistKeyboard,
                strEnterKeyLabel: 'Create Playlist',
                onEnterKeyPress: () => { void createPlaylist(); },
              }}
              onChange={event => setPlaylistName(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                event.stopPropagation();
                if (!event.repeat) void createPlaylist();
              }} />
          </PanelSectionRow>
          <ChoiceDialogRow title="Create Playlist" icon={<FaPlus />} disabled={busy || !playlistName.trim()}
            onChoose={() => void createPlaylist()} />
        </ChoiceDialogList>}
        {busy ? <PanelSectionRow><DialogBodyText style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <InlineSpinner /> {view === 'new' ? 'Creating playlist…' : 'Updating…'}
        </DialogBodyText></PanelSectionRow> : !!message && <PanelSectionRow><DialogBodyText style={{ color: /^(Added to|Created|Removed from)/.test(message) ? '#78d99a' : '#ff7777' }}>{message}</DialogBodyText></PanelSectionRow>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
