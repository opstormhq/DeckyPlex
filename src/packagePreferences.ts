import { call, toaster } from '@decky/api';

interface DeckyBackendRouter {
  addEventListener: (event: string, handler: (...args: any[]) => void) => void;
  removeEventListener: (event: string, handler: (...args: any[]) => void) => void;
  call: (route: string, ...args: unknown[]) => Promise<unknown>;
}

export function preservePreferencesDuringUpdates() {
  const backend = (globalThis as typeof globalThis & { DeckyBackend?: DeckyBackendRouter }).DeckyBackend;
  if (!backend?.addEventListener || !backend.removeEventListener || !backend.call) return () => {};

  const pluginName = 'DeckyPlex';
  const pending = new Set<string>();
  const trackInstall = (name: string, _version: string, request: string) => {
    if (name === pluginName) pending.add(request);
  };
  const trackBatch = (request: string, plugins: { name: string }[]) => {
    if (plugins.some(plugin => plugin.name === pluginName)) pending.add(request);
  };
  const installPrompt = 'loader/add_plugin_install_prompt';
  const batchPrompt = 'loader/add_multiple_plugins_install_prompt';
  backend.addEventListener(installPrompt, trackInstall);
  backend.addEventListener(batchPrompt, trackBatch);

  const originalCall = backend.call;
  let activeUpdate: string | undefined;
  const confirmWithPreferences: DeckyBackendRouter['call'] = function (this: DeckyBackendRouter, route, ...args) {
    const forward = () => originalCall.call(this, route, ...args);
    const request = typeof args[0] === 'string' ? args[0] : '';
    if (route === 'utilities/cancel_plugin_install') pending.delete(request);
    if (route === 'utilities/uninstall_plugin' && request === pluginName && activeUpdate) {
      return call('finish_package_update', activeUpdate).then(forward);
    }
    if (route !== 'utilities/confirm_plugin_install' || !pending.delete(request)) return forward();

    // Decky uses the same uninstall hook for removal and replacement. Stage
    // preferences before the confirmed install can stop this backend.
    activeUpdate = request;
    return call('prepare_package_update', request).catch(error => {
      toaster.toast({ title: 'DeckyPlex update', body: 'Could not save preferences for this update.' });
      throw error;
    }).then(forward).finally(() => {
      if (activeUpdate === request) activeUpdate = undefined;
      void call('finish_package_update', request).catch(() => {});
    });
  };
  backend.call = confirmWithPreferences;

  return () => {
    backend.removeEventListener(installPrompt, trackInstall);
    backend.removeEventListener(batchPrompt, trackBatch);
    if (backend.call === confirmWithPreferences) backend.call = originalCall;
  };
}
