/**
 * arch-spotlight.test.tsx — B2: verifica que el spotlight REALMENTE recorta.
 *
 * El test anterior (arch-diagram.test.tsx) pasaba con el clipPath roto porque
 * solo comprobaba presencia/ausencia del elemento, no la técnica de recorte.
 *
 * Este archivo verifica:
 *   (B2-a) El ScrimOverlay usa <mask> y NO <clipPath> para crear el hueco.
 *   (B2-b) El mask contiene un rect BLANCO cubriendo el viewBox completo.
 *   (B2-c) El mask contiene rect(s) NEGROS en las coordenadas de cada bbox activa.
 *   (B2-d) El scrim usa mask="url(#...)" y NO clipPath.
 *   (B2-e) Un punto DENTRO de la bbox activa está cubierto por la zona negra del mask
 *          (no atenuado) y un punto FUERA está en la zona blanca (sí atenuado).
 *   (B2-f) FOCUS_BOXES[3] (grupo IoT/Ingest) contiene el icono IoT Core
 *          (SVG source x=700, y=300 → viewBox x=761, y=181.5, size=120×120)
 *          y el icono IoT device jobs (viewBox x=771.5, y=481.5, w=99, h=120).
 *          El sidebar del paso 3 narra AMBOS: IoT Core (ingesta MQTT) y
 *          IoT Jobs (orquestación OTA) — los dos servicios del grupo IoT/Ingest.
 *   (B2-g) FOCUS_BOXES[4] (grupo OTA) contiene el icono Amazon S3
 *          (SVG source x=700, y=1100 → viewBox x=761, y=981.5, size=120×120).
 *          Es el único icono gráfico en ese grupo; el sidebar del paso 4 narra
 *          SOLO S3: bucket de firmware, presigned URL, descarga con esp_https_ota.
 *          IoT Jobs icon (viewBox x=771.5, y=481.5) NO cae en FOCUS_BOXES[4].
 *   (B2-h) FOCUS_BOXES[5] incluye el icono DynamoDB
 *          (SVG source x=1840, y=580 → viewBox x=1901, y=461.5, size=120×120).
 *
 * LAYOUT REAL DEL SVG (Lucid export, translate(61 -118.5)):
 *   Grupo IoT/Ingest  → FOCUS_BOXES[3]: x=661, y=93.5,  w=322, h=596
 *     • IoT Core icon:       viewBox(761, 181.5, 120, 120)   — dentro del grupo ✓
 *     • IoT device jobs icon: viewBox(771.5, 481.5, 99, 120) — dentro del grupo ✓
 *   Grupo OTA         → FOCUS_BOXES[4]: x=661, y=893.5, w=322, h=316
 *     • Amazon S3 icon: viewBox(761, 981.5, 120, 120)  — único icono en el grupo ✓
 *     • IoT Jobs icon (y=481.5) queda FUERA del grupo OTA (y_min=893.5) ✓
 */

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

// ── Mocks ────────────────────────────────────────────────────────────────────

import { vi } from "vitest";

vi.mock("../presentation/assets/aws-architecture.svg", () => ({
  default: "/test-asset-aws-architecture.svg",
}));

vi.mock("../presentation/ArchitectureDiagram.css", () => ({}));

const {
  ArchitectureDiagram,
  SubStepContext,
  FOCUS_BOXES,
  SVG_VB_W,
  SVG_VB_H,
} = await import("../presentation/ArchitectureDiagram.js");

// ── Helper ────────────────────────────────────────────────────────────────────

function renderAtStep(step: number) {
  return render(
    <SubStepContext.Provider value={{ subStep: step, isActive: true }}>
      <ArchitectureDiagram />
    </SubStepContext.Provider>,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// (B2-a/b/c/d) SVG <mask> structure
// ─────────────────────────────────────────────────────────────────────────────

describe("B2 — spotlight mask structure (not clipPath)", () => {
  it("(B2-a) ScrimOverlay uses <mask>, NOT <clipPath>", () => {
    const { container } = renderAtStep(1);
    const scrim = container.querySelector(".arch-scrim");
    expect(scrim).toBeTruthy();
    // mask must be present
    expect(scrim!.querySelector("mask")).toBeTruthy();
    // clipPath must NOT be present
    expect(scrim!.querySelector("clipPath")).toBeNull();
  });

  it("(B2-b) mask contains a white full-viewBox rect (base layer)", () => {
    const { container } = renderAtStep(1);
    const scrim = container.querySelector(".arch-scrim")!;
    const maskEl = scrim.querySelector("mask")!;
    const rects = maskEl.querySelectorAll("rect");

    // First rect should be white and cover the full viewBox
    const whiteRect = Array.from(rects).find(
      (r) =>
        r.getAttribute("fill") === "white" &&
        Number(r.getAttribute("width")) >= SVG_VB_W - 1 &&
        Number(r.getAttribute("height")) >= SVG_VB_H - 1,
    );
    expect(whiteRect).toBeTruthy();
  });

  it("(B2-c) mask contains at least one black rect (the hole)", () => {
    const { container } = renderAtStep(1);
    const scrim = container.querySelector(".arch-scrim")!;
    const maskEl = scrim.querySelector("mask")!;
    const rects = maskEl.querySelectorAll("rect");

    const blackRects = Array.from(rects).filter(
      (r) => r.getAttribute("fill") === "black",
    );
    expect(blackRects.length).toBeGreaterThanOrEqual(1);
  });

  it("(B2-d) scrim rect uses mask= attribute, NOT clipPath=", () => {
    const { container } = renderAtStep(1);
    const scrim = container.querySelector(".arch-scrim")!;
    const scrimRect = scrim.querySelector("rect[fill='rgba(0, 0, 0, 0.52)']");
    expect(scrimRect).toBeTruthy();
    expect(scrimRect!.getAttribute("mask")).toMatch(/url\(#/);
    expect(scrimRect!.getAttribute("clipPath")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2-e) Point-in/out geometry — inside the black hole vs outside
// ─────────────────────────────────────────────────────────────────────────────

describe("B2-e — geometry: inside bbox == black hole, outside == white base", () => {
  /**
   * For a given step, verify that a point at the CENTER of the active bbox
   * falls inside (i.e. is covered by) one of the black rects in the mask,
   * and that a point far outside the bbox is NOT covered by any black rect.
   */
  function checkGeometry(step: number) {
    const { container } = renderAtStep(step);
    const scrim = container.querySelector(".arch-scrim")!;
    const maskEl = scrim.querySelector("mask")!;
    const blackRects = Array.from(maskEl.querySelectorAll("rect")).filter(
      (r) => r.getAttribute("fill") === "black",
    );

    const bbox = FOCUS_BOXES[step]!;
    // Use the padded center — ScrimOverlay pads by 12px
    const PAD = 12;
    const cx = bbox.x - PAD + (bbox.w + PAD * 2) / 2;
    const cy = bbox.y - PAD + (bbox.h + PAD * 2) / 2;

    // Is the center point inside any black rect?
    const isInsideBlack = blackRects.some((r) => {
      const rx = Number(r.getAttribute("x") ?? 0);
      const ry = Number(r.getAttribute("y") ?? 0);
      const rw = Number(r.getAttribute("width") ?? 0);
      const rh = Number(r.getAttribute("height") ?? 0);
      return cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh;
    });
    expect(isInsideBlack).toBe(true);

    // A point in the top-right corner should NOT be inside any black rect
    // (steps 1-6 have bboxes that don't extend to the far top-right corner)
    const outsidePoint = { x: SVG_VB_W * 0.98, y: SVG_VB_H * 0.02 };
    const isOutsideInsideBlack = blackRects.some((r) => {
      const rx = Number(r.getAttribute("x") ?? 0);
      const ry = Number(r.getAttribute("y") ?? 0);
      const rw = Number(r.getAttribute("width") ?? 0);
      const rh = Number(r.getAttribute("height") ?? 0);
      return (
        outsidePoint.x >= rx &&
        outsidePoint.x <= rx + rw &&
        outsidePoint.y >= ry &&
        outsidePoint.y <= ry + rh
      );
    });
    expect(isOutsideInsideBlack).toBe(false);
  }

  it("step 1 (IaC): center of bbox is in the black hole, far corner is not", () => {
    checkGeometry(1);
  });

  it("step 3 (IoT Core & Jobs): center of bbox is in the black hole, far corner is not", () => {
    checkGeometry(3);
  });

  it("step 5 (Backend): center of primary bbox is in the black hole, far corner is not", () => {
    checkGeometry(5);
  });

  it("step 6 (Self-Healing): center of bbox is in the black hole, far corner is not", () => {
    checkGeometry(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2-f) FOCUS_BOXES[3] (grupo IoT/Ingest) contiene IoT Core + IoT Jobs icons
//
// LAYOUT REAL: el grupo IoT/Ingest (M600 212…V808) en el SVG de Lucid contiene
// DOS iconos gráficos:
//   • IoT Core:        M700 300, viewBox x=761, y=181.5, size=120×120
//   • IoT device jobs: bbox viewBox x=771.5, y=481.5, w=99, h=120
// FOCUS_BOXES[3] ilumina el grupo completo IoT/Ingest → ambos caen dentro ✓.
//
// ASSERTION: ambos iconos caen DENTRO de FOCUS_BOXES[3], NINGUNO cae en [4].
// ─────────────────────────────────────────────────────────────────────────────

describe("B2-f — FOCUS_BOXES[3] contiene el icono IoT Core (grupo IoT/Ingest)", () => {
  // IoT Core icon: SVG source M700 300 + translate(61,-118.5) = viewBox(761, 181.5)
  const IOT_CORE_ICON = { x: 761, y: 181.5, w: 120, h: 120 };

  // IoT device jobs icon: viewBox (771.5, 481.5, 99, 120)
  const IOT_JOBS_ICON = { x: 771.5, y: 481.5, w: 99, h: 120 };

  it("FOCUS_BOXES[3] is not null", () => {
    expect(FOCUS_BOXES[3]).not.toBeNull();
  });

  it("FOCUS_BOXES[3] left edge (x) is to the left of IoT Core icon", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.x).toBeLessThanOrEqual(IOT_CORE_ICON.x);
  });

  it("FOCUS_BOXES[3] right edge (x+w) is to the right of IoT Core icon right edge", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.x + bbox.w).toBeGreaterThanOrEqual(IOT_CORE_ICON.x + IOT_CORE_ICON.w);
  });

  it("FOCUS_BOXES[3] top edge (y) is above IoT Core icon", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.y).toBeLessThanOrEqual(IOT_CORE_ICON.y);
  });

  it("FOCUS_BOXES[3] bottom edge (y+h) is below IoT Core icon bottom edge", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.y + bbox.h).toBeGreaterThanOrEqual(IOT_CORE_ICON.y + IOT_CORE_ICON.h);
  });

  it("IoT Core icon does NOT fall inside FOCUS_BOXES[4] (OTA group)", () => {
    const otaBbox = FOCUS_BOXES[4]!;
    // IoT Core icon center
    const cx = IOT_CORE_ICON.x + IOT_CORE_ICON.w / 2;
    const cy = IOT_CORE_ICON.y + IOT_CORE_ICON.h / 2;
    const insideOta =
      cx >= otaBbox.x &&
      cx <= otaBbox.x + otaBbox.w &&
      cy >= otaBbox.y &&
      cy <= otaBbox.y + otaBbox.h;
    expect(insideOta).toBe(false);
  });

  // IoT Jobs icon — 4 containment asserts inside FOCUS_BOXES[3]
  it("IoT Jobs icon left edge is inside FOCUS_BOXES[3]", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.x).toBeLessThanOrEqual(IOT_JOBS_ICON.x);
  });

  it("IoT Jobs icon right edge is inside FOCUS_BOXES[3]", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.x + bbox.w).toBeGreaterThanOrEqual(IOT_JOBS_ICON.x + IOT_JOBS_ICON.w);
  });

  it("IoT Jobs icon top edge is inside FOCUS_BOXES[3]", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.y).toBeLessThanOrEqual(IOT_JOBS_ICON.y);
  });

  it("IoT Jobs icon bottom edge is inside FOCUS_BOXES[3]", () => {
    const bbox = FOCUS_BOXES[3]!;
    expect(bbox.y + bbox.h).toBeGreaterThanOrEqual(IOT_JOBS_ICON.y + IOT_JOBS_ICON.h);
  });

  // Cross-check: IoT Jobs icon center must NOT fall inside FOCUS_BOXES[4] (OTA group)
  it("IoT Jobs icon center does NOT fall inside FOCUS_BOXES[4] (OTA group)", () => {
    const otaBbox = FOCUS_BOXES[4]!;
    const cx = IOT_JOBS_ICON.x + IOT_JOBS_ICON.w / 2;
    const cy = IOT_JOBS_ICON.y + IOT_JOBS_ICON.h / 2;
    const insideOta =
      cx >= otaBbox.x &&
      cx <= otaBbox.x + otaBbox.w &&
      cy >= otaBbox.y &&
      cy <= otaBbox.y + otaBbox.h;
    expect(insideOta).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2-g) FOCUS_BOXES[4] (grupo OTA) contiene el icono Amazon S3
//   SVG source: M700 1100 h120 v120 → after translate(61,-118.5):
//     x=761, y=981.5, size=120×120
//
// Este es el ÚNICO icono gráfico en el grupo OTA.
// El sidebar del paso 4 narra SOLO S3 (bucket, presigned URL, esp_https_ota).
// ─────────────────────────────────────────────────────────────────────────────

describe("B2-g — FOCUS_BOXES[4] (OTA) contiene el icono Amazon S3", () => {
  // Amazon S3 icon: SVG source M700 1100 + translate(61,-118.5) = viewBox(761, 981.5)
  const S3_ICON = { x: 761, y: 981.5, w: 120, h: 120 };

  it("FOCUS_BOXES[4] is not null", () => {
    expect(FOCUS_BOXES[4]).not.toBeNull();
  });

  it("FOCUS_BOXES[4] left edge (x) is to the left of S3 icon", () => {
    const bbox = FOCUS_BOXES[4]!;
    expect(bbox.x).toBeLessThanOrEqual(S3_ICON.x);
  });

  it("FOCUS_BOXES[4] right edge (x+w) is to the right of S3 icon right edge", () => {
    const bbox = FOCUS_BOXES[4]!;
    expect(bbox.x + bbox.w).toBeGreaterThanOrEqual(S3_ICON.x + S3_ICON.w);
  });

  it("FOCUS_BOXES[4] top edge (y) is above S3 icon", () => {
    const bbox = FOCUS_BOXES[4]!;
    expect(bbox.y).toBeLessThanOrEqual(S3_ICON.y);
  });

  it("FOCUS_BOXES[4] bottom edge (y+h) is below S3 icon bottom edge", () => {
    const bbox = FOCUS_BOXES[4]!;
    expect(bbox.y + bbox.h).toBeGreaterThanOrEqual(S3_ICON.y + S3_ICON.h);
  });

  it("S3 icon does NOT fall inside FOCUS_BOXES[3] (IoT/Ingest group)", () => {
    const iotBbox = FOCUS_BOXES[3]!;
    // S3 icon center
    const cx = S3_ICON.x + S3_ICON.w / 2;
    const cy = S3_ICON.y + S3_ICON.h / 2;
    const insideIot =
      cx >= iotBbox.x &&
      cx <= iotBbox.x + iotBbox.w &&
      cy >= iotBbox.y &&
      cy <= iotBbox.y + iotBbox.h;
    expect(insideIot).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B2-h) FOCUS_BOXES[5] includes DynamoDB icon
//   SVG source: M1840 580 h120 v120 → after translate(61,-118.5):
//     x=1901, y=461.5, size=120×120
// ─────────────────────────────────────────────────────────────────────────────

describe("B2-h — FOCUS_BOXES[5] includes DynamoDB icon", () => {
  // DynamoDB icon bounding box in viewBox coordinates
  const DYNAMODB_ICON = { x: 1901, y: 461.5, w: 120, h: 120 };

  it("FOCUS_BOXES[5] is not null", () => {
    expect(FOCUS_BOXES[5]).not.toBeNull();
  });

  it("FOCUS_BOXES[5] left edge (x) is to the left of DynamoDB icon", () => {
    const bbox = FOCUS_BOXES[5]!;
    expect(bbox.x).toBeLessThanOrEqual(DYNAMODB_ICON.x);
  });

  it("FOCUS_BOXES[5] right edge (x+w) is to the right of DynamoDB icon right edge", () => {
    const bbox = FOCUS_BOXES[5]!;
    expect(bbox.x + bbox.w).toBeGreaterThanOrEqual(DYNAMODB_ICON.x + DYNAMODB_ICON.w);
  });

  it("FOCUS_BOXES[5] top edge (y) is above DynamoDB icon", () => {
    const bbox = FOCUS_BOXES[5]!;
    expect(bbox.y).toBeLessThanOrEqual(DYNAMODB_ICON.y);
  });

  it("FOCUS_BOXES[5] bottom edge (y+h) is below DynamoDB icon bottom edge", () => {
    const bbox = FOCUS_BOXES[5]!;
    expect(bbox.y + bbox.h).toBeGreaterThanOrEqual(DYNAMODB_ICON.y + DYNAMODB_ICON.h);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: clipPath approach would fail these tests
// This comment documents WHY these tests catch the old broken implementation:
//
//  Old: <clipPath> + clipRule=evenodd on the <rect> referencing it.
//       clip-rule on a referencing element is a no-op per SVG spec.
//       All pixels are clipped (or none are) uniformly.
//
//  New: <mask> with white base + black holes.
//       mask=white → scrim rendered (dimmed).
//       mask=black → scrim NOT rendered (bright).
//       Black rects appear at active bbox coords — verifiable in DOM.
// ─────────────────────────────────────────────────────────────────────────────
