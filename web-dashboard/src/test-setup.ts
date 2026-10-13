/**
 * test-setup.ts — Setup de Vitest + @testing-library/jest-dom.
 *
 * Also mocks browser APIs not implemented by jsdom:
 *   - IntersectionObserver (used by ScrollDeck / useSectionVisible)
 *   - scrollIntoView (used by keyboard navigation)
 */
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// IntersectionObserver mock (jsdom does not implement it)
// ---------------------------------------------------------------------------

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];

  private _callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this._callback = callback;
  }

  observe(_target: Element): void {
    // Trigger callback with isIntersecting=false by default so sections
    // start as not visible.
    this._callback(
      [{ isIntersecting: false, target: _target } as unknown as IntersectionObserverEntry],
      this,
    );
  }

  unobserve(_target: Element): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

// ---------------------------------------------------------------------------
// scrollIntoView mock (jsdom does not implement scroll)
// ---------------------------------------------------------------------------

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  writable: true,
  configurable: true,
  value: () => { /* no-op */ },
});
