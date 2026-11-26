import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function loadModule(url, globals = {}) {
  const { outputText } = ts.transpileModule(readFileSync(url, 'utf8'), {
    fileName: fileURLToPath(url),
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX,
    },
  });
  const sandbox = { exports: {}, ...globals };
  runInNewContext(outputText, sandbox, { filename: fileURLToPath(url) });
  return sandbox.exports;
}

const jsx = (type, props) => ({ type, props });
export const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };

export function hostModules(modules) {
  return name => {
    if (!(name in modules)) throw new Error(`No host fixture for ${name}`);
    return modules[name];
  };
}

export function renderHooks() {
  const hooks = [];
  let index = 0;
  let effects = [];
  const reuse = deps => {
    const hook = hooks[index];
    return deps && hook?.deps && deps.length === hook.deps.length
      && deps.every((value, i) => Object.is(value, hook.deps[i]));
  };
  return {
    react: {
      createElement(type, props, ...children) {
        return jsx(type, { ...props, children });
      },
      useState(initial) {
        const slot = index++;
        if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
        return [hooks[slot], next => {
          hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next;
        }];
      },
      useRef(initial) {
        return hooks[index++] ??= { current: initial };
      },
      useCallback(callback, deps) {
        if (!reuse(deps)) hooks[index] = { callback, deps };
        return hooks[index++].callback;
      },
      useEffect(effect, deps) {
        const run = !reuse(deps);
        const slot = index++;
        if (run) effects.push(() => {
          hooks[slot]?.cleanup?.();
          hooks[slot] = { deps, cleanup: effect() };
        });
      },
    },
    render(component, attachRefs) {
      index = 0;
      effects = [];
      const tree = component();
      attachRefs?.(tree);
      effects.forEach(effect => effect());
      return tree;
    },
  };
}

export function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
}

export function nodeText(node) {
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node && typeof node === 'object') return nodeText(node.props?.children);
  return typeof node === 'string' ? node : '';
}
