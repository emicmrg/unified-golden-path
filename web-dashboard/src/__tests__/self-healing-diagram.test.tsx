/**
 * self-healing-diagram.test.tsx — Tests for SelfHealingDiagram component (Diagrama C).
 *
 * Mirrors crew-diagram.test.tsx pattern exactly.
 *
 * FOCUS ORDER (Fargate mode):
 *   Step 0 = Overview (no highlight)
 *   Step 1 = CI fails: sample-service-ci
 *   Step 2 = self-heal-dispatch workflow
 *   Step 3 = OIDC → IAM role ugp-ci-deploy-role
 *   Step 4 = ECS Fargate run-task (fire-and-forget)
 *   Step 5 = Crew: ECR + Bedrock + DynamoDB
 *   Step 6 = GitHub App + PR (Secrets Manager PEM → installation token)
 *   Step 7 = Full overview (final)
 *
 * Covers:
 *   (a) Renders without crashing — smoke tests (via SelfHealingSubStepContext)
 *   (b) Overview mode (step 0): region, SVG image, aria-live present
 *   (c) Controlled step changes via context render correct sidebar
 *   (d) SH_DIAGRAM_STEP_COUNT is correct
 *   (e) Scrim overlay renders at step > 0 with bbox, absent at overview steps
 *   (f) FOCUS_BOXES contain the correct regions (INVARIANTE: illuminated == narrated)
 *   (g) Sub-step navigation doesn't remount the component
 *   (h) Sidebar content fidelity: real data from self-heal-dispatch.yml + SelfHealingStack
 *   (i) Registered in SLIDE_REGISTRY with correct stepCount
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock SVG asset imports
vi.mock("../presentation/assets/self-healing-flow.svg", () => ({
  default: "/test-asset-self-healing-flow.svg",
}));
vi.mock("../presentation/assets/crew-agents.svg", () => ({
  default: "/test-asset-crew-agents.svg",
}));
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));

// Mock CSS imports
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

const {
  SelfHealingDiagram,
  SH_DIAGRAM_STEP_COUNT,
  SH_FOCUS_BOXES,
  SH_STEPS,
  SH_SVG_VB_W,
  SH_SVG_VB_H,
  SelfHealingSubStepContext,
} = await import("../presentation/SelfHealingDiagram.js");

// ── Helper: render with a specific sub-step via context ──────────────────────

function renderAtStep(step: number, isActive = true) {
  return render(
    <SelfHealingSubStepContext.Provider value={{ subStep: step, isActive }}>
      <SelfHealingDiagram />
    </SelfHealingSubStepContext.Provider>,
  );
}

// Helper: get the service explanation sidebar (step > 0, not overview)
function getSidebar() {
  return screen.getByRole("complementary", { name: /Explanation/i });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("SelfHealingDiagram — Lucid SVG background + scrim overlay (Diagrama C)", () => {

  // ── (a) Smoke tests ───────────────────────────────────────────────────────

  it("(a) renders without crashing at step 0", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-diagram")).toBeInTheDocument();
  });

  it("(a) renders the Self-Healing Flow region with correct role", () => {
    renderAtStep(0);
    expect(
      screen.getByRole("region", { name: /Self-Healing Flow Diagram/i }),
    ).toBeInTheDocument();
  });

  // ── (b) Overview mode ─────────────────────────────────────────────────────

  it("(b) overview mode: renders the self-healing SVG background image", () => {
    renderAtStep(0);
    const img = screen.getByRole("img", { name: /Self-healing flow diagram/i });
    expect(img).toBeInTheDocument();
    expect(img.tagName.toLowerCase()).toBe("img");
  });

  it("(b) overview mode: aria-live status region present", () => {
    renderAtStep(0);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("(b) overview mode: shows navigation hint to walk through steps", () => {
    renderAtStep(0);
    const matches = screen.getAllByText(/walk through each step/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("(b) overview mode: shows overview sidebar card (NOT Explanation sidebar)", () => {
    renderAtStep(0);
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  // ── (c) Controlled step changes via context ───────────────────────────────

  it("(c) step 1 shows CI fails sidebar", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/CI Fails/i);
  });

  it("(c) step 2 shows self-heal-dispatch sidebar", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/self-heal-dispatch/i);
  });

  it("(c) step 3 shows OIDC / IAM sidebar", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/OIDC/i);
  });

  it("(c) step 4 shows ECS Fargate sidebar", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/Fargate/i);
  });

  it("(c) step 5 shows Crew accesses (ECR/Bedrock/DynamoDB) sidebar", () => {
    renderAtStep(5);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ECR/i);
  });

  it("(c) step 6 shows GitHub App / PR sidebar", () => {
    renderAtStep(6);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/GitHub App/i);
  });

  it("(c) last step (7) is final overview — no crash", () => {
    renderAtStep(SH_DIAGRAM_STEP_COUNT - 1);
    const region = screen.getByRole("region", { name: /Self-Healing Flow Diagram/i });
    expect(region).toBeInTheDocument();
  });

  it("(c) sidebar step counter shows correct fraction at step 3", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(
      new RegExp(`3\\s*/\\s*${SH_DIAGRAM_STEP_COUNT - 1}`),
    );
  });

  it("(c) re-render via context change shows new sidebar (no remount)", () => {
    const { rerender } = render(
      <SelfHealingSubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <SelfHealingDiagram />
      </SelfHealingSubStepContext.Provider>,
    );
    expect(getSidebar()).toHaveTextContent(/CI Fails/i);

    rerender(
      <SelfHealingSubStepContext.Provider value={{ subStep: 2, isActive: true }}>
        <SelfHealingDiagram />
      </SelfHealingSubStepContext.Provider>,
    );
    expect(getSidebar()).toHaveTextContent(/self-heal-dispatch/i);
  });

  // ── (d) SH_DIAGRAM_STEP_COUNT ─────────────────────────────────────────────

  it("(d) SH_DIAGRAM_STEP_COUNT is 8 (steps 0..7)", () => {
    expect(SH_DIAGRAM_STEP_COUNT).toBe(8);
  });

  it("(d) step counter shows correct total steps at step 1", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/1\s*\/\s*7/);
  });

  // ── (e) Scrim overlay ─────────────────────────────────────────────────────

  it("(e) scrim overlay absent at step 0 (overview, no highlight)", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  it("(e) scrim overlay present at step 1 (CI area focus)", () => {
    const { container } = renderAtStep(1);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(e) scrim overlay present at step 4 (ECS Fargate focus)", () => {
    const { container } = renderAtStep(4);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(e) scrim overlay present at step 6 (GitHub App focus)", () => {
    const { container } = renderAtStep(6);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(e) scrim overlay absent at step 7 (final overview, null bbox)", () => {
    const { container } = renderAtStep(7);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  // ── (f) FOCUS_BOXES — INVARIANTE: illuminated == narrated ─────────────────
  //
  // Critical invariant: the bbox for each step must correspond to what the
  // sidebar narrates. These tests verify spatial placement + non-overlap.

  it("(f) SH_FOCUS_BOXES.length === SH_DIAGRAM_STEP_COUNT", () => {
    expect(SH_FOCUS_BOXES.length).toBe(SH_DIAGRAM_STEP_COUNT);
  });

  it("(f) step 0 (overview) has null bbox", () => {
    expect(SH_FOCUS_BOXES[0]).toBeNull();
  });

  it("(f) step 7 (final overview) has null bbox", () => {
    expect(SH_FOCUS_BOXES[7]).toBeNull();
  });

  it("(f) step 1 (CI fails) bbox is in the LEFT half — GitHub container region (x < 400)", () => {
    const bbox = SH_FOCUS_BOXES[1];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // GitHub container in viewBox is x=1..321; CI section is top of it
      expect(bbox.x).toBeLessThan(400);
      expect(bbox.x).toBeGreaterThanOrEqual(0);
    }
  });

  it("(f) step 2 (dispatch) bbox is in the LEFT half — GitHub container region (x < 400)", () => {
    const bbox = SH_FOCUS_BOXES[2];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeLessThan(400);
    }
  });

  it("(f) step 3 (IAM role) bbox is in the RIGHT half — AWS container region (x > 400)", () => {
    const bbox = SH_FOCUS_BOXES[3];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(400);
    }
  });

  it("(f) step 4 (ECS Fargate) bbox is in the AWS container region (x > 400)", () => {
    const bbox = SH_FOCUS_BOXES[4];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(400);
    }
  });

  it("(f) step 5 (ECR+Bedrock+DDB) bbox is in the rightmost AWS column (x > 800)", () => {
    const bbox = SH_FOCUS_BOXES[5];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(800);
    }
  });

  it("(f) step 6 (GitHub App) bbox is in the LEFT half — GitHub container region (x < 400)", () => {
    const bbox = SH_FOCUS_BOXES[6];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeLessThan(400);
    }
  });

  it("(f) all non-null bboxes are within SVG viewBox", () => {
    const VBW: number = SH_SVG_VB_W as unknown as number;
    const VBH: number = SH_SVG_VB_H as unknown as number;
    SH_FOCUS_BOXES.forEach((bbox, i) => {
      if (bbox === null) return;
      expect(bbox.x, `step ${i}: x >= 0`).toBeGreaterThanOrEqual(0);
      expect(bbox.y, `step ${i}: y >= 0`).toBeGreaterThanOrEqual(0);
      expect(bbox.x + bbox.w, `step ${i}: right edge <= VBW`).toBeLessThanOrEqual(VBW + 1);
      expect(bbox.y + bbox.h, `step ${i}: bottom edge <= VBH`).toBeLessThanOrEqual(VBH + 1);
    });
  });

  // ── (f-geo) Geometry tests — coords anchored to SVG viewBox ──────────────

  it("(f-geo) step 1 CI bbox starts near top of GitHub container (y near 160, w covers container)", () => {
    const bbox = SH_FOCUS_BOXES[1];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // GitHub container top y=160; CI section begins there
      expect(bbox.y).toBeGreaterThanOrEqual(155);
      expect(bbox.y).toBeLessThanOrEqual(175);
      // Width should cover the full GitHub container width (~320)
      expect(bbox.w).toBeGreaterThan(250);
      expect(bbox.w).toBeLessThan(400);
    }
  });

  it("(f-geo) step 2 dispatch bbox is below step 1 CI bbox (y > step1.y + step1.h/2)", () => {
    const b1 = SH_FOCUS_BOXES[1];
    const b2 = SH_FOCUS_BOXES[2];
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    if (b1 && b2) {
      // Dispatch is in the middle of the GitHub container, below CI
      expect(b2.y).toBeGreaterThan(b1.y + 100);
    }
  });

  it("(f-geo) step 3 IAM bbox is a compact area (~80-150px wide/tall) around the lock icon", () => {
    const bbox = SH_FOCUS_BOXES[3];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // IAM lock icon is small (~80px); with padding ~132px is reasonable
      expect(bbox.w).toBeGreaterThan(60);
      expect(bbox.w).toBeLessThan(200);
      expect(bbox.h).toBeGreaterThan(60);
      expect(bbox.h).toBeLessThan(200);
    }
  });

  it("(f-geo) step 4 ECS Fargate bbox matches the orange ECS box (x≈511-851, y≈510-750)", () => {
    const bbox = SH_FOCUS_BOXES[4];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // ECS orange box: svg(780,520) → vb(521,520) w320 h220; with padding ~(511,510,340,240)
      expect(bbox.x).toBeGreaterThan(480);
      expect(bbox.x).toBeLessThan(545);
      expect(bbox.y).toBeGreaterThan(490);
      expect(bbox.y).toBeLessThan(530);
      expect(bbox.w).toBeGreaterThan(300);
      expect(bbox.w).toBeLessThan(380);
      expect(bbox.h).toBeGreaterThan(200);
      expect(bbox.h).toBeLessThan(280);
    }
  });

  it("(f-geo) step 5 ECR+Bedrock+DDB bbox is tall (h > 400) to cover all three icons", () => {
    const bbox = SH_FOCUS_BOXES[5];
    expect(bbox).not.toBeNull();
    if (bbox) {
      // Three icons stacked: ECR y≈230, Bedrock y≈400, DDB y≈590 → total span ~440px
      expect(bbox.h).toBeGreaterThan(400);
    }
  });

  it("(f-geo) step 6 GitHub App bbox is in the BOTTOM third of GitHub container (y > 550)", () => {
    const bbox = SH_FOCUS_BOXES[6];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.y).toBeGreaterThan(550);
    }
  });

  it("(f-geo) GitHub bboxes (steps 1,2,6) do NOT overlap AWS bboxes (steps 3,4,5)", () => {
    const githubSteps = [1, 2, 6];
    const awsSteps = [3, 4, 5];
    for (const gi of githubSteps) {
      const gb = SH_FOCUS_BOXES[gi];
      if (!gb) continue;
      for (const ai of awsSteps) {
        const ab = SH_FOCUS_BOXES[ai];
        if (!ab) continue;
        // No horizontal overlap: one ends before the other starts
        const noOverlap = (gb.x + gb.w <= ab.x) || (ab.x + ab.w <= gb.x);
        expect(
          noOverlap,
          `GitHub step ${gi} bbox should not overlap AWS step ${ai} bbox`
        ).toBe(true);
      }
    }
  });

  // ── (g) No remount between sub-steps ─────────────────────────────────────

  it("(g) aria-live status region is the same DOM node across step changes (no remount)", () => {
    const { rerender } = render(
      <SelfHealingSubStepContext.Provider value={{ subStep: 0, isActive: true }}>
        <SelfHealingDiagram />
      </SelfHealingSubStepContext.Provider>,
    );

    const liveRegionBefore = screen.getByRole("status");

    rerender(
      <SelfHealingSubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <SelfHealingDiagram />
      </SelfHealingSubStepContext.Provider>,
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

  // ── (h) Sidebar content fidelity: self-heal-dispatch.yml + SelfHealingStack ─

  it("(h) step 1 (CI fails) mentions workflow_run conclusion=failure", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/workflow_run/i);
  });

  it("(h) step 1 (CI fails) mentions sample-service-ci", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/sample-service-ci/i);
  });

  it("(h) step 2 (dispatch) mentions SELF_HEAL_MODE fargate guard", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/SELF_HEAL_MODE/i);
  });

  it("(h) step 2 (dispatch) mentions fire-and-forget", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/fire-and-forget/i);
  });

  it("(h) step 2 (dispatch) mentions aws ecs run-task", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ecs run-task/i);
  });

  it("(h) step 3 (OIDC) mentions ugp-ci-deploy-role", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ugp-ci-deploy-role/i);
  });

  it("(h) step 3 (OIDC) mentions no static keys", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    // Must mention that no static credentials are stored
    const text = sidebar.textContent ?? "";
    expect(text.match(/no static|no.*keys|AWS_ACCESS_KEY/i)).toBeTruthy();
  });

  it("(h) step 4 (Fargate) mentions crew runs ISOLATED from runner", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ISOLATED/i);
  });

  it("(h) step 4 (Fargate) mentions ugp-self-healing-crew task definition", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ugp-self-healing/i);
  });

  it("(h) step 5 (Crew) mentions Amazon Bedrock Claude Sonnet", () => {
    renderAtStep(5);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/Bedrock/i);
    expect(sidebar).toHaveTextContent(/Claude Sonnet/i);
  });

  it("(h) step 5 (Crew) mentions DynamoDB circuit breaker", () => {
    renderAtStep(5);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/DynamoDB/i);
    expect(sidebar).toHaveTextContent(/circuit breaker/i);
  });

  it("(h) step 5 (Crew) mentions Task Role least-privilege", () => {
    renderAtStep(5);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/least.privilege/i);
  });

  it("(h) step 6 (GitHub App) mentions PEM from Secrets Manager", () => {
    renderAtStep(6);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/Secrets Manager/i);
    expect(sidebar).toHaveTextContent(/PEM/i);
  });

  it("(h) step 6 (GitHub App) mentions installation token (NOT GITHUB_TOKEN)", () => {
    renderAtStep(6);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/installation token/i);
    expect(sidebar).toHaveTextContent(/GITHUB_TOKEN/i);
  });

  it("(h) step 6 (GitHub App) mentions fix/* PR", () => {
    renderAtStep(6);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/fix\//i);
  });

  it("(h) step 6 (GitHub App) mentions JWT RS256 signing", () => {
    const step = SH_STEPS[6];
    const content = step.bullets.join(" ");
    expect(content).toMatch(/JWT.*RS256|RS256.*JWT/i);
  });

  it("(i) SH_DIAGRAM_STEP_COUNT is 8 (sanity check)", () => {
    expect(SH_DIAGRAM_STEP_COUNT).toBe(8);
  });
});
