/**
 * ArchitectureDiagram.tsx — Diagrama A: AWS edge→IoT→cloud.
 *
 * PATTERN: Lucid SVG as background + highlight overlay.
 *
 *   The Lucid-exported SVG (aws-architecture.svg) is rendered as the full
 *   background of the diagram. On top of it, a semi-transparent scrim SVG
 *   darkens everything EXCEPT the active bounding box, creating a spotlight
 *   effect for each focus step.
 *
 *   Sub-step 0  = full diagram, neutral (no scrim, overview sidebar).
 *   Sub-step k  = active bounding box lit, rest dimmed via scrim overlay.
 *                 Cross-fade between steps (none with prefers-reduced-motion).
 *
 * FOCUS ORDER (approved by Emilio):
 *   Step 0  = Overview (full diagram visible, no highlight)
 *   Step 1  = IaC — CDK provisions all cloud infrastructure
 *   Step 2  = Edge — ESP32 device
 *   Step 3  = IoT Core & Jobs (MQTT ingestion + OTA orchestration)
 *   Step 4  = OTA Pipeline (S3 firmware bucket)
 *   Step 5  = Cloud Backend (Lambda + DynamoDB)
 *   Step 6  = Self-Healing (ECS Fargate + ECR + Bedrock)
 *   Step 7  = Full overview (no highlight, final view)
 *
 * BOUNDING BOXES:
 *   Derived from the Lucid SVG structure. The SVG uses:
 *     viewBox="0 0 2162.5 1303"  (width/height attrs on the root <svg> element)
 *     inner <g transform="translate(61 -118.5)">
 *   All box coordinates are in the viewBox coordinate space
 *   (i.e. SVG source coords + translate(61, -118.5)).
 *
 * SCRIM / SPOTLIGHT TECHNIQUE — SVG <mask>:
 *   A white rect covering the full viewBox makes everything visible.
 *   One or more black rects at the active bbox "punch holes" (black = hidden).
 *   The scrim dark rect uses that mask → the punched regions are NOT dimmed.
 *
 * COORDINATION MODEL: SubStepContext (stable, no remount).
 * ACCESSIBILITY: aria-live announces active service; role="region".
 * REDUCED MOTION: no cross-fade animation; overlay switches instantly.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import "./ArchitectureDiagram.css";
// Import as URL so Vite handles asset hashing and resolves correctly in dev+build
import awsArchitectureSvgUrl from "./assets/aws-architecture.svg";

// ─────────────────────────────────────────────────────────────────────────────
// SubStepContext — provided by Deck, consumed by ArchitectureDiagram
// ─────────────────────────────────────────────────────────────────────────────

export interface SubStepContextValue {
  subStep: number;
  isActive: boolean;
}

export const SubStepContext = createContext<SubStepContextValue>({
  subStep: 0,
  isActive: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// SVG metadata
// The Lucid SVG root element carries width="2162.5" height="1303" (no explicit
// viewBox attr on the root, but the dimensions define the coordinate space).
// All bounding boxes below are in outer viewBox coordinates after the inner
// <g transform="translate(61 -118.5)"> is factored in.
// ─────────────────────────────────────────────────────────────────────────────

export const SVG_VB_W = 2162.5;
export const SVG_VB_H = 1303;

// ─────────────────────────────────────────────────────────────────────────────
// Focus bounding boxes (in viewBox coordinates)
//
// Derivation: element coords in SVG source + translate(61, -118.5)
//
// IaC group     (M-60 212 … V488):
//   x = -60 + 61 = 1,  y = 212 - 118.5 = 93.5,  w = 320, h = 276
//
// Edge group    (M-60 732 … V1008):
//   x = 1,  y = 732 - 118.5 = 613.5,  w = 320, h = 276
//
// IoT Core sub-group (M600 212 … V808):
//   x = 600+61=661, y=212-118.5=93.5, w=320, h=596
//
// OTA sub-group (M600 1012 … V1328):
//   x = 661, y=1012-118.5=893.5, w=320, h=316
//
// Backend sub-group (M1120 212 … V808):
//   x = 1120+61=1181, y=93.5, w=600, h=596
//   DynamoDB icon at SVG(1840,580) → viewBox(1901,461.5), size 120×120.
//   To include it: right edge = 1901+120 = 2021 → w = 2021-1181 = 840.
//   Round up to 882 (same as Self-Healing) to give padding.
//
// Self-Healing sub-group (M1120 1012 … V1328):
//   x = 1181, y=893.5, w=880, h=316
//
// NOTE on heights: SVG groups go from y=1012 to y=1328 (SVG space),
//   which is 316 px.  Previous value of 290 was clipping the bottom row.
// ─────────────────────────────────────────────────────────────────────────────

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FOCUS_BOXES: (BBox | null)[] = [
  null,  // Step 0: overview (no highlight)
  // Step 1: IaC/CDK group
  { x: 1, y: 93.5, w: 322, h: 276 },
  // Step 2: Edge/ESP32 group
  { x: 1, y: 613.5, w: 322, h: 276 },
  // Step 3: IoT Core sub-group
  { x: 661, y: 93.5, w: 322, h: 596 },
  // Step 4: OTA Pipeline — S3 bucket (only icon in the OTA group).
  // SVG group: M600 1012 … V1328 → viewBox: x=661, y=893.5, w=320, h=316.
  // Amazon S3 icon (M700 1100, viewBox x=761, y=981.5, 120×120) is inside this box.
  { x: 661, y: 893.5, w: 322, h: 316 },
  // Step 5: Dashboard Presentation & Backend — Amplify + Cognito + Lambda + DynamoDB.
  // The Dashboard Presentation group rect spans x=1181..1781 (w=600) in viewBox.
  // Icons inside: Cognito @ viewBox(1261,181.5), Amplify @ viewBox(1581,181.5),
  //               Lambda @ viewBox(1421,461.5), DynamoDB @ viewBox(1901,461.5).
  // DynamoDB right edge = 1901+120 = 2021. Add ~20px padding → right = 2041 → w = 860.
  { x: 1181, y: 93.5, w: 860, h: 596 },
  // Step 6: Self-Healing — ECS/ECR/Bedrock sub-group
  { x: 1181, y: 893.5, w: 882, h: 316 },
  null,  // Step 7: full overview again (no highlight)
];

export const ARCH_DIAGRAM_STEP_COUNT = FOCUS_BOXES.length; // 8 (steps 0..7)

// ─────────────────────────────────────────────────────────────────────────────
// Focus step data (sidebar content)
// Bullets in English, fidelity preserved from original component.
// ─────────────────────────────────────────────────────────────────────────────

export interface FocusStepData {
  id: string;
  title: string;
  bullets: string[];
}

export const STEPS: FocusStepData[] = [
  {
    id: "overview",
    title: "AWS Architecture — Unified Golden Path",
    bullets: [
      "IaC first: AWS CDK v2 provisions the entire Cloud Infrastructure before the device connects",
      "Edge to cloud: ESP32 publishes telemetry over MQTT/TLS to the already-provisioned IoT Core",
      "Self-healing AI: Fargate crew uses Bedrock to diagnose failures and open a remediation PR",
    ],
  },
  {
    id: "cdk",
    title: "Infrastructure as Code — AWS CDK v2",
    bullets: [
      "All three stacks (UgpIotStack, SelfHealingStack, DashboardStack) defined in TypeScript",
      "CDK synthesizes CloudFormation — the entire Cloud Infrastructure box is created before the device connects",
      "GitHub OIDC trust policy replaces long-lived AWS credentials in CI",
    ],
  },
  {
    id: "edge",
    title: "Edge Layer — ESP32 Device",
    bullets: [
      "Device id: ugp-gateway-01 running ESP-IDF 5.3 on ESP32",
      "Publishes temperature + humidity telemetry over MQTT port 8883 (mutual TLS)",
      "Subscribes to IoT Jobs topic for over-the-air firmware updates (OTA)",
    ],
  },
  {
    id: "iotcore",
    title: "IoT Core & Jobs — Ingest + OTA Orchestration",
    bullets: [
      "IoT Core receives telemetry from the ESP32 over MQTT port 8883 (X.509 mutual-TLS — no passwords)",
      "IoT Jobs orchestrates the OTA lifecycle: creates a job, notifies the device, tracks execution",
      "Browser subscribes to live telemetry via MQTT-over-WSS using temporary Cognito guest credentials",
    ],
  },
  {
    id: "ota",
    title: "Firmware Delivery — Amazon S3",
    bullets: [
      "S3 bucket stores the compiled firmware binary produced by the CI pipeline",
      "IoT Jobs generates a presigned S3 URL scoped to the target device for secure download",
      "ESP32 fetches the binary over HTTPS with esp_https_ota and reboots into the new image",
    ],
  },
  {
    id: "backend",
    title: "Dashboard Presentation & Backend",
    bullets: [
      "AWS Amplify hosts the React dashboard — global CDN, zero-server deployment",
      "Amazon Cognito guest identity pool grants the browser temporary credentials to subscribe to live telemetry over MQTT-over-WSS — no login required",
      "Lambda (Function URL) serves the status API directly — no API Gateway, IAM least-privilege",
      "DynamoDB stores circuit-breaker state: counts self-healing attempts per run, read by the status API to surface escalation status in the dashboard",
    ],
  },
  {
    id: "selfheal",
    title: "Self-Healing Crew — Fargate + ECR + Bedrock",
    bullets: [
      "GitHub Actions CI triggers a Fargate task when the pipeline detects a failure",
      "LangGraph agent (Python) pulls its image from ECR and runs diagnostics",
      "Amazon Bedrock LLM reasons over logs and opens an auto-remediation PR",
    ],
  },
  {
    id: "overview-final",
    title: "AWS Architecture — Unified Golden Path (Final)",
    bullets: [
      "IaC first: AWS CDK v2 provisions the entire Cloud Infrastructure before the device connects",
      "Edge to cloud: ESP32 publishes telemetry over MQTT/TLS to the already-provisioned IoT Core",
      "Self-healing AI: Fargate crew uses Bedrock to diagnose failures and open a remediation PR",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// usePrefersReducedMotion
// ─────────────────────────────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ─────────────────────────────────────────────────────────────────────────────
// ScrimOverlay — renders a semi-transparent mask that dims the entire SVG
// except the active bounding box(es).
//
// TECHNIQUE — SVG <mask>:
//   • A white rect covering the full viewBox makes the mask opaque everywhere
//     (mask=white → element visible).
//   • One or more black rects at each active bbox "punch holes"
//     (mask=black → element hidden → scrim NOT drawn there).
//   • The dark scrim rect uses that mask via mask="url(#…)".
//   Result: the active bbox region is NOT dimmed; everything else is.
//
// This replaces the broken clipPath+evenOdd approach where clip-rule on the
// referencing element is a no-op and all children of the clipPath union rather
// than subtract.
//
// The overlay sits above the SVG background but does NOT cover text —
// it is rendered in the same coordinate space as the Lucid SVG viewBox.
// ─────────────────────────────────────────────────────────────────────────────

interface ScrimOverlayProps {
  /** Primary active bbox (required). */
  bbox: BBox;
  /** Optional additional bboxes to keep unmasked (multi-region spotlight). */
  extraBBoxes?: BBox[];
  reducedMotion: boolean;
}

function ScrimOverlay({ bbox, extraBBoxes = [], reducedMotion }: ScrimOverlayProps): React.ReactElement {
  const PAD = 12; // padding around active box
  const maskId = `arch-scrim-mask-${useId().replace(/:/g, "")}`;

  /** Pad a bbox and clamp to viewBox bounds. */
  const padBBox = (b: BBox) => {
    const x = Math.max(0, b.x - PAD);
    const y = Math.max(0, b.y - PAD);
    const w = Math.min(SVG_VB_W - x, b.w + PAD * 2);
    const h = Math.min(SVG_VB_H - y, b.h + PAD * 2);
    return { x, y, w, h };
  };

  const primary = padBBox(bbox);
  const extras = extraBBoxes.map(padBBox);
  const rx = 14;

  return (
    <svg
      className="arch-scrim"
      viewBox={`0 0 ${SVG_VB_W} ${SVG_VB_H}`}
      aria-hidden="true"
      data-reduced-motion={reducedMotion}
    >
      <defs>
        {/*
          SVG mask — white = show (scrim drawn), black = hide (scrim not drawn).
          Full white base → black holes punch through at each active bbox.
        */}
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {/* White base: scrim drawn everywhere by default */}
          <rect x="0" y="0" width={SVG_VB_W} height={SVG_VB_H} fill="white" />
          {/* Black holes: scrim NOT drawn at the active bbox(es) */}
          <rect
            x={primary.x}
            y={primary.y}
            width={primary.w}
            height={primary.h}
            rx={rx}
            fill="black"
          />
          {extras.map((eb, i) => (
            <rect
              key={i}
              x={eb.x}
              y={eb.y}
              width={eb.w}
              height={eb.h}
              rx={rx}
              fill="black"
            />
          ))}
        </mask>
      </defs>

      {/* Scrim — covers everything EXCEPT the masked-out (black) regions */}
      <rect
        x="0"
        y="0"
        width={SVG_VB_W}
        height={SVG_VB_H}
        fill="rgba(0, 0, 0, 0.52)"
        mask={`url(#${maskId})`}
      />

      {/* Highlight ring around the primary active box */}
      <rect
        x={primary.x}
        y={primary.y}
        width={primary.w}
        height={primary.h}
        rx={rx}
        fill="none"
        stroke="#0C62FB"
        strokeWidth="3"
        opacity="0.85"
      />

      {/* Highlight ring(s) around extra active boxes */}
      {extras.map((eb, i) => (
        <rect
          key={i}
          x={eb.x}
          y={eb.y}
          width={eb.w}
          height={eb.h}
          rx={rx}
          fill="none"
          stroke="#0C62FB"
          strokeWidth="3"
          opacity="0.85"
        />
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArchitectureDiagram — module-level stable component
//
// Layout:
//   .arch-diagram (flex row):
//     .arch-canvas-wrap (flex-1): contains the Lucid SVG background + scrim
//     .arch-sidebar (~30%): service info panel (hidden when showSidebar=false)
//
// Props:
//   showSidebar — controls whether the internal sidebar panel is rendered.
//     Default: true (standalone use). Pass false when embedding inside
//     ScrollDeck, where the left-column narrative already shows step content.
// ─────────────────────────────────────────────────────────────────────────────

interface ArchitectureDiagramProps {
  /** Show the internal sidebar step panel. Default true. */
  showSidebar?: boolean;
}

export function ArchitectureDiagram({ showSidebar = true }: ArchitectureDiagramProps): React.ReactElement {
  const { subStep: step, isActive } = useContext(SubStepContext);
  const reducedMotion = usePrefersReducedMotion();

  const currentStepData = STEPS[step] ?? STEPS[0];
  const activeBBox = FOCUS_BOXES[step] ?? null;
  const isOverview = activeBBox === null;

  // aria-live announcement
  // Step 7 uses a distinct suffix so the string always differs from step 0,
  // ensuring screen readers re-announce even though both are "overview" views.
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  useEffect(() => {
    if (!isActive) return;
    if (isOverview) {
      const suffix = step === 0 ? "— press → to explore" : "— full overview";
      setLiveAnnouncement(`AWS Architecture diagram overview ${suffix}`);
    } else {
      setLiveAnnouncement(
        `Step ${step} of ${ARCH_DIAGRAM_STEP_COUNT - 1}: ${currentStepData.title}. ${currentStepData.bullets.join(" ")}`,
      );
    }
  }, [step, isActive, currentStepData, isOverview]);

  const isFirstOverview = step === 0;

  return (
    <div
      className="arch-diagram"
      role="region"
      aria-label="AWS Architecture Diagram"
      tabIndex={-1}
      data-reduced-motion={reducedMotion}
    >
      {/* Screen-reader live region — persistent (never remounted) */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="arch-sr-only"
      >
        {liveAnnouncement}
      </div>

      {/* ── Canvas area ──────────────────────────────────────────────── */}
      <div className="arch-canvas-wrap">
        {/* Lucid SVG background */}
        <img
          src={awsArchitectureSvgUrl}
          alt="AWS architecture diagram showing IaC, Edge, IoT Core, OTA, Backend, and Self-Healing components"
          className="arch-lucid-svg"
          draggable={false}
        />

        {/* Scrim overlay — only when a step is active and has a bbox */}
        {!isOverview && activeBBox && (
          <div
            key={step}
            className={`arch-scrim-wrap${reducedMotion ? " arch-scrim-wrap--no-anim" : ""}`}
          >
            <ScrimOverlay bbox={activeBBox} reducedMotion={reducedMotion} />
          </div>
        )}
      </div>

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      {showSidebar && (isFirstOverview ? (
        <aside
          className="arch-sidebar arch-sidebar--overview"
          aria-label="Diagram overview"
        >
          <div className="arch-sidebar__inner arch-sidebar__inner--overview">
            <h3 className="arch-sidebar__title">Unified Golden Path</h3>
            <ul className="arch-sidebar__list">
              {STEPS[0].bullets.map((bullet, i) => (
                <li key={i} className="arch-sidebar__item">
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="arch-sidebar__nav arch-sidebar__nav--hint" aria-label="Navigation hint">
              <span className="arch-sidebar__hint-big">
                Press <kbd>→</kbd> to explore each service
              </span>
            </div>
          </div>
        </aside>
      ) : (
        <aside
          key={step}
          className="arch-sidebar"
          aria-label={`Explanation: ${currentStepData.title}`}
        >
          <div className="arch-sidebar__inner">
            <h3 className="arch-sidebar__title">{currentStepData.title}</h3>
            <ul className="arch-sidebar__list">
              {currentStepData.bullets.map((bullet, i) => (
                <li key={i} className="arch-sidebar__item">
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="arch-sidebar__nav" aria-label="Step indicator">
              <span className="arch-sidebar__step">
                {step} / {ARCH_DIAGRAM_STEP_COUNT - 1}
              </span>
              <span className="arch-sidebar__hint">← → to navigate</span>
            </div>
          </div>
        </aside>
      ))}
    </div>
  );
}
