/**
 * Dev-support shim for the feed prototype test harness.
 *
 * feed-primitives.test.tsx serializes rendered instances with
 * `instance.toJSON()` (its segmentByLabel helper), but react-test-renderer
 * 19.1.0 only defines toJSON on the renderer object, not on
 * ReactTestInstance (see react-test-renderer/cjs ...development.js: the class
 * prototype exposes find/findAll/type/props/parent/children and nothing else).
 *
 * When a test environment is detected this attaches a serializer to
 * react-test-renderer's instance prototype. It is inert in app builds:
 * - it does nothing unless globalThis.IS_REACT_ACT_ENVIRONMENT is true (only
 *   test files set that), and
 * - react-test-renderer is a devDependency, so release bundles resolve the
 *   require to nothing (Metro treats requires in try/catch as optional).
 *
 * Revisit once the harness stops serializing instances or react-test-renderer
 * ships toJSON on instances.
 */
import { createElement } from 'react';

declare const require: (moduleId: string) => unknown;

type FiberLike = {
  tag: number;
  type: unknown;
  memoizedProps?: Record<string, unknown> | string | null;
  child?: FiberLike | null;
  sibling?: FiberLike | null;
};

type InstanceJson = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
};

type JsonNode = InstanceJson | string;

type TestInstanceLike = { _fiber?: FiberLike };

// React fiber tags treated as nodes in the serialized tree.
const INSTANCE_TAGS = new Set([0, 1, 5, 15, 26, 27]);
// React fiber tags that render transparently to their children.
const TRANSPARENT_TAGS = new Set([3, 4, 7, 8, 9, 10, 11, 12, 14, 17, 21]);
// Host text.
const HOST_TEXT_TAG = 6;

function propsWithoutChildren(props: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { children: _children, ...rest } = props ?? {};
  return rest;
}

function siblingFibers(fiber: FiberLike | null | undefined): FiberLike[] {
  const fibers: FiberLike[] = [];
  let node: FiberLike | null | undefined = fiber;
  while (node) {
    fibers.push(node);
    node = node.sibling ?? null;
  }
  return fibers;
}

function toJsonObject(fiber: FiberLike | null | undefined): JsonNode | JsonNode[] | null {
  if (!fiber) return null;
  if (fiber.tag === HOST_TEXT_TAG) {
    return `${fiber.memoizedProps ?? ''}`;
  }
  if (INSTANCE_TAGS.has(fiber.tag)) {
    return {
      type: fiber.type,
      props: propsWithoutChildren(fiber.memoizedProps as Record<string, unknown> | null | undefined),
      children: toJsonChildren(fiber.child),
    };
  }
  if (TRANSPARENT_TAGS.has(fiber.tag)) {
    return toJsonChildren(fiber.child);
  }
  return null;
}

function toJsonChildren(fiber: FiberLike | null | undefined): Array<JsonNode> {
  return siblingFibers(fiber)
    .map(toJsonObject)
    .flatMap((entry) => (Array.isArray(entry) ? entry : entry !== null && entry !== undefined ? [entry] : []));
}

let attachedToRuntime = false;

function patchInstancePrototype(prototypeOfInstances: object): void {
  const instancePrototype = prototypeOfInstances as { toJSON?: unknown };
  if (typeof instancePrototype.toJSON === 'function') {
    // A react-test-renderer version providing toJSON is already in place.
    attachedToRuntime = true;
    return;
  }

  Object.defineProperty(instancePrototype, 'toJSON', {
    value: function reactTestInstanceToJSON(this: TestInstanceLike): unknown {
      try {
        return toJsonObject(this._fiber ?? null);
      } catch {
        return null;
      }
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });

  attachedToRuntime = true;
}

function attach(): void {
  if (attachedToRuntime) return;

  const globalScope = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  if (globalScope.IS_REACT_ACT_ENVIRONMENT !== true) return;

  let create: (element: unknown) => { root: object; unmount: () => void };
  let act: (fn: () => void) => unknown;
  try {
    const reactTestRenderer = require('react-test-renderer') as {
      create?: unknown;
      act?: unknown;
    };
    if (typeof reactTestRenderer?.create !== 'function' || typeof reactTestRenderer?.act !== 'function') return;
    create = reactTestRenderer.create as (element: unknown) => { root: object; unmount: () => void };
    act = reactTestRenderer.act as (fn: () => void) => unknown;
  } catch {
    // react-test-renderer is dev-only; not bundled in release builds.
    return;
  }

  // RTR materializes a renderer's root only after act flushes, so capture the
  // shared ReactTestInstance prototype in the act continuation. Method lookup
  // happens at call time, so instances mounted before this still pick toJSON
  // up. Test files run several awaits before reading instances.
  try {
    void Promise.resolve(
      act(() => {
        currentProbe = create(createElement('View'));
      }),
    ).then(
      () => {
        const probe = currentProbe;
        currentProbe = null;
        if (!probe) return;
        const prototypeOfInstances = Object.getPrototypeOf(probe.root) as object | null;
        probe.unmount();
        if (prototypeOfInstances && typeof prototypeOfInstances === 'object') {
          patchInstancePrototype(prototypeOfInstances);
        }
      },
      () => {
        // inert: the prototype stays unpatched and the harness fails loudly.
      },
    );
  } catch {
    // inert
  }
}

let currentProbe: { root: object; unmount: () => void } | null = null;

attach();