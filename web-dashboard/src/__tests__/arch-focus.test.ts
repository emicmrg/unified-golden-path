/**
 * arch-focus.test.ts — Focus step and bounding box assertions for the
 * Lucid-SVG-based ArchitectureDiagram.
 *
 * The old arch-geometry.test.ts tested hand-coded node positions,
 * GROUP_RECTS, and connector math — all of which have been replaced by
 * the Lucid SVG background + scrim overlay approach.
 *
 * This file tests:
 *   (A) FOCUS_BOXES array length matches ARCH_DIAGRAM_STEP_COUNT.
 *   (B) Every non-null bounding box is within the SVG viewBox.
 *   (C) STEPS array length matches ARCH_DIAGRAM_STEP_COUNT.
 *   (D) Each non-null bounding box has positive width and height.
 *   (E) Spot-check: known service steps have the expected bbox identity.
 *   (F) Step 0 and final step are null (full-overview, no highlight).
 */

import { describe, it, expect } from "vitest";
import { vi } from "vitest";

// Suppress SVG asset import (Vite import, not needed in test environment)
vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));

// Mock the CSS import so the module loads in jsdom
vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

const {
  FOCUS_BOXES,
  STEPS,
  ARCH_DIAGRAM_STEP_COUNT,
  SVG_VB_W,
  SVG_VB_H,
} = await import("../presentation/ArchitectureDiagram.js");

const SVG_W: number = (SVG_VB_W as unknown) as number;
const SVG_H: number = (SVG_VB_H as unknown) as number;

// ─────────────────────────────────────────────────────────────────────────────
// (A) Array lengths
// ─────────────────────────────────────────────────────────────────────────────

describe("A — FOCUS_BOXES and STEPS lengths match ARCH_DIAGRAM_STEP_COUNT", () => {
  it("FOCUS_BOXES.length === ARCH_DIAGRAM_STEP_COUNT", () => {
    expect(FOCUS_BOXES.length).toBe(ARCH_DIAGRAM_STEP_COUNT);
  });

  it("STEPS.length === ARCH_DIAGRAM_STEP_COUNT", () => {
    expect(STEPS.length).toBe(ARCH_DIAGRAM_STEP_COUNT);
  });

  it("ARCH_DIAGRAM_STEP_COUNT is 8", () => {
    expect(ARCH_DIAGRAM_STEP_COUNT).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) Every non-null bounding box is within the SVG viewBox
// ─────────────────────────────────────────────────────────────────────────────

describe("B — bounding boxes are within SVG viewBox", () => {
  FOCUS_BOXES.forEach((bbox, i) => {
    if (bbox === null) return;
    it(`step ${i} bbox is within viewBox [0..${SVG_W}] × [0..${SVG_H}]`, () => {
      expect(bbox.x).toBeGreaterThanOrEqual(0);
      expect(bbox.y).toBeGreaterThanOrEqual(0);
      expect(bbox.x + bbox.w).toBeLessThanOrEqual(SVG_W + 1); // allow 1px tolerance
      expect(bbox.y + bbox.h).toBeLessThanOrEqual(SVG_H + 1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) Every STEPS entry has a title and at least one bullet
// ─────────────────────────────────────────────────────────────────────────────

describe("C — every STEPS entry has a title and bullets", () => {
  STEPS.forEach((step, i) => {
    it(`step ${i} has a non-empty title`, () => {
      expect(step.title).toBeTruthy();
      expect(step.title.length).toBeGreaterThan(0);
    });
    it(`step ${i} has at least one bullet`, () => {
      expect(step.bullets.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) Non-null bboxes have positive width and height
// ─────────────────────────────────────────────────────────────────────────────

describe("D — non-null bounding boxes have positive dimensions", () => {
  FOCUS_BOXES.forEach((bbox, i) => {
    if (bbox === null) return;
    it(`step ${i} bbox has positive w=${bbox.w} and h=${bbox.h}`, () => {
      expect(bbox.w).toBeGreaterThan(0);
      expect(bbox.h).toBeGreaterThan(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (E) Spot-checks for known service steps
// ─────────────────────────────────────────────────────────────────────────────

describe("E — spot-check service step bounding boxes", () => {
  it("step 1 (IaC/CDK) bbox starts near left edge (x < 50)", () => {
    const bbox = FOCUS_BOXES[1];
    expect(bbox).not.toBeNull();
    if (bbox) expect(bbox.x).toBeLessThan(50);
  });

  it("step 2 (Edge/ESP32) bbox starts near left edge (x < 50)", () => {
    const bbox = FOCUS_BOXES[2];
    expect(bbox).not.toBeNull();
    if (bbox) expect(bbox.x).toBeLessThan(50);
  });

  it("step 1 (IaC) and step 2 (Edge) bboxes are at different y positions", () => {
    const bboxIac = FOCUS_BOXES[1];
    const bboxEdge = FOCUS_BOXES[2];
    expect(bboxIac).not.toBeNull();
    expect(bboxEdge).not.toBeNull();
    if (bboxIac && bboxEdge) {
      expect(bboxEdge.y).toBeGreaterThan(bboxIac.y);
    }
  });

  it("step 3 (IoT Core) bbox is in the right half of the diagram (x > 500)", () => {
    const bbox = FOCUS_BOXES[3];
    expect(bbox).not.toBeNull();
    if (bbox) expect(bbox.x).toBeGreaterThan(500);
  });

  it("step 6 (Self-Healing) bbox is in the bottom-right area (x > 1000, y > 500)", () => {
    const bbox = FOCUS_BOXES[6];
    expect(bbox).not.toBeNull();
    if (bbox) {
      expect(bbox.x).toBeGreaterThan(1000);
      expect(bbox.y).toBeGreaterThan(500);
    }
  });

  it("step 6 (Self-Healing) is wider than step 3 (IoT Core alone)", () => {
    const bboxSH = FOCUS_BOXES[6];
    const bboxIoT = FOCUS_BOXES[3];
    expect(bboxSH).not.toBeNull();
    expect(bboxIoT).not.toBeNull();
    if (bboxSH && bboxIoT) {
      expect(bboxSH.w).toBeGreaterThan(bboxIoT.w);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (F) Step 0 and final step are null (full overview, no highlight)
// ─────────────────────────────────────────────────────────────────────────────

describe("F — overview steps have null bounding boxes", () => {
  it("step 0 (initial overview) has null bbox", () => {
    expect(FOCUS_BOXES[0]).toBeNull();
  });

  it("final step (overview) has null bbox", () => {
    expect(FOCUS_BOXES[ARCH_DIAGRAM_STEP_COUNT - 1]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (G) Architecture fidelity assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("G — architecture fidelity: sidebar content", () => {
  it("step 5 (Lambda+DynamoDB) mentions circuit-breaker, not telemetry history", () => {
    const step = STEPS[5];
    const content = step.bullets.join(" ").toLowerCase();
    expect(content).toMatch(/circuit.breaker/i);
    expect(content).not.toMatch(/telemetry history with ttl/i);
  });

  it("step 1 (IaC/CDK) mentions CloudFormation", () => {
    const step = STEPS[1];
    const content = step.bullets.join(" ").toLowerCase();
    expect(content).toMatch(/cloudformation/i);
  });

  it("step 4 (OTA) mentions presigned URL", () => {
    const step = STEPS[4];
    const content = step.bullets.join(" ").toLowerCase();
    expect(content).toMatch(/presigned/i);
  });

  it("step 2 (Edge) mentions ESP32", () => {
    const step = STEPS[2];
    const content = step.bullets.join(" ").toLowerCase();
    expect(content).toMatch(/esp32/i);
  });
});
