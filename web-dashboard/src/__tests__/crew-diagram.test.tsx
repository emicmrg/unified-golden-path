/**
 * crew-diagram.test.tsx — Tests for CrewDiagram component (Diagrama B).
 *
 * Mirrors arch-diagram.test.tsx pattern exactly.
 *
 * FOCUS ORDER:
 *   Step 0 = Overview (no highlight)
 *   Step 1 = CI Log Analyst (agent card 1)
 *   Step 2 = CI Repair Engineer (agent card 2)
 *   Step 3 = CI Patch Reviewer (agent card 3)
 *   Step 4 = Shared Runtime / Harness (Bedrock + guardrails)
 *   Step 5 = Final Overview
 *
 * Covers:
 *   (a) Renders without crashing — smoke tests (via SubStepContext)
 *   (b) Overview mode (step 0): region, SVG image, aria-live present
 *   (c) Controlled step changes via context render correct sidebar
 *   (d) CREW_DIAGRAM_STEP_COUNT is correct
 *   (e) Scrim overlay renders at step > 0 with bbox, absent at step 0
 *   (f) FOCUS_BOXES contain agent cards in correct positions
 *   (g) Sub-step navigation doesn't remount the component
 *   (h) Sidebar content fidelity: real data from agents.py / tasks.py
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SVG asset imports — Vite resolves them, but jsdom does not
vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));

// Mock CSS imports
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

const {
  CrewDiagram,
  CREW_DIAGRAM_STEP_COUNT,
  CREW_FOCUS_BOXES,
  CREW_STEPS,
  CREW_SVG_VB_W,
  CREW_SVG_VB_H,
  CrewSubStepContext,
} = await import("../presentation/CrewDiagram.js");

// ── Helper: render with a specific sub-step via context ──────────────────────

function renderAtStep(step: number, isActive = true) {
  return render(
    <CrewSubStepContext.Provider value={{ subStep: step, isActive }}>
      <CrewDiagram />
    </CrewSubStepContext.Provider>,
  );
}

// Helper: get the service explanation sidebar (step > 0)
function getSidebar() {
  return screen.getByRole("complementary", { name: /Explanation/i });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("CrewDiagram — Lucid SVG background + scrim overlay (Diagrama B)", () => {

  // ── (a) Smoke tests ───────────────────────────────────────────────────────

  it("(a) renders without crashing at step 0", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-diagram")).toBeInTheDocument();
  });

  it("(a) renders the CrewAI agents region with correct role", () => {
    renderAtStep(0);
    expect(
      screen.getByRole("region", { name: /CrewAI Agents Diagram/i }),
    ).toBeInTheDocument();
  });

  // ── (b) Overview mode ─────────────────────────────────────────────────────

  it("(b) overview mode: renders the crew SVG background image", () => {
    renderAtStep(0);
    const img = screen.getByRole("img", { name: /CrewAI self-healing agents diagram/i });
    expect(img).toBeInTheDocument();
    expect(img.tagName.toLowerCase()).toBe("img");
  });

  it("(b) overview mode: aria-live status region present", () => {
    renderAtStep(0);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("(b) overview mode: shows 'Press → to explore each agent' hint", () => {
    renderAtStep(0);
    // The hint text appears in both the aria-live region and the visible aside.
    // getAllByText handles that; we assert at least one element contains it.
    const matches = screen.getAllByText(/to explore each agent/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("(b) overview mode: shows overview sidebar card (NOT Explanation sidebar)", () => {
    renderAtStep(0);
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  // ── (c) Controlled step changes via context ───────────────────────────────

  it("(c) step 1 shows CI Log Analyst sidebar", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/CI Log Analyst/i);
  });

  it("(c) step 2 shows CI Repair Engineer sidebar", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/CI Repair Engineer/i);
  });

  it("(c) step 3 shows CI Patch Reviewer sidebar", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/CI Patch Reviewer/i);
  });

  it("(c) step 4 shows Shared Runtime sidebar", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/Shared Runtime/i);
  });

  it("(c) last step (5) is final overview — no crash", () => {
    renderAtStep(CREW_DIAGRAM_STEP_COUNT - 1);
    const region = screen.getByRole("region", { name: /CrewAI Agents Diagram/i });
    expect(region).toBeInTheDocument();
  });

  it("(c) sidebar step counter shows correct fraction at step 2", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(
      new RegExp(`2\\s*/\\s*${CREW_DIAGRAM_STEP_COUNT - 1}`),
    );
  });

  it("(c) re-render via context change shows new sidebar (no remount)", () => {
    const { rerender } = render(
      <CrewSubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <CrewDiagram />
      </CrewSubStepContext.Provider>,
    );
    expect(getSidebar()).toHaveTextContent(/CI Log Analyst/i);

    rerender(
      <CrewSubStepContext.Provider value={{ subStep: 2, isActive: true }}>
        <CrewDiagram />
      </CrewSubStepContext.Provider>,
    );
    expect(getSidebar()).toHaveTextContent(/CI Repair Engineer/i);
  });

  // ── (d) CREW_DIAGRAM_STEP_COUNT ───────────────────────────────────────────

  it("(d) CREW_DIAGRAM_STEP_COUNT is 6 (steps 0..5)", () => {
    expect(CREW_DIAGRAM_STEP_COUNT).toBe(6);
  });

  it("(d) step counter shows correct total steps at step 1", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/1\s*\/\s*5/);
  });

  // ── (e) Scrim overlay ─────────────────────────────────────────────────────

  it("(e) scrim overlay absent at step 0 (overview, no highlight)", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  it("(e) scrim overlay present at step 1 (log-analyst focus)", () => {
    const { container } = renderAtStep(1);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(e) scrim overlay present at step 4 (shared runtime focus)", () => {
    const { container } = renderAtStep(4);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(e) scrim overlay absent at step 5 (final overview, null bbox)", () => {
    const { container } = renderAtStep(5);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  // ── (f) FOCUS_BOXES contain the correct agent positions ──────────────────

  it("(f) CREW_FOCUS_BOXES.length === CREW_DIAGRAM_STEP_COUNT", () => {
    expect(CREW_FOCUS_BOXES.length).toBe(CREW_DIAGRAM_STEP_COUNT);
  });

  it("(f) step 0 (overview) has null bbox", () => {
    expect(CREW_FOCUS_BOXES[0]).toBeNull();
  });

  it("(f) step 5 (final overview) has null bbox", () => {
    expect(CREW_FOCUS_BOXES[5]).toBeNull();
  });

  it("(f) step 1 (log-analyst) bbox is in left third of diagram (x < 800)", () => {
    const bbox = CREW_FOCUS_BOXES[1];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeLessThan(800);
      expect(bbox.x).toBeGreaterThan(500);
    }
  });

  it("(f) step 2 (fix-engineer) bbox is in center of diagram (800 < x < 1400)", () => {
    const bbox = CREW_FOCUS_BOXES[2];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(800);
      expect(bbox.x).toBeLessThan(1400);
    }
  });

  it("(f) step 3 (reviewer) bbox is in right third of diagram (x > 1400)", () => {
    const bbox = CREW_FOCUS_BOXES[3];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(1400);
    }
  });

  it("(f) agent cards 1, 2, 3 are at the same vertical position (y within 20px)", () => {
    const b1 = CREW_FOCUS_BOXES[1];
    const b2 = CREW_FOCUS_BOXES[2];
    const b3 = CREW_FOCUS_BOXES[3];
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b3).not.toBeNull();
    if (b1 && b2 && b3) {
      expect(Math.abs(b1.y - b2.y)).toBeLessThan(20);
      expect(Math.abs(b1.y - b3.y)).toBeLessThan(20);
    }
  });

  it("(f) step 4 (Bedrock/crewai card) bbox is in left section (x < 100)", () => {
    const bbox = CREW_FOCUS_BOXES[4];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // Fixed bbox: { x: 1, y: 611, w: 456, h: 427 } — left panel, NOT the wide band
      expect(bbox.x).toBeLessThan(100);
      expect(bbox.y).toBeGreaterThan(500);
      expect(bbox.y).toBeLessThan(700);
      // Width covers the Bedrock card only (~456), NOT the full diagram width
      expect(bbox.w).toBeLessThan(600);
      // Does NOT span full width (old bug was w > 1000)
      expect(bbox.w).not.toBeGreaterThan(700);
    }
  });

  it("(f) all non-null bboxes are within SVG viewBox", () => {
    const VBW: number = CREW_SVG_VB_W as unknown as number;
    const VBH: number = CREW_SVG_VB_H as unknown as number;
    CREW_FOCUS_BOXES.forEach((bbox) => {
      if (bbox === null) return;
      expect(bbox.x).toBeGreaterThanOrEqual(0);
      expect(bbox.y).toBeGreaterThanOrEqual(0);
      expect(bbox.x + bbox.w).toBeLessThanOrEqual(VBW + 1);
      expect(bbox.y + bbox.h).toBeLessThanOrEqual(VBH + 1);
    });
  });

  // ── (f-geo) GEOMETRÍA REAL DEL SVG — tests anclados a coords verificadas ─

  it("(f-geo) agent cards 1-3: each card x is approximately the expected SVG column", () => {
    // Agent card viewBox x values (derived from SVG translate + path coords):
    //   Agent 1: x ≈ 693  Agent 2: x ≈ 1153  Agent 3: x ≈ 1613
    const b1 = CREW_FOCUS_BOXES[1];
    const b2 = CREW_FOCUS_BOXES[2];
    const b3 = CREW_FOCUS_BOXES[3];
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(b3).not.toBeNull();
    if (b1 && b2 && b3) {
      // Each card x matches its expected column (±30px tolerance)
      expect(b1.x).toBeGreaterThan(663);
      expect(b1.x).toBeLessThan(723);
      expect(b2.x).toBeGreaterThan(1123);
      expect(b2.x).toBeLessThan(1183);
      expect(b3.x).toBeGreaterThan(1583);
      expect(b3.x).toBeLessThan(1643);
    }
  });

  it("(f-geo) agent cards 1-3: each card w ≈ 384 (within ±20px)", () => {
    for (const idx of [1, 2, 3]) {
      const b = CREW_FOCUS_BOXES[idx];
      expect(b).not.toBeNull();
      if (b) {
        expect(b.w).toBeGreaterThan(364);
        expect(b.w).toBeLessThan(404);
      }
    }
  });

  it("(f-geo) agent cards 1-3: y starts in 500..530 range", () => {
    for (const idx of [1, 2, 3]) {
      const b = CREW_FOCUS_BOXES[idx];
      expect(b).not.toBeNull();
      if (b) {
        expect(b.y).toBeGreaterThan(490);
        expect(b.y).toBeLessThan(540);
      }
    }
  });

  it("(f-geo) agent cards 1-3 do not overlap each other", () => {
    const b1 = CREW_FOCUS_BOXES[1];
    const b2 = CREW_FOCUS_BOXES[2];
    const b3 = CREW_FOCUS_BOXES[3];
    if (b1 && b2) {
      // b1 ends before b2 starts (x-axis)
      expect(b1.x + b1.w).toBeLessThan(b2.x);
    }
    if (b2 && b3) {
      // b2 ends before b3 starts (x-axis)
      expect(b2.x + b2.w).toBeLessThan(b3.x);
    }
  });

  it("(f-geo) step 4 bbox contains the Bedrock/crewai card rect (x 1..457, y 611..1038)", () => {
    const b4 = CREW_FOCUS_BOXES[4];
    expect(b4).not.toBeNull();
    if (b4) {
      // Must fully contain [x=1..457, y=611..1038]
      expect(b4.x).toBeLessThanOrEqual(1);
      expect(b4.y).toBeLessThanOrEqual(611);
      expect(b4.x + b4.w).toBeGreaterThanOrEqual(457);
      expect(b4.y + b4.h).toBeGreaterThanOrEqual(1038);
    }
  });

  it("(f-geo) step 4 bbox does NOT overlap agent card 1 (x≈693)", () => {
    const b4 = CREW_FOCUS_BOXES[4];
    const b1 = CREW_FOCUS_BOXES[1];
    expect(b4).not.toBeNull();
    expect(b1).not.toBeNull();
    if (b4 && b1) {
      // b4 must end before b1 starts on the x-axis
      expect(b4.x + b4.w).toBeLessThan(b1.x);
    }
  });

  it("(f-geo) step 4 bbox does NOT overlap agent cards 2 or 3", () => {
    const b4 = CREW_FOCUS_BOXES[4];
    const b2 = CREW_FOCUS_BOXES[2];
    const b3 = CREW_FOCUS_BOXES[3];
    expect(b4).not.toBeNull();
    if (b4 && b2) {
      expect(b4.x + b4.w).toBeLessThan(b2.x);
    }
    if (b4 && b3) {
      expect(b4.x + b4.w).toBeLessThan(b3.x);
    }
  });

  // ── (g) No remount between sub-steps ─────────────────────────────────────

  it("(g) aria-live status region is the same DOM node across step changes (no remount)", () => {
    const { rerender } = render(
      <CrewSubStepContext.Provider value={{ subStep: 0, isActive: true }}>
        <CrewDiagram />
      </CrewSubStepContext.Provider>,
    );

    const liveRegionBefore = screen.getByRole("status");

    rerender(
      <CrewSubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <CrewDiagram />
      </CrewSubStepContext.Provider>,
    );

    const liveRegionAfter = screen.getByRole("status");
    expect(liveRegionAfter).toBe(liveRegionBefore);
  });

  it("(g) canvas has no inline transform (no zoom-transform pattern)", () => {
    const { container } = renderAtStep(2);
    const wrap = container.querySelector(".arch-canvas-wrap");
    expect(wrap).toBeInTheDocument();
    expect(wrap?.getAttribute("style") ?? "").not.toMatch(/translate|scale/i);
  });

  // ── (h) Sidebar content fidelity ─────────────────────────────────────────

  it("(h) step 1 (log-analyst) mentions max_iter 3", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/max_iter.*3/i);
  });

  it("(h) step 1 (log-analyst) mentions allow_delegation false", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/allow_delegation.*false/i);
  });

  it("(h) step 2 (fix-engineer) mentions FILE_PATH marker", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/FILE_PATH/i);
  });

  it("(h) step 2 (fix-engineer) mentions returning COMPLETE file, not a diff", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/COMPLETE corrected file/i);
  });

  it("(h) step 3 (reviewer) mentions VERDICT: APPLY or VERDICT: REJECT (with colon)", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/VERDICT:\s*(APPLY|REJECT)/i);
  });

  it("(h) step 3 (reviewer) has stricter harness: max_retry 1", () => {
    const step = CREW_STEPS[3];
    const content = step.bullets.join(" ");
    expect(content).toMatch(/max_retry.*1/i);
  });

  it("(h) step 4 (shared runtime) mentions Claude Sonnet 4.5", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/Claude Sonnet/i);
  });

  it("(h) step 4 (shared runtime) mentions circuit breaker", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/circuit breaker/i);
  });

  it("(h) step 4 (shared runtime) mentions anti-main or fix/* branch", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    // Must mention either "anti-main" or "fix/*" branch constraint
    const text = sidebar.textContent ?? "";
    expect(text.match(/anti.main|fix\//i)).toBeTruthy();
  });
});
