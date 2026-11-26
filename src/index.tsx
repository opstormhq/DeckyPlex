import { definePlugin, routerHook } from '@decky/api';
import { Navigation, Router } from '@decky/ui';
import { FaMusic } from 'react-icons/fa';
import { QuickPlayer } from './components/QuickPlayer';
import { setGamepadSoundsMuted } from './components/GamepadSounds';
import { PlayerProvider, startLocalVolumeSession } from './context/PlayerContext';
import { BrowserPage } from './components/BrowserPage';
import { SettingsPage } from './components/SettingsPage';
import { GamePipHost, gamePipFullscreenEvent, prepareGamePipFullscreen, stopGamePip } from './components/GamePip';
import { preservePreferencesDuringUpdates } from './packagePreferences';
import { clearPausedVideo, requestPausedVideo, resumePausedVideoEvent, suspendVideoPlayback } from './components/VideoPlayback';

const BROWSER_ROUTE = "/deckyplex-browser";
const SETTINGS_ROUTE = "/deckyplex-settings";
const LOGIN_ROUTE = "/deckyplex-settings/login";
const GAME_PIP_HOST = "DeckyPlexGamePip";
const pluginRoutes = [BROWSER_ROUTE, SETTINGS_ROUTE, LOGIN_ROUTE] as const;

function openPluginPage(route: typeof pluginRoutes[number]) {
  const steamWindow = window.SteamUIStore?.GetFocusedWindowInstance?.()
    ?? Router?.WindowStore?.GamepadUIMainWindowInstance
    ?? Router?.WindowStore?.SteamUIWindows?.[0];
  const current = steamWindow?.m_locationPathname;
  if (current !== route) {
    if (route === SETTINGS_ROUTE || route === LOGIN_ROUTE) suspendVideoPlayback();
    if (typeof steamWindow?.Navigate === 'function') {
      // Keep the Steam page underneath the plugin as the Back destination.
      const replace = pluginRoutes.some(path => path === current);
      steamWindow.Navigate(route, replace, false);
    } else {
      Navigation.Navigate(route);
    }
  }
  Navigation.CloseSideMenus();
}

// Wrap fullscreen routes with PlayerProvider so usePlayer() works
function BrowserPageWithProvider() {
  return (
    <PlayerProvider>
      <BrowserPage />
    </PlayerProvider>
  );
}

function LoginPage() {
  return <SettingsPage startLogin />;
}

export default definePlugin(() => {
  try { window.localStorage.removeItem('deckyplex-grid-columns'); } catch {}
  const stopPreservingPreferences = preservePreferencesDuringUpdates();
  const endLocalVolumeSession = startLocalVolumeSession();
  window.addEventListener('deckyplex-local-music-playing', clearPausedVideo);
  routerHook.addRoute(BROWSER_ROUTE, BrowserPageWithProvider, { exact: true });
  routerHook.addRoute(SETTINGS_ROUTE, SettingsPage, { exact: true });
  routerHook.addRoute(LOGIN_ROUTE, LoginPage, { exact: true });
  routerHook.addGlobalComponent(GAME_PIP_HOST, GamePipHost);

  return {
    name: "DeckyPlex",
    // The playback engine receives Plex Companion commands even when the QAM is hidden.
    // Keep Decky's content tree alive so its frontend bridge remains available.
    alwaysRender: true,
    icon: <FaMusic />,
    content: (
      <PlayerProvider>
        <QuickPlayer onLogin={() => openPluginPage(LOGIN_ROUTE)} onBrowse={() => openPluginPage(BROWSER_ROUTE)}
          onSettings={() => openPluginPage(SETTINGS_ROUTE)} onResumeVideo={playing => {
            if (!requestPausedVideo(playing)) return;
            openPluginPage(BROWSER_ROUTE);
            window.requestAnimationFrame(() => window.dispatchEvent(new Event(resumePausedVideoEvent)));
          }} onExpandPip={() => {
          void prepareGamePipFullscreen().then(prepared => {
            if (!prepared) return;
            openPluginPage(BROWSER_ROUTE);
            window.requestAnimationFrame(() => window.dispatchEvent(new Event(gamePipFullscreenEvent)));
          });
        }} />
      </PlayerProvider>
    ),
    onDismount() {
      setGamepadSoundsMuted(false);
      stopPreservingPreferences();
      endLocalVolumeSession();
      stopGamePip();
      window.removeEventListener('deckyplex-local-music-playing', clearPausedVideo);
      clearPausedVideo();
      routerHook.removeGlobalComponent(GAME_PIP_HOST);
      routerHook.removeRoute(BROWSER_ROUTE);
      routerHook.removeRoute(SETTINGS_ROUTE);
      routerHook.removeRoute(LOGIN_ROUTE);
    },
  };
});
