import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function host(name: string) {
  return React.forwardRef(function Host(
    props: { children?: React.ReactNode; [key: string]: unknown },
    _ref: React.Ref<unknown>,
  ) {
    return React.createElement(name, props, props.children);
  });
}

function loadErrorBoundary(): React.ComponentType<{ children?: React.ReactNode }> {
  const transpile = (file: string): string => ts.transpileModule(
    readFileSync(new URL(file, import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;

  const View = host('View');
  const Text = host('Text');
  const Pressable = host('Pressable');
  const exports: { ErrorBoundary?: React.ComponentType<{ children?: React.ReactNode }> } = {};
  const sandboxRequire = (name: string): unknown => {
    if (name === 'react') return React;
    if (name === 'react-native') {
      return { View, Text, Pressable, StyleSheet: { create: (styles: unknown) => styles } };
    }
    // Style values never matter to the boundary copy; only the tokens it touches.
    if (name === '@/theme') {
      return {
        semantic: { background: { screen: '#0b0b0b' }, text: { primary: '#ffffff', dim: '#8a8a8a', accent: '#ffd166' } },
        tokens: { spacing: { sm: 8, md: 12, lg: 16, xl: 24 }, fontSize: { sm: 12, md: 14, lg: 16 }, radius: { xs: 4 } },
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };
  runInNewContext(
    transpile('./ErrorBoundary.tsx'),
    {
      exports,
      require: sandboxRequire,
      React,
      // The fixture realm has its own console; forward so act's patch and the
      // test's mock see componentDidCatch's log.
      console: {
        warn: (...args: unknown[]) => console.warn(...args),
        error: (...args: unknown[]) => console.error(...args),
      },
    },
    { filename: 'ErrorBoundary.fixture.js' },
  );

  return exports.ErrorBoundary!;
}

test('a throwing child is logged by componentDidCatch behind the unchanged error screen', async () => {
  const ErrorBoundary = loadErrorBoundary();
  const boom = new Error('render boom from child');

  class Thrower extends React.Component {
    render(): React.ReactNode {
      if (!boom) return null;
      throw boom;
    }
  }

  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(React.createElement(ErrorBoundary, null, React.createElement(Thrower)));
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(renderer, 'expected a rendered boundary');

  // The error screen copy is exactly what the app shows today.
  const strings: string[] = [];
  renderer.root.findAll(() => true).forEach((node) => {
    const child = node.props && node.props.children;
    if (typeof child === 'string') strings.push(child);
  });
  assert.ok(strings.includes('Something went wrong'));
  assert.ok(strings.includes('The app ran into an unexpected error. Tap below to try again.'));
  assert.ok(strings.includes('Try Again'));

  // componentDidCatch ran: the boundary logged its tag with the child's error
  // plus a stack. (act rewrites console.error into a format-string call, so
  // assert contents, not argument positions.)
  const boundary = logged.find((args) => args.includes('[ErrorBoundary] Unexpected error:'));
  assert.ok(boundary, `expected componentDidCatch to log the thrown error, got ${JSON.stringify(logged)}`);
  assert.ok(boundary.includes(boom), `expected the logged entry to carry the error, got ${JSON.stringify(boundary)}`);
  assert.ok(
    boundary.some((arg) => typeof arg === 'string' && arg.includes('Thrower')),
    `expected a component stack naming Thrower, got ${JSON.stringify(boundary)}`,
  );
});
