import { useEffect, useRef, useState, type Ref } from 'react';
import { Button, DialogBodyText, DialogCheckbox, Focusable, ModalRoot, PanelSectionRow } from '@decky/ui';
import { FaServer } from 'react-icons/fa';
import { ChoiceDialogBody, ChoiceDialogList, ChoiceDialogRow } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';

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

export function LibraryRow({ library, checked, disabled, onChange, checkboxRef }: {
  library: LibraryChoice;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  checkboxRef?: Ref<HTMLDivElement>;
}) {
  return (
    <PanelSectionRow>
      <DialogCheckbox ref={checkboxRef} checked={checked} disabled={disabled} onChange={onChange}
        label={<span style={{ display: 'flex', alignItems: 'baseline', gap: '0.65rem', minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={library.name}>{library.name}</span>
          <span style={{ fontSize: '0.8em', opacity: 0.65, flexShrink: 0 }}>{libraryTypes[library.type]}</span>
        </span>}
      />
    </PanelSectionRow>
  );
}

export function PlexSetupDialog({ servers, defaultServerId, loadLibraries, complete, close }: {
  servers: PlexServerOption[];
  defaultServerId: string;
  loadLibraries: (serverId: string) => Promise<LibraryCatalog>;
  complete: (serverId: string, selectedIds: string[]) => Promise<void>;
  close: () => void;
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
  const footerRef = useRef<HTMLDivElement>(null);
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
      else if (catalog?.length) firstLibraryRef.current?.focus();
      else if (catalog) footerRef.current?.focus();
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
    if (!server || !selectedIds.length || savingRef.current) return;
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

  const cancel = () => { if (!savingRef.current) close(); };
  const defaultServer = servers.find(option => option.id === defaultServerId) || servers[0];
  return (
    <ModalRoot closeModal={cancel} onCancel={cancel} onOK={() => {}} bCancelDisabled={saving} bDisableBackgroundDismiss={saving}>
      <ChoiceDialogBody title={server ? 'Choose Plex libraries' : 'Choose a Plex server'}>
      {!server ? (
        <ChoiceDialogList>
          {servers.map(option => <ChoiceDialogRow key={option.id} title={option.name} icon={<FaServer />} actionDescription="Choose server"
            rowRef={option === defaultServer ? firstServerRef : undefined}
            badge={option === defaultServer ? 'Default' : undefined} onChoose={() => choose(option)} />)}
        </ChoiceDialogList>
      ) : (
        <>
          <DialogBodyText style={{ margin: '0 0 0.4rem' }}>{server.name}</DialogBodyText>
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
            <ChoiceDialogList>
              {catalog.map((library, index) => (
                <LibraryRow key={library.id} library={library} checked={selectedIds.includes(library.id)} disabled={saving}
                  checkboxRef={index === 0 ? firstLibraryRef : undefined}
                  onChange={checked => setSelectedIds(current => checked
                    ? [...new Set([...current, library.id])]
                    : current.filter(id => id !== library.id))} />
              ))}
            </ChoiceDialogList>
          )}
          {saveError && <DialogBodyText>{saveError}</DialogBodyText>}
          <Focusable flow-children="horizontal" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            {servers.length > 1 && <Button disabled={saving} onClick={() => choose(null)}>Change server</Button>}
            {catalog && <Button ref={footerRef} disabled={saving || (catalog.length > 0 && !selectedIds.length)}
              onClick={catalog.length ? confirm : cancel}>
              {saving ? <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><InlineSpinner />Applying…</span> : 'Done'}
            </Button>}
          </Focusable>
        </>
      )}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
