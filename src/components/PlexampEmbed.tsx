import { useState, useEffect } from 'react';
import { Spinner, Button, DialogBodyText, DialogLabel } from '@decky/ui';
import { call } from '@decky/api';

export function PlexampEmbed() {
  const [plexampUrl, setPlexampUrl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call("get_settings")
      .then((result: any) => {
        const url = result?.plexamp_url || "";
        if (!url) {
          setError("Plexamp instance not found. Make sure Plexamp is running on your network and log in to Settings.");
          setLoading(false);
          return;
        }
        setPlexampUrl(url);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load settings. Using default URL.");
        setLoading(false);
      });
  }, []);

  const handleIframeLoad = () => {
    setLoading(false);
    setError(null);
  };

  const handleIframeError = () => {
    setLoading(false);
    setError(
      "Unable to load Plexamp. Make sure Plexamp is running and the URL is correct in Settings."
    );
  };

  const handleReload = () => {
    setLoading(true);
    setError(null);
    setPlexampUrl((prev) => prev);
  };

  if (error && !loading) {
    return (
      <div style={{ padding: "1rem" }}>
        <DialogLabel>{error}</DialogLabel>
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <Button onClick={() => handleReload()}>Retry</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {loading && (
        <div style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.5rem",
        }}>
          <Spinner />
          <DialogBodyText>Loading Plexamp...</DialogBodyText>
        </div>
      )}
      <iframe
        src={plexampUrl}
        title="Plexamp"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          backgroundColor: "#000",
        }}
        onLoad={handleIframeLoad}
        onError={handleIframeError}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
      />
    </div>
  );
}
