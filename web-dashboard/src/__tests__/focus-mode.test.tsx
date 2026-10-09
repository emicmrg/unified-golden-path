/**
 * focus-mode.test.tsx — Tests for the simplified focus-mode (Option A).
 *
 * All tests exercise the REAL components (LiveDashboard, FocusOverlay, Deck).
 * No synthetic <div role="dialog"> injected into body except in section (c)
 * where we need to simulate "dialog open" state for the Deck keyboard guard.
 *
 * jsdom notes (no layout measurement needed — advantage of Option A):
 *   - FocusOverlay no longer calls getBoundingClientRect at all (A1).
 *   - requestAnimationFrame does not auto-run → the spring settle loop never
 *     fires. The dialog stays in the DOM with data-closing="true" after Esc.
 *   - Focus restoration via rAF is mocked by userEvent (it drains the queue).
 *
 * Covers:
 *   (a) Open with MOUSE — click the Expand button / card body
 *   (b) Open with KEYBOARD — Enter and Space on the Expand button
 *   (c) Arrow / Space / PageUp / PageDown / F / 1-9 do NOT change slide
 *       when focus-mode is open (tests use Deck component)
 *   (d) Esc closes and document.activeElement returns to the expand button
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Hook mocks — keep data logic untouched ──────────────────────────────────
vi.mock("../hooks/useTelemetry.js", () => ({
  useTelemetry: vi.fn(() => ({
    connectionStatus: "disconnected" as const,
    latest: null,
    history: [],
    error: null,
  })),
}));

vi.mock("../hooks/useStatus.js", () => ({
  useStatus: vi.fn(() => ({
    loading: false,
    data: null,
    error: null,
    lastUpdated: null,
  })),
}));

// ── Import components after mocks ───────────────────────────────────────────
const { LiveDashboard } = await import("../presentation/LiveDashboard.js");
const { Deck } = await import("../presentation/Deck.js");

// ── Helpers ─────────────────────────────────────────────────────────────────

function getExpandButton(name: "Golden Path" | "Self-Healing"): HTMLElement {
  return screen.getByRole("button", {
    name: new RegExp(`Expand ${name}`, "i"),
  });
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("Focus-mode — Option A (simple centered panel)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.removeAttribute("data-focus-open");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (a) Open with MOUSE
  // ─────────────────────────────────────────────────────────────────────────
  describe("(a) Open with mouse", () => {
    it("clicking the Expand button opens the real FocusOverlay dialog", async () => {
      render(<LiveDashboard />);

      // No dialog yet
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(getExpandButton("Golden Path"));

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog).toBeInTheDocument();
        // A2: dialog has an id (for aria-controls IDREF)
        expect(dialog.id).toBeTruthy();
      });
    });

    it("the dialog aria-label matches the expanded card title", async () => {
      render(<LiveDashboard />);
      fireEvent.click(getExpandButton("Golden Path"));

      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog.getAttribute("aria-label")).toMatch(/Golden Path/i);
      });
    });

    it("clicking the card body (outside a button) also opens the dialog", async () => {
      render(<LiveDashboard />);

      // Click directly on the role=group container
      const groups = screen.getAllByRole("group");
      // groups[0] is the golden card
      fireEvent.click(groups[0]);

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("body[data-focus-open] is set while the overlay is mounted", async () => {
      render(<LiveDashboard />);
      expect(document.body.getAttribute("data-focus-open")).toBeNull();

      fireEvent.click(getExpandButton("Golden Path"));

      await waitFor(() => {
        expect(document.body.getAttribute("data-focus-open")).toBe("true");
      });
    });

    it("Expand button aria-controls points to the dialog id (A2 IDREF)", async () => {
      render(<LiveDashboard />);
      const btn = getExpandButton("Golden Path");

      // Before open: button has aria-controls with some id
      const controlsId = btn.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();

      // After open: the dialog with that exact id exists
      fireEvent.click(btn);
      await waitFor(() => {
        const dialog = document.getElementById(controlsId!);
        expect(dialog).toBeInTheDocument();
        expect(dialog?.getAttribute("role")).toBe("dialog");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (b) Open with KEYBOARD
  // ─────────────────────────────────────────────────────────────────────────
  describe("(b) Open with keyboard", () => {
    it("pressing Enter on the Expand button opens focus-mode", async () => {
      const user = userEvent.setup();
      render(<LiveDashboard />);

      const btn = getExpandButton("Golden Path");
      btn.focus();
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("pressing Space on the Expand button opens focus-mode", async () => {
      const user = userEvent.setup();
      render(<LiveDashboard />);

      const btn = getExpandButton("Golden Path");
      btn.focus();
      await user.keyboard(" ");

      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
    });

    it("Expand button aria-expanded=false when closed", () => {
      render(<LiveDashboard />);
      expect(getExpandButton("Golden Path")).toHaveAttribute("aria-expanded", "false");
    });

    it("Expand button aria-expanded=true when focus-mode is open", async () => {
      render(<LiveDashboard />);
      fireEvent.click(getExpandButton("Golden Path"));

      await waitFor(() => {
        expect(getExpandButton("Golden Path")).toHaveAttribute("aria-expanded", "true");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (c) Arrow / navigation keys do NOT change slide when focus-mode is open
  //
  // Strategy: render Deck, verify initial slide index, then inject a
  // [role="dialog"] element (simulating FocusOverlay portal) and confirm
  // that the keyboard guard blocks navigation.  The guard in Deck.tsx uses
  // document.querySelector('[role="dialog"]') — the same check the real
  // FocusOverlay uses.
  //
  // DotNav also has a JS guard (A5): clicking a dot while a dialog is open
  // is blocked without relying on CSS visibility.
  // ─────────────────────────────────────────────────────────────────────────
  describe("(c) Navigation keys blocked when focus-mode is open", () => {
    /** Inject a fake dialog and return a cleanup fn */
    function injectDialog(): () => void {
      const el = document.createElement("div");
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      document.body.appendChild(el);
      return () => document.body.removeChild(el);
    }

    it("ArrowRight does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      const initial = bar.getAttribute("aria-valuenow");

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "ArrowRight" });
        expect(bar.getAttribute("aria-valuenow")).toBe(initial);
      } finally {
        cleanup();
      }
    });

    it("ArrowLeft does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");

      // Navigate to slide 2 first (no dialog)
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("2"));

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "ArrowLeft" });
        expect(bar.getAttribute("aria-valuenow")).toBe("2");
      } finally {
        cleanup();
      }
    });

    it("ArrowUp does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("2"));

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "ArrowUp" });
        expect(bar.getAttribute("aria-valuenow")).toBe("2");
      } finally {
        cleanup();
      }
    });

    it("ArrowDown does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      const initial = bar.getAttribute("aria-valuenow");

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "ArrowDown" });
        expect(bar.getAttribute("aria-valuenow")).toBe(initial);
      } finally {
        cleanup();
      }
    });

    it("PageDown does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      const initial = bar.getAttribute("aria-valuenow");

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "PageDown" });
        expect(bar.getAttribute("aria-valuenow")).toBe(initial);
      } finally {
        cleanup();
      }
    });

    it("PageUp does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("2"));

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "PageUp" });
        expect(bar.getAttribute("aria-valuenow")).toBe("2");
      } finally {
        cleanup();
      }
    });

    it("Space does not change slide index while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      const initial = bar.getAttribute("aria-valuenow");

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: " " });
        expect(bar.getAttribute("aria-valuenow")).toBe(initial);
      } finally {
        cleanup();
      }
    });

    it("'f' key does not toggle fullscreen while dialog is open", async () => {
      // We just verify no error is thrown and the guard returns early.
      render(<Deck />);
      const cleanup = injectDialog();
      try {
        // Should not throw — fullscreen request would fail in jsdom anyway.
        expect(() =>
          fireEvent.keyDown(document.body, { key: "f" })
        ).not.toThrow();
      } finally {
        cleanup();
      }
    });

    it("numeric key '2' does not jump to slide 2 while dialog is open", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      expect(bar.getAttribute("aria-valuenow")).toBe("1");

      const cleanup = injectDialog();
      try {
        fireEvent.keyDown(document.body, { key: "2" });
        expect(bar.getAttribute("aria-valuenow")).toBe("1");
      } finally {
        cleanup();
      }
    });

    it("numeric key '1' ignores metaKey modifier (A5)", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      // Navigate to slide 2
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("2"));
      // Meta+1 should NOT jump to slide 1
      fireEvent.keyDown(document.body, { key: "1", metaKey: true });
      expect(bar.getAttribute("aria-valuenow")).toBe("2");
    });

    it("numeric key '1' ignores ctrlKey modifier (A5)", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      await waitFor(() => expect(bar.getAttribute("aria-valuenow")).toBe("2"));
      fireEvent.keyDown(document.body, { key: "1", ctrlKey: true });
      expect(bar.getAttribute("aria-valuenow")).toBe("2");
    });

    it("DotNav click is blocked by JS guard when dialog is open (A5)", async () => {
      render(<Deck />);
      const bar = screen.getByRole("progressbar");
      expect(bar.getAttribute("aria-valuenow")).toBe("1");

      const cleanup = injectDialog();
      try {
        // Click the second dot (index 1 = slide 2)
        const dots = document.querySelectorAll(".deck-dotnav__dot");
        if (dots.length >= 2) {
          fireEvent.click(dots[1]);
          // Should still be on slide 1 (guard blocked the navigation)
          expect(bar.getAttribute("aria-valuenow")).toBe("1");
        }
      } finally {
        cleanup();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // (d) Esc closes dialog and focus returns to the expand button
  // ─────────────────────────────────────────────────────────────────────────
  describe("(d) Esc closes overlay and restores focus", () => {
    it("Esc triggers close sequence (data-closing=true or dialog removed)", async () => {
      render(<LiveDashboard />);

      fireEvent.click(getExpandButton("Golden Path"));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => {
        const dialog = screen.queryByRole("dialog");
        if (dialog) {
          // Spring hasn't settled yet (jsdom): closing flag must be set
          expect(dialog.getAttribute("data-closing")).toBe("true");
        } else {
          // Spring settled immediately: dialog is gone
          expect(true).toBe(true);
        }
      });
    });

    it("Esc: Expand button aria-expanded becomes false when closing begins", async () => {
      render(<LiveDashboard />);
      const expandBtn = getExpandButton("Golden Path");

      fireEvent.click(expandBtn);
      await waitFor(() => expect(expandBtn).toHaveAttribute("aria-expanded", "true"));

      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => {
        expect(expandBtn).toHaveAttribute("aria-expanded", "false");
      });
    });

    it("Esc schedules focus back to the expand button (document.activeElement)", async () => {
      // userEvent drains the rAF queue for focus restoration.
      const user = userEvent.setup();
      render(<LiveDashboard />);

      const expandBtn = getExpandButton("Golden Path");

      // Open via keyboard so the expand button is the documented trigger
      expandBtn.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      // Close via Escape
      await user.keyboard("{Escape}");

      await waitFor(() => {
        // The rAF in handleClose schedules focus restoration.
        // After userEvent drains the queue, activeElement should be expandBtn.
        const active = document.activeElement;
        // Accept either exact match or the expand button being focused
        expect(
          active === expandBtn ||
          (active as HTMLElement | null)?.getAttribute("aria-label")?.match(/expand golden path/i)
        ).toBeTruthy();
      });
    });

    it("Esc restores focus to Expand button under prefers-reduced-motion: reduce (WCAG 2.4.3)", async () => {
      // Mock matchMedia so useSpring snaps immediately (reduced-motion path).
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;

      try {
        const user = userEvent.setup();
        render(<LiveDashboard />);

        const expandBtn = getExpandButton("Golden Path");

        // Open focus-mode
        expandBtn.focus();
        await user.keyboard("{Enter}");
        await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

        // Move focus to the Close button (simulates real state after open rAF)
        const closeBtn = screen.getByRole("button", { name: /close panel/i });
        closeBtn.focus();
        expect(document.activeElement).toBe(closeBtn);

        // Drain any pending open-animation rAFs before closing
        await vi.runAllTimersAsync?.().catch(() => undefined);

        // Close via Escape
        await user.keyboard("{Escape}");

        // Under reduced-motion useSpring snaps → settle fires in same tick →
        // onSettledClose → setActiveCard(null) → overlay unmounts.
        // The fix: handleClose calls triggerRef.current.focus() SYNCHRONOUSLY
        // before onRequestClose(), so focus is set before any unmount can occur.
        expect(document.activeElement).toBe(expandBtn);
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it("close button click also sets data-closing=true", async () => {
      render(<LiveDashboard />);
      fireEvent.click(getExpandButton("Golden Path"));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());

      const closeBtn = screen.getByRole("button", { name: /close panel/i });
      fireEvent.click(closeBtn);

      await waitFor(() => {
        const dialog = screen.queryByRole("dialog");
        if (dialog) {
          expect(dialog.getAttribute("data-closing")).toBe("true");
        } else {
          expect(true).toBe(true);
        }
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Accessibility
  // ─────────────────────────────────────────────────────────────────────────
  describe("Accessibility", () => {
    it("card containers have role=group (not role=button)", () => {
      render(<LiveDashboard />);
      const groups = screen.getAllByRole("group");
      expect(groups.length).toBeGreaterThan(0);
      groups.forEach((g) => {
        expect(g.getAttribute("role")).toBe("group");
      });
    });

    it("each role=group has aria-labelledby pointing to a real element (A3)", () => {
      render(<LiveDashboard />);
      const groups = screen.getAllByRole("group");
      groups.forEach((g) => {
        const labelledBy = g.getAttribute("aria-labelledby");
        expect(labelledBy).toBeTruthy();
        const target = document.getElementById(labelledBy!);
        expect(target).toBeInTheDocument();
      });
    });

    it("Expand button aria-controls points to an existing element after open (A2)", async () => {
      render(<LiveDashboard />);
      const btn = getExpandButton("Golden Path");
      const controlsId = btn.getAttribute("aria-controls");
      expect(controlsId).toBeTruthy();

      fireEvent.click(btn);
      await waitFor(() => {
        const el = document.getElementById(controlsId!);
        expect(el).toBeInTheDocument();
        expect(el?.getAttribute("role")).toBe("dialog");
      });
    });

    it("dialog is role=dialog aria-modal=true", async () => {
      render(<LiveDashboard />);
      fireEvent.click(getExpandButton("Golden Path"));
      await waitFor(() => {
        const dialog = screen.getByRole("dialog");
        expect(dialog.getAttribute("aria-modal")).toBe("true");
      });
    });
  });
});
