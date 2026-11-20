import { definePlugin, routerHook } from '@decky/api';
import { staticClasses, PanelSection, PanelSectionRow, ButtonItem, Navigation } from '@decky/ui';
import { FaMusic } from 'react-icons/fa';
import { QuickPlayer } from './components/QuickPlayer';
import { PlayerProvider } from './context/PlayerContext';
import { BrowserPage } from './components/BrowserPage';
import { SettingsPage } from './components/SettingsPage';
import { GamePipHost, gamePipFullscreenEvent, prepareGamePipFullscreen, stopGamePip } from './components/GamePip';

const BROWSER_ROUTE = "/deckyplex-browser";
const SETTINGS_ROUTE = "/deckyplex-settings";
const GAME_PIP_HOST = "DeckyPlexGamePip";

// Wrap fullscreen routes with PlayerProvider so usePlayer() works
function BrowserPageWithProvider() {
  return (
    <PlayerProvider>
      <BrowserPage />
    </PlayerProvider>
  );
}

export default definePlugin(() => {
  routerHook.addRoute(BROWSER_ROUTE, BrowserPageWithProvider, { exact: true });
  routerHook.addRoute(SETTINGS_ROUTE, SettingsPage, { exact: true });
  routerHook.addGlobalComponent(GAME_PIP_HOST, GamePipHost);

  return {
    name: "DeckyPlex",
    // The playback engine receives Plex Companion commands even when the QAM is hidden.
    // Keep Decky's content tree alive so its frontend bridge remains available.
    alwaysRender: true,
    titleView: <div className={staticClasses.Title}>DeckyPlex</div>,
    icon: <FaMusic />,
    content: (
      <PlayerProvider>
        <QuickPlayer onLogin={() => {
          Navigation.Navigate(SETTINGS_ROUTE);
          Navigation.CloseSideMenus();
        }} onBrowse={() => {
          Navigation.Navigate(BROWSER_ROUTE);
          Navigation.CloseSideMenus();
        }} onExpandPip={() => {
          void prepareGamePipFullscreen().then(prepared => {
            if (!prepared) return;
            Navigation.Navigate(BROWSER_ROUTE);
            Navigation.CloseSideMenus();
            window.requestAnimationFrame(() => window.dispatchEvent(new Event(gamePipFullscreenEvent)));
          });
        }}>
          <PanelSection>
            <PanelSectionRow>
              <ButtonItem
                layout="below"
                onClick={() => {
                  Navigation.Navigate(SETTINGS_ROUTE);
                  Navigation.CloseSideMenus();
                }}
              >
                Settings
              </ButtonItem>
            </PanelSectionRow>
          </PanelSection>
        </QuickPlayer>
      </PlayerProvider>
    ),
    onDismount() {
      stopGamePip();
      routerHook.removeGlobalComponent(GAME_PIP_HOST);
      routerHook.removeRoute(BROWSER_ROUTE);
      routerHook.removeRoute(SETTINGS_ROUTE);
    },
  };
});
