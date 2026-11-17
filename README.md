# DeckyPlex

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) music player for SteamOS. It connects to Plex Media Server, browses music libraries through the bundled Python PlexAPI SDK, and plays tracks in the Decky webview.

## Features

- **Music browser**: Browse artists, albums, tracks, and search a selected Plex music library.
- **Quick player**: Play, pause, seek, and adjust volume from the Decky sidebar.
- **Plex login**: Sign in with a Plex PIN and select a server.
- **Remote Plex players**: Start music on and control connected Plex clients such as Plexamp on a phone.
- **Plex Companion receiver**: Advertise DeckyPlex on the local network so Plexamp can send music to the Steam Machine.
- **Advanced connection settings**: Override automatic discovery with a local server IP, set a connection timeout, and configure HTTPS certificate verification.

## Prerequisites

- Steam Machine with [Decky Loader](https://github.com/583531/DeckyLoader) installed
- Access to a Plex Media Server

## Installation

1. Build the plugin:
   ```bash
   npm install
   npm run build
   ```
2. Install the plugin on your Steam Machine via Decky Loader (copy the plugin folder to your Decky plugins directory or use the Decky CLI).

No additional Python dependencies are needed — `plexapi` is bundled with the plugin.

## Configuration

1. Open the Decky menu and navigate to **DeckyPlex > Settings**.
2. Sign in with the Plex PIN.
3. Select a Plex server with a music library.
4. To play on another Plex client, open **Settings > Players**, refresh the list, select a connected player, and choose it as the playback target.
5. If automatic discovery selected an unreachable server address, open **Settings > Advanced** and enter the server's local IP address.
6. Plexamp can discover DeckyPlex as a receiver when both devices are on the same LAN and local GDM discovery is allowed. DeckyPlex listens on TCP 32435 and UDP 32412 for Plex Companion traffic.

## Usage

- Open **Browse Music** from the Decky sidebar to browse and play tracks.
- Use the quick player in the sidebar for playback and volume controls.
- Open **Settings** to sign in to Plex and select a server.
- Select a remote player in **Settings > Players** to send playback and controls to Plexamp or another online Plex client.

### Using Plexamp on a phone as a remote

DeckyPlex advertises a local Plex Companion player endpoint and routes received track, playback, seek, and volume commands to the Decky audio engine. Incoming playback uses the Plex server selected in Settings. Plex Companion discovery requires the devices to share a local network; GDM uses UDP discovery and the receiver uses TCP 32435. The receiver status appears in **Settings > Players**.

## Development

```bash
npm install
npm run watch  # Watch mode for development
```

To rebuild bundled Python dependencies:

```bash
pip install -r requirements.txt --target defaults/
```

## License

MIT
