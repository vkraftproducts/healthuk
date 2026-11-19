import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

configure({ asyncUtilTimeout: 10_000 });

// Ant Design Table / Grid use matchMedia.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

afterEach(() => cleanup());

// Ant Design layout/motion queries pseudo-elements jsdom does not implement.
const nativeGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((elt: Element, pseudo?: string | null) => {
  if (pseudo) {
    return nativeGetComputedStyle(elt);
  }
  return nativeGetComputedStyle(elt);
}) as typeof window.getComputedStyle;