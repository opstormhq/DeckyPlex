import { definePlugin, routerHook } from '@decky/api';
import { staticClasses, PanelSection, PanelSectionRow, ButtonItem, Navigation } from '@decky/ui';
import { FaMusic } from 'react-icons/fa';
import { QuickPlayer } from './components/QuickPlayer';
import { PlayerProvider } from './context/PlayerContext';
import { BrowserPage } from './components/BrowserPage';
import { SettingsPage } from './components/SettingsPage';

const BROWSER_ROUTE = "/deckyplex-browser";
const SETTINGS_ROUTE = "/deckyplex-settings";

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

  return {
    name: "DeckyPlex",
    titleView: <div className={staticClasses.Title}>DeckyPlex</div>,
    icon: <FaMusic />,
    content: (
      <PlayerProvider>
        <QuickPlayer />
        <PanelSection>
          <PanelSectionRow>
            <ButtonItem
              layout="below"
              onClick={() => {
                Navigation.Navigate(BROWSER_ROUTE);
                Navigation.CloseSideMenus();
              }}
            >
              Browse Music
            </ButtonItem>
          </PanelSectionRow>
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
      </PlayerProvider>
    ),
    onDismount() {
      routerHook.removeRoute(BROWSER_ROUTE);
      routerHook.removeRoute(SETTINGS_ROUTE);
    },
  };
});
