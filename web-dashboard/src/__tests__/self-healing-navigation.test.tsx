/**
 * self-healing-navigation.test.tsx — Tests for SelfHealingDiagram step coordination.
 *
 * The old MDX Deck keyboard navigation tests are replaced.
 * Core scroll mechanics are in scroll-proto.test.ts.
 *
 * Covers:
 *   (a) SH_FOCUS_BOXES shape: 8 entries (0..7), null at 0 and 7
 *   (b) GitHub container steps (1, 2, 6) are in x range 0..330
 *   (c) AWS container steps (3, 4, 5) are in x range > 450
 *   (d) SH_STEPS has 8 entries matching SH_DIAGRAM_STEP_COUNT
 *   (e) SelfHealingDiagram renders at each step without crashing
 *   (f) Sidebar content fidelity — each step shows expected content
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";


// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../presentation/assets/self-healing-flow.svg", () => ({
  default: "/test-asset-self-healing-flow.svg",
}));
vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

// ── Import under test ────────────────────────────────────────────────────────

const {
  SelfHealingDiagram,
  SH_DIAGRAM_STEP_COUNT,
  SH_FOCUS_BOXES,
  SH_STEPS,
  SelfHealingSubStepContext,
} = await import("../presentation/SelfHealingDiagram.js");

// ── Helper ───────────────────────────────────────────────────────────────────

function renderAtStep(step: number, isActive = true) {
  return render(
    <SelfHealingSubStepContext.Provider value={{ subStep: step, isActive }}>
      <SelfHealingDiagram />
    </SelfHealingSubStepContext.Provider>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("SelfHealingDiagram — focus boxes", () => {
  it("(a) SH_FOCUS_BOXES has 8 entries", () => {
    expect(SH_FOCUS_BOXES.length).toBe(8);
  });

  it("(a) SH_FOCUS_BOXES[0] is null (overview)", () => {
    expect(SH_FOCUS_BOXES[0]).toBeNull();
  });

  it("(a) SH_FOCUS_BOXES[7] is null (final overview)", () => {
    expect(SH_FOCUS_BOXES[7]).toBeNull();
  });

  it("(a) SH_DIAGRAM_STEP_COUNT is 8", () => {
    expect(SH_DIAGRAM_STEP_COUNT).toBe(8);
  });

  it("(b) GitHub container steps (1, 2, 6) have x < 330", () => {
    const githubSteps = [1, 2, 6];
    for (const step of githubSteps) {
      const box = SH_FOCUS_BOXES[step];
      expect(box).not.toBeNull();
      expect(box!.x).toBeLessThan(330);
    }
  });

  it("(c) AWS container steps (3, 4, 5) have x > 450", () => {
    const awsSteps = [3, 4, 5];
    for (const step of awsSteps) {
      const box = SH_FOCUS_BOXES[step];
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThan(450);
    }
  });

  it("(d) SH_STEPS length === SH_DIAGRAM_STEP_COUNT", () => {
    expect(SH_STEPS.length).toBe(SH_DIAGRAM_STEP_COUNT);
  });
});

describe("SelfHealingDiagram — rendering and sidebar", () => {
  it("(e) renders at step 0 without crashing", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(e) renders at step 1 without crashing", () => {
    const { container } = renderAtStep(1);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(e) renders at step 4 (Fargate) without crashing", () => {
    const { container } = renderAtStep(4);
    expect(container.querySelector(".arch-diagram")).toBeTruthy();
  });

  it("(f) step 1 sidebar shows CI fails content", () => {
    const { container } = renderAtStep(1);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/CI Fails/i);
  });

  it("(f) step 3 sidebar shows OIDC / IAM content", () => {
    const { container } = renderAtStep(3);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/OIDC/i);
  });

  it("(f) step 4 sidebar shows Fargate content", () => {
    const { container } = renderAtStep(4);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/Fargate/i);
  });

  it("(f) step 6 sidebar shows GitHub App / PR content", () => {
    const { container } = renderAtStep(6);
    const sidebar = container.querySelector(".arch-sidebar");
    expect(sidebar).toBeTruthy();
    expect(sidebar!.textContent).toMatch(/GitHub App/i);
  });
});
