# DeckyPlex

A Plex player for Steam Gaming Mode through [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader). Browse and play music, movies, and TV from your Plex libraries, or use Plexamp to control music on the Deck.

## Features

- **Library browser**: Browse artists from your selected music libraries and use named tabs for movies, TV, and photos.
- **Quick player**: Play, pause, seek, and adjust volume from the Decky sidebar.
- **Plex login**: Sign in with a Plex PIN and select a server.
- **Remote Plex players**: Start music on and control connected Plex clients such as Plexamp on a phone.
- **Plex Companion receiver**: Opt in to local Plexamp playback and set a distinct receiver name for each device.
- **Advanced connection settings**: Override automatic discovery with a local server IP, set a connection timeout, and configure HTTPS certificate verification.

## Prerequisites

- A SteamOS device with [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed
- Access to a Plex Media Server

## Installation

1. Download `DeckyPlex.zip` from [GitHub Releases](https://github.com/brandonkgarner/DeckyPlex/releases).
2. Install the ZIP through Decky Loader's developer settings.

No additional Python dependencies are needed — `plexapi` is bundled with the plugin.

## Configuration

1. Open the Decky menu and navigate to **DeckyPlex > Settings**.
2. Choose **Sign in with a code** and enter the code at `plex.tv/link`.
3. Choose a server if Plex finds more than one, then choose its libraries. Cancel to keep the default server. Each server starts with its music libraries selected and remembers its own choices. Later changes under **Settings > Server** save automatically.
4. To play on another Plex client, open **Settings > Players**, refresh the list, select a connected player, and choose it as the playback target.
5. If automatic discovery selected an unreachable server address, open **Settings > Advanced** and enter the server's local IP address. You can also use **Local Plex server address** there while signed out if your server already allows local access without authentication.
6. Enable **Plexamp receiver** in **Settings > Players** to receive music from a device on the same LAN. Set the **Receiver device name** there to distinguish your devices in Plexamp.

## Usage

- Open **Browse Music** to browse and play tracks, or **Browse Media** to include your selected movie, TV, and photo libraries. Under **Video**, **Home** shows Continue Watching, Watch Next, Recently Added Movies and TV, and Watchlist matches from your selected libraries. Press **Select** or choose the sort button above the grid to sort a movie or TV library.
- Press **Start** in the Library Browser to focus the Search box.
- During playback, press **B** to return focus to Browse in Quick Player. Press **B** again to close Quick Access, or use the back arrow to return to the Decky plugin list. You can change the tray behavior in **Settings > Interface > Quick Player**.
- Videos resume from your Plex watch position when available. Choose **Full screen**, then press **B** to show the controls. Press **A** on the timeline to scrub, move left or right to preview a position, and press **A** again to seek or **B** to cancel. **Original when possible** prefers direct playback and uses Plex conversion for incompatible media. The player shows the active playback mode and decoded resolution. A failed quality switch reloads the previous quality at the same position.
- To keep the picture over a game in Steam Gaming Mode, choose **Pop out** from the video player or Quick Player. The overlay opens only when you choose Pop out. You can disable it or adjust its position and size under **Settings > Interface > Video**. Use **Full screen** in Quick Player to return to the video at its current position. Starting local music closes the overlay.
- During Plex setup, selecting a movie or TV library offers to show trailers and extras. They start off and can be enabled later under **Settings > Interface > Video**. DeckyPlex's navigation and selection sounds can be muted under **Settings > Interface > Appearance**.
- Partially watched movies and the **Play series** and **Play season** actions offer **Resume** or **Start from beginning** when Plex has a saved starting point. Opening a single episode queues it through the end of its season. The next queued episode plays automatically in fullscreen and PiP. Press **X** on an upcoming episode in the Quick Player queue to remove it, or on an episode in the browser while a show is playing to play it next.
- Set grid columns under **Settings > Interface > Library browser**.
- Open **Settings** to sign in to Plex and select a server.
- Choose a device under **Settings > Players > Playback target** to send music to Plexamp or another online Plex client. Quick Player follows the player's shared queue when it is available. Queue edits require permission from Plex.

### Using Plexamp on a phone as a remote

DeckyPlex advertises a local Plex Companion player endpoint and routes received track, playback, seek, and volume commands to the Decky audio engine. Incoming playback uses the Plex server selected in Settings. Plex Companion discovery requires the devices to share a local network; GDM uses UDP discovery and the receiver uses TCP 32435. The receiver status appears in **Settings > Players**.

With the receiver enabled, DeckyPlex publishes the current song and upcoming music to Plex. Select DeckyPlex as the player in Plexamp to use **Play Next** with the shared queue. Turning on the receiver during a song shares the queue at the current playback position.

## Development

The GitHub runner uses Node.js 24 and Python 3.13. Local packaging also uses `pip` and `zip`.

```bash
npm ci
npm run check
npm test
npm run package
python3 -m unittest discover -s tests
```

The package build installs the pinned dependencies in `requirements.txt` into the ZIP and keeps Decky's bundled XML fallback in `py_modules/xml`. Set `PYTHON` to a virtual environment's interpreter if needed. The tests use synthetic Plex responses and run without signing in or connecting to a live server. Install the ZIP on SteamOS to verify gamepad navigation, real playback, and in-game picture-in-picture.

### Releases

Use `main` for development and version tags for releases. In GitHub Actions, the **Test and package** job runs the TypeScript check, frontend tests, and backend and package tests. It uploads an installable `DeckyPlex.zip` for pushes and pull requests to `main`, and for version tags.

#### First release

1. Commit the release changes and push `main`. In **Actions → Build and test**, wait for **Test and package** to pass. Copy the commit SHA from that run.
2. Fetch the commit, create the release tag on it, and push the tag. Replace `TESTED_COMMIT_SHA` with the SHA from step 1.

   ```bash
   git fetch origin
   git tag -a v1.0.0 TESTED_COMMIT_SHA -m "DeckyPlex 1.0.0"
   git push origin v1.0.0
   ```

3. Wait for **Build and test** to pass for the tag. In **Releases**, open the draft, check the notes and attached `DeckyPlex.zip`, and select **Publish release** when ready.

#### Later releases

1. Enable **Allow GitHub Actions to create and approve pull requests** in **Settings → Actions → General**. Use Conventional Commit messages for changes merged into `main`. Use `fix:` for patches, `feat:` for minor versions, and a `BREAKING CHANGE:` footer for major versions. If you squash a PR, put the prefix in the squash commit title.
2. After CI passes, [Release Please](https://github.com/googleapis/release-please-action) opens or updates a release PR with the next version and changelog. Merge it when ready. GitHub may ask you to approve the checks on the generated PR.
3. Wait for the release merge commit to pass **Test and package** on `main`. Tag that commit and push the tag using the commands above, with the new version in place of `1.0.0`. Review and publish the new draft from **Releases**.

## License

MIT
