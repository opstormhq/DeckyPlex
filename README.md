# DeckyPlex

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) music player for SteamOS. It connects to Plex Media Server, browses music libraries through the bundled Python PlexAPI SDK, and plays tracks in the Decky webview.

## Features

- **Music browser**: Browse artists, albums, tracks, and search a selected Plex music library.
- **Quick player**: Play, pause, seek, and adjust volume from the Decky sidebar.
- **Plex login**: Sign in with a Plex PIN and select a server.

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

## Usage

- Open **Browse Music** from the Decky sidebar to browse and play tracks.
- Use the quick player in the sidebar for playback and volume controls.
- Open **Settings** to sign in to Plex and select a server.

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
