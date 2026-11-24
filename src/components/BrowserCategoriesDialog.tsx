import { useLayoutEffect, useRef, useState } from 'react';
import { Button, DialogBodyText, Focusable, ModalRoot, ToggleField } from '@decky/ui';
import { FaArrowDown, FaArrowUp } from 'react-icons/fa';
import { orderCategories, type CategoryLayout } from './BrowserCategories';
import { ChoiceDialogBody, ChoiceDialogList } from './ChoiceDialog';
import { InlineSpinner } from './InlineSpinner';

export function BrowserCategoriesDialog({ title, categories, initialLayout, close, save }: {
  title: string;
  categories: readonly { key: string; title: string }[];
  initialLayout?: CategoryLayout;
  close: () => void;
  save: (layout: CategoryLayout) => Promise<void>;
}) {
  const [layout, setLayout] = useState<CategoryLayout>(initialLayout ?? { order: [], hidden: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const rows = orderCategories(categories, layout);
  const visible = new Set(rows.map(row => row.key));

  useLayoutEffect(() => {
    const element = restoreFocus.current;
    restoreFocus.current = null;
    if (element?.isConnected && element.ownerDocument.activeElement === element.ownerDocument.body) element.focus();
  }, [layout]);

  const update = async (next: CategoryLayout) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      await save(next);
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLayout(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save browser categories.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const move = (index: number, direction: number) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const order = rows.map(row => row.key);
    [order[index], order[target]] = [order[target], order[index]];
    void update({ ...layout, order: [...order, ...layout.order.filter(key => !visible.has(key))] });
  };

  return (
    <ModalRoot closeModal={close} onCancel={close} onOK={() => {}}
      bCancelDisabled={saving} bDisableBackgroundDismiss={saving}>
      <ChoiceDialogBody title={title}>
        <ChoiceDialogList>
          {rows.map(({ key, title }, index) => {
            const checked = !layout.hidden.includes(key);
            return (
              <Focusable key={key} data-deckyplex-choice-row="" flow-children="horizontal" style={{ display: 'flex', alignItems: 'center',
                gap: '0.4rem', padding: '0.15rem 0.5rem', flex: '0 0 auto', minWidth: 0,
                borderRadius: '0.5rem', background: 'rgba(255,255,255,0.06)' }}>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  <ToggleField label={title} checked={checked} bottomSeparator="none"
                    onChange={show => void update({ ...layout,
                      hidden: show ? layout.hidden.filter(hidden => hidden !== key) : [...layout.hidden, key] })} />
                </div>
                {rows.length > 1 && <>
                  <Button aria-label={`Move ${title} up`} onOKActionDescription="Move up" aria-disabled={index === 0}
                    style={{ opacity: index === 0 ? 0.45 : 1 }} onClick={() => move(index, -1)}>
                    <FaArrowUp aria-hidden="true" />
                  </Button>
                  <Button aria-label={`Move ${title} down`} onOKActionDescription="Move down" aria-disabled={index === rows.length - 1}
                    style={{ opacity: index === rows.length - 1 ? 0.45 : 1 }} onClick={() => move(index, 1)}>
                    <FaArrowDown aria-hidden="true" />
                  </Button>
                </>}
              </Focusable>
            );
          })}
        </ChoiceDialogList>
        {(saving || error) && <div role="status" style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '0.4rem', minHeight: '1.45rem', margin: '0.35rem 0.4rem 0' }}>
          {saving && <><InlineSpinner /><DialogBodyText style={{ margin: 0 }}>Saving…</DialogBodyText></>}
          {error && <DialogBodyText style={{ margin: 0 }}>{error}</DialogBodyText>}
        </div>}
      </ChoiceDialogBody>
    </ModalRoot>
  );
}
