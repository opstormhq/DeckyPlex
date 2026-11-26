import { useEffect, useRef, useState, type Ref } from 'react';
import { Button, DialogBodyText, ToggleField } from '@decky/ui';
import { FaArrowRight, FaServer } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';
import { DeckyPlexModal } from './InterfaceTheme';

export interface PlexServerOption {
  id: string;
  name: string;
}

export interface LibraryChoice {
  id: string;
  name: string;
  type: string;
}

export interface LibraryCatalog {
  libraries?: LibraryChoice[];
  selected_ids?: string[];
  server_id?: string;
  error?: string;
}

const libraryTypes: Record<string, string> = { artist: 'Music', movie: 'Movies', show: 'TV shows', photo: 'Photos' };

export function LibraryRow({ library, included, disabled, onChange, rowRef }: {
  library: LibraryChoice;
  included: boolean;
  disabled?: boolean;
  onChange: (included: boolean) => void;
  rowRef?: Ref<HTMLDivElement>;
}) {
  return <div ref={rowRef} data-deckyplex-choice-row="" style={{ width: '100%' }}>
    <ToggleField label={<span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.45rem' }}>
      {library.name}<span style={{ opacity: 0.65, fontSize: '0.82em' }}>{libraryTypes[library.type]}</span>
    </span>} checked={included} disabled={disabled} onChange={onChange} bottomSeparator="none" highlightOnFocus />
  </div>;
}

export function PlexSetupDialog({ servers, defaultServerId, loadLibraries, complete, close, lightTheme }: {
  servers: PlexServerOption[];
  defaultServerId: string;
  loadLibraries: (serverId: string) => Promise<LibraryCatalog>;
  complete: (serverId: string, selectedIds: string[]) => Promise<void>;
  close: () => void;
  lightTheme?: boolean;
}) {
  const [server, setServer] = useState<PlexServerOption | null>(servers.length === 1 ? servers[0] : null);
  const [catalog, setCatalog] = useState<LibraryChoice[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loadingError, setLoadingError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  const savingRef = useRef(false);
  const firstServerRef = useRef<HTMLDivElement>(null);
  const firstLibraryRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!server) return;
    let active = true;
    void loadLibraries(server.id).then(result => {
      if (!active) return;
      if (result.error) throw new Error(result.error);
      if (result.server_id !== server.id) throw new Error('Plex returned libraries for a different server.');
      setCatalog(result.libraries || []);
      setSelectedIds(result.selected_ids || []);
    }).catch(error => {
      if (active) setLoadingError(error instanceof Error ? error.message : 'Could not load Plex libraries.');
    });
    return () => { active = false; };
  }, [loadLibraries, server, retry]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (!server) firstServerRef.current?.focus();
      else if (loadingError) retryRef.current?.focus();
      else if (catalog?.length) {
        firstLibraryRef.current?.querySelector<HTMLElement>('[tabindex="0"], button:not([disabled])')?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [server, catalog, loadingError]);

  const choose = (value: PlexServerOption | null) => {
    setCatalog(null);
    setSelectedIds([]);
    setLoadingError('');
    setSaveError('');
    setServer(value);
  };

  const confirm = async () => {
    if (!server || !catalog?.length || savingRef.current) return;
    if (!selectedIds.length) {
      setSaveError('Select at least one library.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      await complete(server.id, selectedIds);
      close();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save your Plex setup.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const cancel = () => {
    if (savingRef.current) return;
    if (server && servers.length > 1) choose(null);
    else close();
  };
  const defaultServer = servers.find(option => option.id === defaultServerId) || servers[0];
  return (
    <DeckyPlexModal lightTheme={lightTheme} closeModal={cancel} onCancel={cancel} onOK={() => {}}
      bCancelDisabled={saving} bDisableBackgroundDismiss={saving}>
      <ChoiceDialogBody title={server ? 'Choose Plex libraries' : 'Choose a Plex server'} subtitle={server?.name}>
      {!server ? (
        <ChoiceDialogList>
          {servers.map(option => <ChoiceDialogRow key={option.id} title={option.name} icon={<FaServer />} actionDescription="Choose server"
            rowRef={option === defaultServer ? firstServerRef : undefined}
            badge={option === defaultServer ? 'Default' : undefined} onChoose={() => choose(option)} />)}
        </ChoiceDialogList>
      ) : (
        <>
          {!catalog && !loadingError && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <InlineSpinner />Loading Plex libraries…
          </div>}
          {loadingError && (
            <>
              <DialogBodyText>{loadingError}</DialogBodyText>
              <Button ref={retryRef} onClick={() => { setLoadingError(''); setRetry(value => value + 1); }}>Try again</Button>
            </>
          )}
          {catalog?.length === 0 && <DialogBodyText>This server has no supported libraries.</DialogBodyText>}
          {!!catalog?.length && (
            <ChoiceDialogList centerFocused>
              {catalog.map((library, index) => (
                <LibraryRow key={library.id} library={library} included={selectedIds.includes(library.id)}
                  rowRef={index === 0 ? firstLibraryRef : undefined} disabled={saving}
                  onChange={included => {
                    if (savingRef.current) return;
                    setSaveError('');
                    setSelectedIds(current => included ? [...new Set([...current, library.id])] : current.filter(id => id !== library.id));
                  }} />
              ))}
              <ChoiceDialogRow title={saving ? 'Applying…' : 'Continue'}
                icon={saving ? <InlineSpinner /> : <FaArrowRight />}
                disabled={saving || !selectedIds.length} onChoose={() => void confirm()} />
            </ChoiceDialogList>
          )}
          {saveError && <DialogBodyText style={{ margin: '0.4rem', color: '#ffc1c1' }}>{saveError}</DialogBodyText>}

        </>
      )}
      </ChoiceDialogBody>
    </DeckyPlexModal>
  );
}
