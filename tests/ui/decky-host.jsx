import { createContext, forwardRef, useContext, useImperativeHandle, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

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
export function showModal(content) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  let resolve;
  const ClosedPromise = new Promise(done => { resolve = done; });
  root.render(content);
  return { ClosedPromise, Close() { root.unmount(); container.remove(); resolve(); } };
}
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

export function SliderField({ label, min, max, value, onChange, disabled }) {
  return <label className="fixture-slider">{label}<input type="range" aria-label={typeof label === 'string' ? label : 'Volume'}
    min={min} max={max} value={value} disabled={disabled}
    onChange={event => onChange(Number(event.target.value))} /></label>;
}
export function TextField({ label, description, value, onChange, placeholder, disabled, ...props }) {
  const input = <input {...domProps(props)} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />;
  return label ? <label className="fixture-field">{label}{input}
    {description && <small>{description}</small>}</label> : input;
}
export function ToggleField({ label, description, checked, disabled, onChange }) {
  return <label className="fixture-field"><span>{label}
    <input type="checkbox" role="switch" checked={!!checked} disabled={disabled}
      onChange={event => onChange(event.target.checked)} /></span>
    {description && <small>{description}</small>}</label>;
}
export function Dropdown({ label, rgOptions, selectedOption, disabled, onChange }) {
  return <label className="fixture-field">{label}
    <select value={selectedOption ?? ''} disabled={disabled}
      onChange={event => onChange({ data: event.target.value })}>
      {rgOptions.map(({ label, data }) => <option key={data} value={data}>{label}</option>)}
    </select></label>;
}
export const DropdownItem = Dropdown;
export function ButtonItem({ label, children, ...props }) {
  return <div>{label}<Button {...props}>{children}</Button></div>;
}
export function SidebarNavigation({ pages }) {
  const [active, setActive] = useState(0);
  return <div className="fixture-settings-sidebar">
    <div className="PageListColumn" role="tablist">
      {pages.map(({ title }, index) => <button type="button" key={title} role="tab" aria-selected={index === active}
        onClick={() => setActive(index)}>{title}</button>)}
    </div>
    <div key={active} role="tabpanel" className="fixture-settings-panel">
      <div className="DialogContent_InnerWidth">{pages[active].content}</div>
    </div>
  </div>;
}
export const PanelSection = ({ children }) => <section>{children}</section>;
export const PanelSectionRow = ({ children }) => <div>{children}</div>;
export const DialogBodyText = ({ children, ...props }) => <div {...domProps(props)}>{children}</div>;
export const DialogLabel = ({ children, ...props }) => <div className="fixture-label" {...domProps(props)}>{children}</div>;
export const DialogHeader = DialogLabel;
export const ModalRoot = props => <DialogBodyText {...props} role="dialog" />;
export const Spinner = () => <span role="status">Loading</span>;
