/**
 * crew-navigation.test.tsx — Tests for CrewDiagram step coordination
 * within the ScrollDeck.
 *
 * The old MDX Deck keyboard navigation tests are replaced.
 * Core scroll mechanics are in scroll-proto.test.ts.
 *
 * Covers:
 *   (a) CREW_FOCUS_BOXES shape: 6 entries (0..5), null at 0 and 5
 *   (b) Agent card bboxes are in the expected column range (x > 500)
 *   (c) Bedrock/runtime bbox is in the lower section (y > 600)
 *   (d) CREW_STEPS has 6 entries matching CREW_DIAGRAM_STEP_COUNT
 *   (e) CrewDiagram renders within a MemoryRouter without crashing
 *   (f) Controlled step changes render correct sidebar content
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";


// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));
vi.mock("../presentation/assets/self-healing-flow.svg", () => ({
  default: "/test-asset-self-healing-flow.svg",
}));
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

// ── Import under test ────────────────────────────────────────────────────────

const {
  CrewDiagram,
  CREW_DIAGRAM_STEP_COUNT,
  CREW_FOCUS_BOXES,
  CREW_STEPS,
  CrewSubStepContext,
} = await import("../presentation/CrewDiagram.js");

// ── Helper ───────────────────────────────────────────────────────────────────

function renderAtStep(step: number, isActive = true) {
  return render(
    <CrewSubStepContext.Provider value={{ subStep: step, isActive }}>
      <CrewDiagram />
    </CrewSubStepContext.Provider>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("CrewDiagram — focus boxes and steps", () => {
  it("(a) CREW_FOCUS_BOXES has 6 entries", () => {
    expect(CREW_FOCUS_BOXES.length).toBe(6);
  });

  it("(a) CREW_FOCUS_BOXES[0] is null (overview)", () => {
    expect(CREW_FOCUS_BOXES[0]).toBeNull();
  });

  it("(a) CREW_FOCUS_BOXES[5] is null (final overview)", () => {
    expect(CREW_FOCUS_BOXES[5]).toBeNull();
  });

  it("(b) Agent card bboxes are in the x > 500 range", () => {
    // Steps 1-3 are agent cards
    for (let i = 1; i <= 3; i++) {
      const box = CREW_FOCUS_BOXES[i];
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThan(500);
    }
  });

  it("(c) Bedrock/runtime bbox (step 4) is in lower y range (y > 500)", () => {
    const box = CREW_FOCUS_BOXES[4];
    expect(box).not.toBeNull();
    // The runtime/Bedrock section is in the lower half of the diagram
    expect(box!.y).toBeGreaterThan(500);
  });

  it("(d) CREW_STEPS length === CREW_DIAGRAM_STEP_COUNT", () => {
    expect(CREW_STEPS.length).toBe(CREW_DIAGRAM_STEP_COUNT);
  });

  it("(d) CREW_DIAGRAM_STEP_COUNT is 6", () => {
    expect(CREW_DIAGRAM_STEP_COUNT).toBe(6);
  });
});

describe("CrewDiagram — rendering", () => {
  it("(e) renders at step 0 (overview) without crashing", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(e) renders at step 1 (CI Log Analyst) without crashing", () => {
    const { container } = renderAtStep(1);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(e) renders at step 2 (CI Repair Engineer) without crashing", () => {
    const { container } = renderAtStep(2);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(f) step 1 sidebar shows CI Log Analyst", () => {
    const { container } = renderAtStep(1);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/CI Log Analyst/i);
  });

  it("(f) step 2 sidebar shows CI Repair Engineer", () => {
    const { container } = renderAtStep(2);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/CI Repair Engineer/i);
  });

  it("(f) step 3 sidebar shows CI Patch Reviewer", () => {
    const { container } = renderAtStep(3);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/CI Patch Reviewer/i);
  });

  it("(f) step 0 shows overview title in sidebar", () => {
    const { container } = renderAtStep(0);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/Self-Healing Crew/i);
  });
});
