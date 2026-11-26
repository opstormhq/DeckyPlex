import { createContext, forwardRef, useContext, useImperativeHandle, useRef } from 'react';

export const HostContext = createContext(null);
export const usePlayer = () => useContext(HostContext);
export const call = (method, ...args) => window.fixture.rpc(method, ...args);
export const toaster = { toast: () => {} };
export const useQuickAccessVisible = () => true;
export const getExternalResourceURL = url => url;
export const GamepadButton = { CANCEL: 2, SECONDARY: 3, START: 4, SELECT: 5, DIR_UP: 6, DIR_DOWN: 7, DIR_LEFT: 8, DIR_RIGHT: 9 };
export const NavEntryPositionPreferences = { MAINTAIN_X: 1, PREFERRED_CHILD: 2 };
export const Navigation = { CloseSideMenus: () => window.fixture.actions.push(['close tray']) };
export const Router = {};
export const focusRingClasses = {};
export const gamepadDialogClasses = {};
export const gamepadContextMenuClasses = {};
export const quickAccessMenuClasses = {};
export const ESteamUISound = {};
export const findSP = () => undefined;
export const findModuleExport = () => undefined;
export const getFocusNavController = () => undefined;
export const getGamepadNavigationTrees = () => [];
export const showModal = () => { throw new Error('Modal outside the browser test fixture'); };
export const afterPatch = () => {};
export const callOriginal = () => {};
export const replacePatch = () => {};

const domEvents = new Set(['onClick', 'onFocus', 'onFocusCapture', 'onBlur', 'onKeyDown', 'onWheel', 'onPointerDown', 'onScroll']);
function domProps(props) {
  return Object.fromEntries(Object.entries(props).filter(([key]) =>
    key.startsWith('aria-') || key.startsWith('data-') || domEvents.has(key)
    || ['className', 'style', 'role', 'id', 'title'].includes(key)));
}

export const Button = forwardRef(function Button({ children, disabled, focusable, navRef, ...props }, forwardedRef) {
  const element = useRef(null);
  useImperativeHandle(forwardedRef, () => element.current);
  useImperativeHandle(navRef, () => ({ TakeFocus: () => element.current?.focus({ preventScroll: true }) }));
  return <button ref={element} {...domProps(props)} disabled={disabled}
    tabIndex={focusable === false ? -1 : undefined}>{children}</button>;
});

export const Focusable = forwardRef(function Focusable({ children, focusable, navRef, ...props }, forwardedRef) {
  const element = useRef(null);
  const actionable = Boolean(props.onClick || props.onActivate);
  useImperativeHandle(forwardedRef, () => element.current);
  useImperativeHandle(navRef, () => ({ TakeFocus: () => element.current?.focus({ preventScroll: true }) }));
  return <div ref={element} {...domProps(props)} tabIndex={focusable === false || !actionable ? undefined : 0}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (!event.defaultPrevented && actionable && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        props.onClick?.(event);
      }
    }}>{children}</div>;
});

export function SliderField({ label, min, max, value, onChange }) {
  return <label className="fixture-slider">{label}<input type="range" aria-label="Volume" min={min} max={max} value={value}
    onChange={event => onChange(Number(event.target.value))} /></label>;
}
export function TextField({ value, onChange, placeholder, ...props }) {
  return <input {...domProps(props)} value={value} onChange={onChange} placeholder={placeholder} />;
}
export const PanelSection = ({ children }) => <section>{children}</section>;
export const PanelSectionRow = ({ children }) => <div>{children}</div>;
export const DialogBodyText = ({ children, ...props }) => <div {...domProps(props)}>{children}</div>;
export const DialogLabel = ({ children, ...props }) => <div className="fixture-label" {...domProps(props)}>{children}</div>;
export const DialogHeader = DialogLabel;
export const ModalRoot = DialogBodyText;
export const Spinner = () => <span role="status">Loading</span>;
