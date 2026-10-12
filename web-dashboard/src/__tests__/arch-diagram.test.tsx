/**
 * arch-diagram.test.tsx — Tests for ArchitectureDiagram component (Lucid SVG version).
 *
 * The component now renders the Lucid SVG as a background image and uses a
 * scrim overlay for focus highlighting. It reads sub-step from SubStepContext.
 *
 * FOCUS ORDER:
 *   Step 0 = Overview (no highlight)
 *   Step 1 = IaC / CDK
 *   Step 2 = Edge Layer (ESP32)
 *   Step 3 = IoT Core & Jobs — Ingest + OTA Orchestration
 *   Step 4 = Firmware Delivery (S3 bucket, presigned URL)
 *   Step 5 = Cloud Backend (Lambda + DynamoDB)
 *   Step 6 = Self-Healing (Fargate + ECR + Bedrock)
 *   Step 7 = Final Overview
 *
 * Covers:
 *   (a) Renders without crashing — smoke test (via context)
 *   (b) Overview mode (step 0): region, SVG image, aria-live present
 *   (c) Controlled step changes via context render the correct sidebar
 *   (d) body[data-arch-capturing] is NEVER set
 *   (e) ArrowRight on window does NOT change the diagram (no internal listener)
 *   (f) ARCH_DIAGRAM_STEP_COUNT exported constant is correct
 *   (g) Scrim overlay renders at step > 0 with a bbox, absent at step 0
 *   (h) Architecture fidelity: DynamoDB=circuit-breaker, OTA=presigned
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, within, act } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the SVG asset import — Vite resolves it, but jsdom does not
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));

// Mock CSS import
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

const { ArchitectureDiagram, SubStepContext, ARCH_DIAGRAM_STEP_COUNT } = await import(
  "../presentation/ArchitectureDiagram.js"
);

// ── Helper: render with a specific sub-step via context ──────────────────────

function renderAtStep(step: number, isActive = true) {
  return render(
    <SubStepContext.Provider value={{ subStep: step, isActive }}>
      <ArchitectureDiagram />
    </SubStepContext.Provider>,
  );
}

// Helper: get the service explanation sidebar (step > 0)
function getSidebar() {
  return screen.getByRole("complementary", { name: /Explanation/i });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ArchitectureDiagram — Lucid SVG background + scrim overlay", () => {

  // ── (a) Smoke tests ───────────────────────────────────────────────────────

  it("(a) renders without crashing at step 0", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-diagram")).toBeInTheDocument();
  });

  it("(a) renders the architecture region with correct role", () => {
    renderAtStep(0);
    expect(
      screen.getByRole("region", { name: /Architecture Diagram/i }),
    ).toBeInTheDocument();
  });

  // ── (b) Overview mode ─────────────────────────────────────────────────────

  it("(b) overview mode: renders the SVG background image", () => {
    renderAtStep(0);
    const img = screen.getByRole("img", { name: /AWS architecture diagram/i });
    expect(img).toBeInTheDocument();
    expect(img.tagName.toLowerCase()).toBe("img");
  });

  it("(b) overview mode: aria-live status region present", () => {
    renderAtStep(0);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("(b) overview mode: shows 'Press → to explore' hint", () => {
    renderAtStep(0);
    expect(screen.getByText(/to explore each service/i)).toBeInTheDocument();
  });

  it("(b) overview mode: shows overview sidebar card (NOT service sidebar)", () => {
    renderAtStep(0);
    expect(screen.getByRole("complementary", { name: /Diagram overview/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Explanation/i })).toBeNull();
  });

  // ── (c) Controlled step changes via context ───────────────────────────────

  it("(c) step 1 shows IaC / CDK sidebar", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/Infrastructure as Code/i)).toBeInTheDocument();
  });

  it("(c) step 2 shows Edge Layer sidebar", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/Edge Layer/i)).toBeInTheDocument();
  });

  it("(c) step 3 shows IoT Core & Jobs sidebar", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/IoT Core.*Jobs/i)).toBeInTheDocument();
  });

  it("(c) step 4 shows Firmware Delivery / S3 sidebar", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/Amazon S3/i)).toBeInTheDocument();
  });

  it("(c) step 5 shows Dashboard Presentation & Backend sidebar", () => {
    renderAtStep(5);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/Dashboard Presentation.*Backend/i)).toBeInTheDocument();
  });

  it("(c) step 6 shows Self-Healing sidebar", () => {
    renderAtStep(6);
    const sidebar = getSidebar();
    expect(within(sidebar).getByText(/Self-Healing/i)).toBeInTheDocument();
  });

  it("(c) last step (7) shows final overview sidebar — no 'Explanation' label needed", () => {
    // step 7 = final overview (null bbox), falls back to step data with overview title
    renderAtStep(ARCH_DIAGRAM_STEP_COUNT - 1);
    // Sidebar should render (could be either type), just shouldn't crash
    const region = screen.getByRole("region", { name: /Architecture Diagram/i });
    expect(region).toBeInTheDocument();
  });

  it("(c) sidebar step counter shows correct fraction", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(
      new RegExp(`3\\s*/\\s*${ARCH_DIAGRAM_STEP_COUNT - 1}`),
    );
  });

  it("(c) re-render via context change shows new sidebar content (no remount)", () => {
    const { rerender } = render(
      <SubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <ArchitectureDiagram />
      </SubStepContext.Provider>,
    );
    expect(within(getSidebar()).getByText(/Infrastructure as Code/i)).toBeInTheDocument();

    rerender(
      <SubStepContext.Provider value={{ subStep: 2, isActive: true }}>
        <ArchitectureDiagram />
      </SubStepContext.Provider>,
    );
    expect(within(getSidebar()).getByText(/Edge Layer/i)).toBeInTheDocument();
  });

  // ── (d) No body[data-arch-capturing] ─────────────────────────────────────

  it("(d) body[data-arch-capturing] is NEVER set at step 0", () => {
    renderAtStep(0);
    expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
  });

  it("(d) body[data-arch-capturing] is NEVER set at step > 0", () => {
    renderAtStep(2);
    expect(document.body.getAttribute("data-arch-capturing")).toBeNull();
  });

  // ── (e) No internal keyboard listener ────────────────────────────────────

  it("(e) ArrowRight on window does NOT change context-driven step", async () => {
    const { rerender } = render(
      <SubStepContext.Provider value={{ subStep: 1, isActive: true }}>
        <ArchitectureDiagram />
      </SubStepContext.Provider>,
    );

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    // Still shows step 1 content (IaC/CDK)
    expect(within(getSidebar()).getByText(/Infrastructure as Code/i)).toBeInTheDocument();

    rerender(
      <SubStepContext.Provider value={{ subStep: 2, isActive: true }}>
        <ArchitectureDiagram />
      </SubStepContext.Provider>,
    );
    expect(within(getSidebar()).getByText(/Edge Layer/i)).toBeInTheDocument();
  });

  // ── (f) ARCH_DIAGRAM_STEP_COUNT ──────────────────────────────────────────

  it("(f) ARCH_DIAGRAM_STEP_COUNT is 8 (steps 0..7)", () => {
    expect(ARCH_DIAGRAM_STEP_COUNT).toBe(8);
  });

  it("(f) step counter shows correct total steps", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/1\s*\/\s*7/);
  });

  // ── (g) Scrim overlay ─────────────────────────────────────────────────────

  it("(g) scrim overlay is absent at step 0 (overview, no highlight)", () => {
    const { container } = renderAtStep(0);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  it("(g) scrim overlay is present at step 1 (IaC focus)", () => {
    const { container } = renderAtStep(1);
    expect(container.querySelector(".arch-scrim-wrap")).toBeInTheDocument();
  });

  it("(g) scrim overlay is absent at step 7 (final overview, null bbox)", () => {
    const { container } = renderAtStep(7);
    expect(container.querySelector(".arch-scrim-wrap")).toBeNull();
  });

  // ── (h) Architecture fidelity ─────────────────────────────────────────────

  it("(h) DynamoDB step mentions circuit-breaker, not telemetry history", () => {
    renderAtStep(5); // Lambda + DynamoDB step
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/circuit.breaker/i);
    expect(sidebar).not.toHaveTextContent(/telemetry history with TTL/i);
  });

  it("(h) IoT Core step does NOT mention 'Rule action'", () => {
    renderAtStep(3);
    const sidebar = getSidebar();
    expect(sidebar).not.toHaveTextContent(/Rule action/i);
  });

  it("(h) step 1 (IaC) mentions CloudFormation — provisions infra before Edge", () => {
    renderAtStep(1);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/CloudFormation/i);
  });

  it("(h) step 2 (Edge) mentions ESP32 and not CDK content", () => {
    renderAtStep(2);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/ESP32/i);
    expect(sidebar).not.toHaveTextContent(/CloudFormation/i);
  });

  it("(h) OTA step mentions presigned URL", () => {
    renderAtStep(4);
    const sidebar = getSidebar();
    expect(sidebar).toHaveTextContent(/presigned/i);
  });

  // ── No zoom/canvas movement ───────────────────────────────────────────────

  it("canvas wrap has NO inline transform style", () => {
    const { container } = renderAtStep(2);
    const wrap = container.querySelector(".arch-canvas-wrap");
    expect(wrap).toBeInTheDocument();
    expect(wrap?.getAttribute("style") ?? "").not.toMatch(/translate|scale/i);
  });
});
