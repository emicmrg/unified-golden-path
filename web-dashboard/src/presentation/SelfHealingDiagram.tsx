/**
 * SelfHealingDiagram.tsx — Diagrama C: Self-Healing flow (GitHub ↔ AWS, Fargate mode).
 *
 * PATTERN: mirrors ArchitectureDiagram (A) and CrewDiagram (B) exactly:
 *   Lucid SVG as full background + ScrimOverlay (SVG <mask> spotlight) +
 *   sidebar panel, all driven by SelfHealingSubStepContext from the Deck.
 *
 * SVG METADATA (self-healing-flow.svg):
 *   Root: width="1182.5" height="821.5"
 *   Inner <g transform="translate(-259 0)">
 *   All bounding boxes below are in viewBox (outer) coordinates:
 *     viewBox_x = svg_elem_x + (-259) = svg_elem_x - 259
 *     viewBox_y = svg_elem_y (translate y=0)
 *
 * SVG LAYOUT (two main containers):
 *   GitHub container (dark border #3a414a):
 *     SVG path: M260 166 → left=260, top=160, w=320, h=660
 *     ViewBox:  x=1, y=160, w=320, h=660
 *     Contents (inside GitHub, viewBox coords):
 *       sample-service-ci icon:  svg(370,220)→vb(111,220), w=100, h=100
 *       sample-service-ci label: vb ≈ x=100, y=316 (below icon)
 *       self-heal-dispatch icon: svg(370,440)→vb(111,440), w=100, h=100
 *       GitHub App icon (reuses GH logo): svg(365,620)→vb(106,620), w=110, h=110
 *
 *   AWS container (orange border #242f3e):
 *     SVG rect: M720 160h720v660H720
 *     ViewBox:  x=461, y=160, w=720, h=660
 *     Contents (inside AWS, viewBox coords):
 *       IAM lock icon:  svg(900,280)→vb(641,280), w=80, h=80
 *       ECS Fargate box: svg(780,520)→vb(521,520), w=320, h=220
 *         (orange box with DynamoDB icon embedded)
 *       ECR icon:       svg(1260,230)→vb(1001,230), w=80, h=80
 *       Bedrock icon:   svg(1260,400)→vb(1001,400), w=80, h=80
 *       DynamoDB icon:  svg(1260,590)→vb(1001,590), w=80, h=80
 *
 * FOCUS ORDER (Fargate mode, approved by Emilio):
 *   Step 0 = Overview (full diagram, no highlight)
 *   Step 1 = CI fails: sample-service-ci (top section of GitHub container)
 *   Step 2 = self-heal-dispatch workflow (middle section of GitHub container)
 *   Step 3 = OIDC → IAM role ugp-ci-deploy-role (IAM lock area in AWS)
 *   Step 4 = ECS Fargate run-task (orange ECS box in AWS)
 *   Step 5 = Crew accesses: ECR + Bedrock + DynamoDB (right column of AWS)
 *   Step 6 = GitHub App + PR: Secrets Manager PEM → installation token (bottom GitHub)
 *   Step 7 = Full overview (no highlight, final view)
 *
 * BOUNDING BOX DERIVATION:
 *   Step 1 (CI):  GitHub top section, vb: x=1,   y=160, w=320, h=240
 *   Step 2 (Dispatch): GitHub mid,    vb: x=1,   y=400, w=320, h=200
 *   Step 3 (IAM):  IAM lock + padding, vb: x=621, y=260, w=130, h=130
 *   Step 4 (Fargate box): orange ECS,  vb: x=511, y=510, w=340, h=240
 *   Step 5 (ECR+Bedrock+DynamoDB): right side AWS column,
 *                                   vb: x=971, y=220, w=200, h=470
 *   Step 6 (GitHub App): GitHub bottom, vb: x=1, y=600, w=320, h=220
 *
 * SCRIM / SPOTLIGHT TECHNIQUE — identical to ArchitectureDiagram and CrewDiagram:
 *   SVG <mask>: white base + black holes at active bbox(es).
 *   NO clipPath. Cross-fade. reduced-motion: no animation.
 *
 * COORDINATION: SelfHealingSubStepContext (separate context, same pattern as
 * CrewSubStepContext). Deck provides it only for this slide's index.
 *
 * ACCESSIBILITY: aria-live announces active step. role="region".
 * REDUCED MOTION: overlay switches instantly (no cross-fade).
 */

import React, { createContext, useContext, useEffect, useId, useState } from "react";
// Reuse ArchitectureDiagram's CSS — same class names, same look.
import "./ArchitectureDiagram.css";
// Import SVG as URL (Vite asset URL import).
import selfHealingFlowSvgUrl from "./assets/self-healing-flow.svg";
// Reuse BBox and SubStepContextValue types from ArchitectureDiagram.
import type { BBox, SubStepContextValue } from "./ArchitectureDiagram.js";

// ─────────────────────────────────────────────────────────────────────────────
// SVG viewBox dimensions (from root <svg> width/height attributes)
// ─────────────────────────────────────────────────────────────────────────────

export const SH_SVG_VB_W = 1182.5;
export const SH_SVG_VB_H = 821.5;

// ─────────────────────────────────────────────────────────────────────────────
// Focus bounding boxes (in viewBox coordinates)
//
// Derivation: SVG element coords inside <g transform="translate(-259 0)">
//   viewBox_x = svg_elem_x - 259
//   viewBox_y = svg_elem_y (y-translate = 0)
//
// Step 1 — CI fails (sample-service-ci area, top of GitHub container):
//   GitHub container starts at vb(1, 160). CI icon at svg(370,220) → vb(111,220).
//   Label rect M349,326 → vb(90, 326). Total top area: vb x=1, y=160, w=320, h=240.
//
// Step 2 — self-heal-dispatch workflow (middle of GitHub container):
//   Dispatch icon at svg(370,440) → vb(111,440). Label at svg(349,546) → vb(90,546).
//   Middle band: vb x=1, y=400, w=320, h=200.
//
// Step 3 — OIDC → IAM role (IAM lock in AWS):
//   Lock icon at svg(900,280) → vb(641,280), 80×80.
//   With padding: vb x=620, y=260, w=130, h=130.
//
// Step 4 — ECS Fargate run-task (orange ECS box):
//   Box svg M780,520 w320 h220 → vb(521,520,320,220).
//   With padding: vb x=511, y=510, w=340, h=240.
//
// Step 5 — Crew accesses ECR + Bedrock + DynamoDB (right column):
//   ECR at svg(1260,230) → vb(1001,230), 80×80.
//   Bedrock at svg(1260,400) → vb(1001,400), 80×80.
//   DynamoDB at svg(1260.45,590.23) → vb(1001,590), ~80×80.
//   Right column bounding box covers all three: vb x=971, y=220, w=200, h=470.
//
// Step 6 — GitHub App + PR (bottom of GitHub container):
//   GitHub App icon at svg(365,620) → vb(106,620), w=110 h=110.
//   Bottom area: vb x=1, y=600, w=320, h=220.
// ─────────────────────────────────────────────────────────────────────────────

export const SH_FOCUS_BOXES: (BBox | null)[] = [
  null,  // Step 0: overview (no highlight)
  // Step 1: CI fails — sample-service-ci (top section of GitHub container)
  { x: 1, y: 160, w: 320, h: 240 },
  // Step 2: self-heal-dispatch — middle section of GitHub container
  { x: 1, y: 400, w: 320, h: 200 },
  // Step 3: OIDC → IAM role ugp-ci-deploy-role (IAM lock in AWS)
  { x: 620, y: 258, w: 132, h: 132 },
  // Step 4: ECS Fargate run-task (orange ECS/Fargate box)
  { x: 511, y: 510, w: 340, h: 240 },
  // Step 5: Crew accesses ECR + Bedrock + DynamoDB (right column AWS)
  { x: 971, y: 218, w: 202, h: 474 },
  // Step 6: GitHub App + Secrets Manager → installation token → PR
  { x: 1, y: 596, w: 320, h: 220 },
  null,  // Step 7: full overview again (no highlight)
];

export const SH_DIAGRAM_STEP_COUNT = SH_FOCUS_BOXES.length; // 8 (steps 0..7)

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar step data — English, faithful to self-heal-dispatch.yml + SelfHealingStack
// ─────────────────────────────────────────────────────────────────────────────

export interface SHStepData {
  id: string;
  title: string;
  bullets: string[];
}

export const SH_STEPS: SHStepData[] = [
  {
    id: "overview",
    title: "Self-Healing Flow — GitHub ↔ AWS (Fargate Mode)",
    bullets: [
      "GitHub CI detects a failure → self-heal-dispatch workflow fires → ECS Fargate runs the crew",
      "OIDC federation: no static AWS keys; ugp-ci-deploy-role assumed via JWT trust policy",
      "Crew runs isolated in Fargate: pulls ECR image, calls Bedrock, checks DynamoDB circuit breaker",
      "GitHub App opens a fix/* PR using a short-lived installation token (not GITHUB_TOKEN)",
    ],
  },
  {
    id: "ci-fails",
    title: "Step 1 — CI Fails: sample-service-ci",
    bullets: [
      "sample-service-ci build+test job fails (e.g. introduced bug in sample-service/)",
      "GitHub emits a workflow_run event with conclusion=failure targeting self-heal-dispatch.yml",
      "The failure is the trigger — not a webhook, not a cron; pure event-driven from GitHub",
    ],
  },
  {
    id: "dispatch",
    title: "Step 2 — self-heal-dispatch.yml",
    bullets: [
      "Listens on: workflow_run → workflows: [sample-service-ci] → types: [completed]",
      "Guard: vars.SELF_HEAL_MODE == 'fargate' (repo variable — set in GitHub Actions UI)",
      "Same-repo guard: github.event.workflow_run.head_repository.full_name == github.repository",
      "Action: runs aws ecs run-task (fire-and-forget) — the runner does NOT wait for the crew",
    ],
  },
  {
    id: "oidc",
    title: "Step 3 — OIDC → ugp-ci-deploy-role",
    bullets: [
      "Workflow uses aws-actions/configure-aws-credentials@v4 with role-to-assume: vars.CI_DEPLOY_ROLE_ARN (ugp-ci-deploy-role)",
      "GitHub OIDC provider issues a JWT; AWS STS exchanges it for temporary credentials",
      "Trust policy scoped to: token.actions.githubusercontent.com sub: repo:{org}/{repo}:ref:refs/heads/main",
      "No static AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY stored anywhere",
    ],
  },
  {
    id: "fargate",
    title: "Step 4 — ECS Fargate run-task (fire-and-forget)",
    bullets: [
      "aws ecs run-task --cluster ugp-self-healing --task-definition ugp-self-healing-crew",
      "Task runs in a PUBLIC subnet (natGateways=0, assignPublicIp=ENABLED); isolation via egress-only SG (no inbound rules)",
      "The Actions runner exits immediately after submitting — no blocking poll",
      "The crew runs ISOLATED from the GitHub Actions runner process and lifecycle",
    ],
  },
  {
    id: "crew-access",
    title: "Step 5 — Crew: ECR + Bedrock + DynamoDB",
    bullets: [
      "Pulls its own Docker image from ECR (Amazon Elastic Container Registry)",
      "Calls Amazon Bedrock Claude Sonnet 4.5 for diagnosis and patch generation",
      "Reads/writes DynamoDB table ugp-self-healing-circuit-breaker: circuit breaker (max 2 attempts per run)",
      "ECS Execution Role pulls image from ECR (ecr:GetAuthorizationToken + BatchGetImage via grantPull); Task Role (least-privilege): bedrock:InvokeModel + dynamodb:GetItem/PutItem + secretsmanager:GetSecretValue",
    ],
  },
  {
    id: "github-app",
    title: "Step 6 — GitHub App → fix/* PR",
    bullets: [
      "In Fargate mode the crew does NOT use GITHUB_TOKEN (that belongs to the Actions runner — already gone)",
      "Reads the GitHub App PEM private key from AWS Secrets Manager (ARN from CDK output GithubAppSecretArn; no fixed secretName — name is CDK-generated)",
      "Signs a JWT RS256 (app_id + pem) → calls /app/installations/{id}/access_tokens → installation token (~1h)",
      "Uses installation token to push a fix/* branch and open a PR against main",
    ],
  },
  {
    id: "overview-final",
    title: "Self-Healing Flow — GitHub ↔ AWS (Final)",
    bullets: [
      "GitHub CI detects a failure → self-heal-dispatch workflow fires → ECS Fargate runs the crew",
      "OIDC federation: no static AWS keys; ugp-ci-deploy-role assumed via JWT trust policy",
      "Crew runs isolated in Fargate: pulls ECR image, calls Bedrock, checks DynamoDB circuit breaker",
      "GitHub App opens a fix/* PR using a short-lived installation token (not GITHUB_TOKEN)",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SelfHealingSubStepContext — separate context (same pattern as CrewSubStepContext)
//
// Reason: Deck renders ALL slides simultaneously. Using a separate context per
// diagram prevents cross-slide contamination when navigating sub-steps.
// ─────────────────────────────────────────────────────────────────────────────

export const SelfHealingSubStepContext = createContext<SubStepContextValue>({
  subStep: 0,
  isActive: false,
});

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
// SHScrimOverlay — SVG <mask> spotlight (identical technique to A and B)
//
// Uses SH_SVG_VB_W / SH_SVG_VB_H so dimensions match self-healing-flow.svg.
// Supports multi-region spotlight via extraBBoxes (used for Step 5: ECR+Bedrock+DDB).
// ─────────────────────────────────────────────────────────────────────────────

interface SHScrimOverlayProps {
  bbox: BBox;
  extraBBoxes?: BBox[];
  reducedMotion: boolean;
}

function SHScrimOverlay({ bbox, extraBBoxes = [], reducedMotion }: SHScrimOverlayProps): React.ReactElement {
  const PAD = 12;
  const maskId = `sh-scrim-mask-${useId().replace(/:/g, "")}`;

  const padBBox = (b: BBox): BBox => {
    const x = Math.max(0, b.x - PAD);
    const y = Math.max(0, b.y - PAD);
    const w = Math.min(SH_SVG_VB_W - x, b.w + PAD * 2);
    const h = Math.min(SH_SVG_VB_H - y, b.h + PAD * 2);
    return { x, y, w, h };
  };

  const primary = padBBox(bbox);
  const extras = extraBBoxes.map(padBBox);
  const rx = 14;

  return (
    <svg
      className="arch-scrim"
      viewBox={`0 0 ${SH_SVG_VB_W} ${SH_SVG_VB_H}`}
      aria-hidden="true"
      data-reduced-motion={reducedMotion}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          {/* White base: scrim drawn everywhere by default */}
          <rect x="0" y="0" width={SH_SVG_VB_W} height={SH_SVG_VB_H} fill="white" />
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
        width={SH_SVG_VB_W}
        height={SH_SVG_VB_H}
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
// SelfHealingDiagram — module-level stable component
//
// Layout (same CSS classes as ArchitectureDiagram and CrewDiagram):
//   .arch-diagram (flex row):
//     .arch-canvas-wrap (flex-1): Lucid SVG background + scrim
//     .arch-sidebar (~30%): step info panel
// ─────────────────────────────────────────────────────────────────────────────

export function SelfHealingDiagram(): React.ReactElement {
  const { subStep: step, isActive } = useContext(SelfHealingSubStepContext);
  const reducedMotion = usePrefersReducedMotion();

  const currentStepData = SH_STEPS[step] ?? SH_STEPS[0];
  const activeBBox = SH_FOCUS_BOXES[step] ?? null;
  const isOverview = activeBBox === null;

  // aria-live announcement
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  useEffect(() => {
    if (!isActive) return;
    if (isOverview) {
      const suffix = step === 0 ? "— press → to walk through each step" : "— full overview";
      setLiveAnnouncement(`Self-Healing Flow diagram overview ${suffix}`);
    } else {
      setLiveAnnouncement(
        `Step ${step} of ${SH_DIAGRAM_STEP_COUNT - 1}: ${currentStepData.title}. ${currentStepData.bullets.join(" ")}`,
      );
    }
  }, [step, isActive, currentStepData, isOverview]);

  const isFirstOverview = step === 0;

  return (
    <div
      className="arch-diagram"
      role="region"
      aria-label="Self-Healing Flow Diagram"
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
        {/* Lucid SVG background — self-hosted asset, meets CSP img-src 'self' */}
        <img
          src={selfHealingFlowSvgUrl}
          alt="Self-healing flow diagram showing GitHub CI, self-heal-dispatch workflow, AWS OIDC, ECS Fargate crew, ECR, Amazon Bedrock, DynamoDB, and GitHub App opening a fix PR"
          className="arch-lucid-svg"
          draggable={false}
        />

        {/* Scrim overlay — only when a step is active and has a bbox */}
        {!isOverview && activeBBox && (
          <div
            key={step}
            className={`arch-scrim-wrap${reducedMotion ? " arch-scrim-wrap--no-anim" : ""}`}
          >
            <SHScrimOverlay bbox={activeBBox} reducedMotion={reducedMotion} />
          </div>
        )}
      </div>

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      {isFirstOverview ? (
        <aside
          className="arch-sidebar arch-sidebar--overview"
          aria-label="Diagram overview"
        >
          <div className="arch-sidebar__inner arch-sidebar__inner--overview">
            <h3 className="arch-sidebar__title">Self-Healing Flow</h3>
            <ul className="arch-sidebar__list">
              {SH_STEPS[0].bullets.map((bullet, i) => (
                <li key={i} className="arch-sidebar__item">
                  {bullet}
                </li>
              ))}
            </ul>
            <div className="arch-sidebar__nav arch-sidebar__nav--hint" aria-label="Navigation hint">
              <span className="arch-sidebar__hint-big">
                Press <kbd>→</kbd> to walk through each step
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
                {step} / {SH_DIAGRAM_STEP_COUNT - 1}
              </span>
              <span className="arch-sidebar__hint">← → to navigate</span>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
