import assert from 'node:assert/strict';
import test from 'node:test';
import { hostModules, loadModule } from './fixtures/frontend.mjs';

const installPrompt = 'loader/add_plugin_install_prompt';
const batchPrompt = 'loader/add_multiple_plugins_install_prompt';
const confirm = 'utilities/confirm_plugin_install';
const cancel = 'utilities/cancel_plugin_install';
const uninstall = 'utilities/uninstall_plugin';

function fixture({ failCheckpoint = false } = {}) {
  const calls = [];
  const listeners = new Map();
  const backend = {
    addEventListener(event, handler) { listeners.set(event, handler); },
    removeEventListener(event, handler) {
      assert.equal(listeners.get(event), handler);
      listeners.delete(event);
    },
    async call(route, ...args) {
      assert.equal(this, backend);
      calls.push([route, ...args]);
    },
  };
  const original = backend.call;
  const { preservePreferencesDuringUpdates } = loadModule(new URL('../src/packagePreferences.ts', import.meta.url), {
    DeckyBackend: backend,
    require: hostModules({
      '@decky/api': {
        async call(method, request) {
          calls.push([method, request]);
          if (failCheckpoint && method === 'prepare_package_update') throw new Error('disk full');
        },
        toaster: { toast: ({ title }) => calls.push(['toast', title]) },
      },
    }),
  });
  const detach = preservePreferencesDuringUpdates();
  return {
    backend, calls, detach, listeners, original,
    prompt(event, ...args) { listeners.get(event)(...args); },
  };
}

test('a confirmed update checkpoints preferences before Decky replaces the plugin', async () => {
  const { backend, calls, prompt } = fixture();
  prompt(installPrompt, 'DeckyPlex', '1.0.1', 'update');
  await backend.call(confirm, 'update');
  assert.deepEqual(calls, [
    ['prepare_package_update', 'update'],
    [confirm, 'update'],
    ['finish_package_update', 'update'],
  ]);
});

test('canceled updates, unrelated plugins, and plain uninstalls bypass the checkpoint', async () => {
  const { backend, calls, prompt } = fixture();
  prompt(installPrompt, 'Another Plugin', '1.0.1', 'other');
  await backend.call(confirm, 'other');
  prompt(installPrompt, 'DeckyPlex', '1.0.1', 'canceled');
  await backend.call(cancel, 'canceled');
  await backend.call(confirm, 'canceled');
  await backend.call(uninstall, 'DeckyPlex');
  assert.deepEqual(calls, [[confirm, 'other'], [cancel, 'canceled'], [confirm, 'canceled'], [uninstall, 'DeckyPlex']]);
});

test('batch updates preserve DeckyPlex preferences and detaching restores the native router', async () => {
  const { backend, calls, detach, listeners, original, prompt } = fixture();
  prompt(batchPrompt, 'batch', [{ name: 'Another Plugin' }, { name: 'DeckyPlex' }]);
  await backend.call(confirm, 'batch');
  assert.deepEqual(calls, [['prepare_package_update', 'batch'], [confirm, 'batch'], ['finish_package_update', 'batch']]);
  detach();
  assert.equal(backend.call, original);
  assert.equal(listeners.size, 0);
});

test('a failed checkpoint blocks installation and clears interception for a later uninstall', async () => {
  const { backend, calls, prompt } = fixture({ failCheckpoint: true });
  prompt(installPrompt, 'DeckyPlex', '1.0.1', 'failed');
  await assert.rejects(backend.call(confirm, 'failed'), /disk full/);
  await backend.call(uninstall, 'DeckyPlex');
  assert.deepEqual(calls, [
    ['prepare_package_update', 'failed'],
    ['toast', 'DeckyPlex update'],
    ['finish_package_update', 'failed'],
    [uninstall, 'DeckyPlex'],
  ]);
});
