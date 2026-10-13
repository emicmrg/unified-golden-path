/**
 * ScrollDeck.tsx — Scrollytelling presentation deck.
 *
 * ARCHITECTURE — MODEL A / C1 variant, generalized from ScrollProto.
 *
 * Document scrolls; diagram column is position:sticky within each section.
 * IntersectionObserver (root=viewport) detects which step is centered.
 * Hysteresis deadband 40 px prevents oscillation between adjacent steps.
 * Keyboard: window keydown, gated by section visibility, deterministic
 * targetStepRef pattern with scrollend resync (same as ScrollProto).
 *
 * Sections:
 *   1. Cover         — full-bleed navy slide, no diagram
 *   2. Platform      — monorepo overview, no diagram
 *   3. Firmware/Edge — Diagram A (highlights ESP32 + IoT areas), MQTT callout
 *   4. Architecture  — Diagram A (all AWS services), SubStepContext
 *   5. Agents        — Diagram B (CrewAI), CrewSubStepContext
 *   6. Self-Healing  — Diagram C (Fargate flow), SelfHealingSubStepContext
 *   7. Closing       — navy slide, honest debt
 *
 * CSP: SVG imported as Vite asset URLs (img-src 'self'). Zero external fonts.
 * A11y: aria-live polite, aria-current on active step, keyboard navigation.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  ArchitectureDiagram,
  SubStepContext,
  STEPS as ARCH_STEPS,
} from "./ArchitectureDiagram.js";
import {
  CrewDiagram,
  CrewSubStepContext,
  CREW_STEPS,
} from "./CrewDiagram.js";
import {
  SelfHealingDiagram,
  SelfHealingSubStepContext,
  SH_STEPS,
} from "./SelfHealingDiagram.js";
import { selectStep, navigateStep } from "../proto/ScrollProto.js";

import "./ScrollDeck.css";

// ─────────────────────────────────────────────────────────────────────────────
// Section descriptor (for nav dots)
// ─────────────────────────────────────────────────────────────────────────────

type SectionId =
  | "cover"
  | "platform"
  | "firmware"
  | "architecture"
  | "agents"
  | "self-healing"
  | "closing";

interface SectionMeta {
  id: SectionId;
  label: string;
}

const SECTION_META: SectionMeta[] = [
  { id: "cover",        label: "Cover" },
  { id: "platform",     label: "Platform" },
  { id: "firmware",     label: "Firmware / Edge" },
  { id: "architecture", label: "AWS Architecture" },
  { id: "agents",       label: "AI Agents" },
  { id: "self-healing", label: "Self-Healing Flow" },
  { id: "closing",      label: "Closing" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useC1ActiveStep — MODEL A (listens on window, not nested scroll)
// Pure implementation, same as ScrollProto.
// ─────────────────────────────────────────────────────────────────────────────

const DEADBAND = 40;

export function useC1ActiveStep(
  stepRefs: React.RefObject<(HTMLElement | null)[]>,
  stepCount: number,
  enabled: boolean,
): number {
  const [activeStep, setActiveStep] = useState(0);
  const committedRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);

  const compute = useCallback(() => {
    const steps = stepRefs.current;
    if (!steps) return;
    const viewportCenter = window.innerHeight / 2;
    const distances: number[] = [];
    for (let i = 0; i < stepCount; i++) {
      const el = steps[i];
      if (!el) { distances.push(Infinity); continue; }
      const rect = el.getBoundingClientRect();
      distances.push(Math.abs(rect.top + rect.height / 2 - viewportCenter));
    }
    const next = selectStep(distances, committedRef.current, DEADBAND);
    if (next !== committedRef.current) {
      committedRef.current = next;
      setActiveStep(next);
    }
  }, [stepRefs, stepCount]);

  useEffect(() => {
    if (!enabled) return;
    const onScroll = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => { rafRef.current = null; compute(); });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    compute();
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [enabled, compute]);

  return activeStep;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useSectionVisible (IntersectionObserver, 5% threshold)
// ─────────────────────────────────────────────────────────────────────────────

function useSectionVisible(sectionRef: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: null, threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sectionRef]);
  return visible;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useKeyboardNav (window keydown, gated by isVisible)
// ─────────────────────────────────────────────────────────────────────────────

function useKeyboardNav(
  isVisible: boolean,
  targetStepRef: React.MutableRefObject<number>,
  stepCount: number,
  scrollToStep: (idx: number) => void,
): void {
  useEffect(() => {
    if (!isVisible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      const editable = (e.target as HTMLElement | null)?.isContentEditable ?? false;
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(tag) || editable) return;
      const next = navigateStep(targetStepRef.current, e.key, stepCount);
      if (next !== null) {
        e.preventDefault();
        targetStepRef.current = next;
        scrollToStep(next);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isVisible, targetStepRef, stepCount, scrollToStep]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook: useScrollResync (settles targetStepRef to observed after scroll)
// Registered once (deps:[]) — cleanup never cancels pending debounce.
// ─────────────────────────────────────────────────────────────────────────────

function useScrollResync(
  targetStepRef: React.MutableRefObject<number>,
  activeStepRef: React.MutableRefObject<number>,
): void {
  useEffect(() => {
    const resync = () => { targetStepRef.current = activeStepRef.current; };
    const syncTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
    const onScrollSettle = () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      syncTimerRef.current = setTimeout(resync, 150);
    };
    window.addEventListener("scrollend", resync, { passive: true });
    window.addEventListener("scroll", onScrollSettle, { passive: true });
    return () => {
      window.removeEventListener("scrollend", resync);
      window.removeEventListener("scroll", onScrollSettle);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentional empty — register once
}

// ─────────────────────────────────────────────────────────────────────────────
// DiagramSection — scrollytelling section with sticky diagram
// Self-contained: manages its own activeStep + keyboard + context.
// ─────────────────────────────────────────────────────────────────────────────

interface StepData {
  id: string;
  title: string;
  bullets: string[];
}

interface DiagramSectionProps {
  id: SectionId;
  label: string;
  steps: StepData[];
  renderDiagram: (activeStep: number) => React.ReactNode;
  /** Wraps the story (text + diagram) in the appropriate SubStep Context.Provider */
  contextWrapper: (
    params: { activeStep: number; isActive: boolean; children: React.ReactNode }
  ) => React.ReactNode;
}

function DiagramSection({
  id,
  label,
  steps,
  renderDiagram,
  contextWrapper,
}: DiagramSectionProps): React.ReactElement {
  const stepCount = steps.length;
  const sectionRef = useRef<HTMLElement | null>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const announcerId = useId();
  const [announcement, setAnnouncement] = useState("");

  const isVisible = useSectionVisible(sectionRef);
  const activeStep = useC1ActiveStep(stepRefs, stepCount, isVisible);

  const activeStepRef = useRef<number>(activeStep);
  useEffect(() => { activeStepRef.current = activeStep; }, [activeStep]);

  const targetStepRef = useRef<number>(0);
  useScrollResync(targetStepRef, activeStepRef);

  // Announce step name via aria-live
  useEffect(() => {
    const step = steps[activeStep];
    if (step) setAnnouncement(step.title);
  }, [activeStep, steps]);

  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const scrollToStep = useCallback(
    (idx: number) => {
      const el = stepRefs.current[idx];
      if (!el) return;
      el.scrollIntoView({ behavior: prefersReducedMotion ? "instant" : "smooth", block: "start" });
    },
    [prefersReducedMotion],
  );

  useKeyboardNav(isVisible, targetStepRef, stepCount, scrollToStep);

  const story = (
    <div
      className="deck-story"
      role="region"
      aria-label={`${label} — use Arrow keys, Space, Home, End to navigate`}
      tabIndex={0}
    >
      {/* Text column — plain document flow */}
      <div className="deck-steps">
        {steps.map((step, idx) => (
          <article
            key={step.id}
            ref={(el) => { stepRefs.current[idx] = el; }}
            data-step-idx={idx}
            className="deck-step"
            data-active={activeStep === idx ? "true" : "false"}
            aria-current={activeStep === idx ? "true" : undefined}
            aria-labelledby={`${announcerId}-step-${idx}`}
          >
            <p className="deck-step__num">
              {idx === 0 || idx === stepCount - 1
                ? "Overview"
                : `Step ${idx} of ${stepCount - 2}`}
            </p>
            <h3 id={`${announcerId}-step-${idx}`} className="deck-step__title">
              {step.title}
            </h3>
            <ul className="deck-step__list">
              {step.bullets.map((bullet, bi) => (
                <li key={bi} className="deck-step__item">{bullet}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {/* Diagram column — position:sticky */}
      <div className="deck-diagram-pin" aria-hidden="true">
        {renderDiagram(activeStep)}
        <p className="deck-keyboard-hint" aria-hidden="true">
          Arrow keys · Space · Home · End to navigate
        </p>
      </div>
    </div>
  );

  return (
    <section
      id={`section-${id}`}
      ref={sectionRef}
      className="deck-section deck-section--diagram"
      aria-label={label}
    >
      {/* Accessible live region */}
      <div
        id={announcerId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="deck-sr-only"
      >
        {announcement}
      </div>

      {contextWrapper({ activeStep, isActive: isVisible, children: story })}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ContentSection — full-viewport section, no sticky diagram
// ─────────────────────────────────────────────────────────────────────────────

function ContentSection({
  id,
  className = "",
  children,
}: {
  id: SectionId;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      id={`section-${id}`}
      className={`deck-section deck-section--content ${className}`.trim()}
    >
      {children}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFIED content (no invented data, security notes honored)
// ─────────────────────────────────────────────────────────────────────────────

// --- 1. Cover ---

function CoverSection(): React.ReactElement {
  return (
    <ContentSection id="cover">
      <div className="section-cover">
        <div className="section-cover__bars" aria-hidden="true" />
        <p className="slide-cover__eyebrow">Platform Engineering Talk</p>
        <h1 className="slide-h1--display">
          <span className="slide-h1__line">AI, IoT &amp; Cloud:</span>
          <span className="slide-h1__line">Building a Recovery Path</span>
          <span className="slide-h1__line">from Edge to Cloud</span>
        </h1>
        <p className="slide-body--lead section-cover__subtitle">
          Unified Golden Path &mdash; ESP32 to Bedrock self-healing
        </p>
        <div className="section-cover__footer">
          <span>Slalom Innovation Labs GDL</span>
          <span aria-hidden="true"> · </span>
          <span>us-east-1</span>
        </div>
      </div>
    </ContentSection>
  );
}

// --- 2. Platform ---

function PlatformSection(): React.ReactElement {
  return (
    <ContentSection id="platform">
      <div className="section-content">
        <div className="section-content__inner">
          <p className="slide-cover__eyebrow">The Platform</p>
          <h2 className="slide-h2">The Unified Golden Path</h2>
          <p className="slide-body--lead">
            A monorepo that spans from embedded C to cloud infrastructure,
            built end-to-end by a Kiro agent harness.
          </p>
          <ul className="section-list">
            <li>
              <strong className="slide-strong">edge-firmware</strong> — ESP32 (ESP-IDF 5.3),
              C/C++, MQTT + OTA
            </li>
            <li>
              <strong className="slide-strong">infra</strong> — 3 CDK v2 stacks
              deployed to AWS sandbox (IoT, Self-Healing, Dashboard)
            </li>
            <li>
              <strong className="slide-strong">self-healing-crew</strong> — 3-agent
              CrewAI on Bedrock Claude Sonnet 4.5
            </li>
            <li>
              <strong className="slide-strong">sample-service</strong> — Node.js serverless
              with injectable bug for the live demo
            </li>
            <li>
              <strong className="slide-strong">web-dashboard</strong> — React SPA,
              Amplify-hosted, live MQTT-WSS telemetry
            </li>
          </ul>
          <p className="slide-body--caption section-content__meta">
            Built by a Kiro agent harness: research &rarr; dev &rarr; test &rarr;
            double-review &rarr; security. All 3 CDK stacks deployed and healthy.
          </p>
        </div>
      </div>
    </ContentSection>
  );
}

// --- 3. Firmware / Edge ---
// Reuses Diagram A with a custom step → ARCH focus-box mapping.
// The MQTT callout is woven into the step bullets; no passwords shown.

const FIRMWARE_STEPS: StepData[] = [
  {
    id: "overview",
    title: "Firmware / Edge — ESP32 as an IoT Node",
    bullets: [
      "Hardware: ESP32 running ESP-IDF 5.3 — WiFi + MQTT over TLS out of the box",
      "Identity: device cert + private key + AmazonRootCA1 embedded in flash at provision time",
      "Validated end-to-end on physical hardware — real MQTT connection to AWS IoT Core",
    ],
  },
  {
    id: "mqtt-transport",
    title: "MQTT Transport — Technical Spec",
    bullets: [
      "Protocol: MQTT 3.1.1 over TLS 1.2 mutual-auth (X.509), port 8883",
      "Client ID == IoT Thing name (policy-enforced — no spoofing allowed)",
      "Keepalive: 60 s · auto-reconnect every 5 s on disconnect",
      "No passwords — identity is the embedded X.509 device certificate",
    ],
  },
  {
    id: "telemetry",
    title: "Telemetry — Topic & Payload",
    bullets: [
      "Topic: ugp/telemetry/ugp-gateway-01",
      "QoS 1, published every 2 s",
      "Payload: { deviceId, temperatureCelsius, humidityPercent, timestamp }",
      "DHT11 sensor driver is a stub (honest debt) — schema is live and connected",
    ],
  },
  {
    id: "identity",
    title: "Device Identity & IoT Policy",
    bullets: [
      "cert + key + AmazonRootCA1 embedded in flash — provisioned once, never rotated over-the-air",
      "IoT policy: least-privilege, no wildcards — scoped to this Thing name only",
      "No ALPN on port 8883 (ALPN applies only when using port 443 — not used here)",
      "Code signing: OFF — integrity via TLS 1.2 transport + SHA-256 OTA digest; not code-signing authenticity",
    ],
  },
  {
    id: "ota",
    title: "OTA Firmware Updates — A/B Partition",
    bullets: [
      "IoT Jobs topic: $aws/things/<thing>/jobs/* — device polls and executes the job",
      "Download: esp_https_ota over HTTPS (presigned S3 URL generated by IoT Jobs)",
      "SHA-256 digest verified before committing to the inactive A/B partition",
      "Auto-rollback: if health check (WiFi + MQTT reconnect) fails within 120 s, reverts",
    ],
  },
  {
    id: "validated",
    title: "Validated on Hardware",
    bullets: [
      "MQTT 3.1.1 / TLS 1.2 mutual-auth to AWS IoT Core: confirmed end-to-end on physical ESP32",
      "mTLS identity, least-privilege IoT policy, OTA A/B partitions all active",
      "WiFi credentials stay in .env — never shown in slides or committed to the repo",
    ],
  },
];

// Map each firmware step index to an ARCH_FOCUS_BOXES sub-step index
// 0→overview, 1→ESP32(step2), 2→IoTCore(step3), 3→IoTCore(step3), 4→OTA(step4), 5→overview-final(step7)
const FIRMWARE_TO_ARCH: number[] = [0, 2, 3, 3, 4, 7];

function FirmwareSection(): React.ReactElement {
  const stepCount = FIRMWARE_STEPS.length;
  const sectionRef = useRef<HTMLElement | null>(null);
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const announcerId = useId();
  const [announcement, setAnnouncement] = useState("");

  const isVisible = useSectionVisible(sectionRef);
  const activeStep = useC1ActiveStep(stepRefs, stepCount, isVisible);

  const activeStepRef = useRef<number>(activeStep);
  useEffect(() => { activeStepRef.current = activeStep; }, [activeStep]);

  const targetStepRef = useRef<number>(0);
  useScrollResync(targetStepRef, activeStepRef);

  const archSubStep = FIRMWARE_TO_ARCH[activeStep] ?? 0;

  useEffect(() => {
    const step = FIRMWARE_STEPS[activeStep];
    if (step) setAnnouncement(step.title);
  }, [activeStep]);

  const prefersReducedMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

  const scrollToStep = useCallback(
    (idx: number) => {
      const el = stepRefs.current[idx];
      if (!el) return;
      el.scrollIntoView({ behavior: prefersReducedMotion ? "instant" : "smooth", block: "start" });
    },
    [prefersReducedMotion],
  );

  useKeyboardNav(isVisible, targetStepRef, stepCount, scrollToStep);

  return (
    <section
      id="section-firmware"
      ref={sectionRef}
      className="deck-section deck-section--diagram"
      aria-label="Firmware / Edge"
    >
      <div
        id={announcerId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="deck-sr-only"
      >
        {announcement}
      </div>

      <SubStepContext.Provider value={{ subStep: archSubStep, isActive: isVisible }}>
        <div
          className="deck-story"
          role="region"
          aria-label="Firmware / Edge — use Arrow keys, Space, Home, End to navigate"
          tabIndex={0}
        >
          {/* Text column */}
          <div className="deck-steps">
            {FIRMWARE_STEPS.map((step, idx) => (
              <article
                key={step.id}
                ref={(el) => { stepRefs.current[idx] = el; }}
                data-step-idx={idx}
                className="deck-step"
                data-active={activeStep === idx ? "true" : "false"}
                aria-current={activeStep === idx ? "true" : undefined}
                aria-labelledby={`${announcerId}-step-${idx}`}
              >
                <p className="deck-step__num">
                  {idx === 0 || idx === stepCount - 1
                    ? "Overview"
                    : `Step ${idx} of ${stepCount - 2}`}
                </p>
                <h3 id={`${announcerId}-step-${idx}`} className="deck-step__title">
                  {step.title}
                </h3>
                <ul className="deck-step__list">
                  {step.bullets.map((bullet, bi) => (
                    <li key={bi} className="deck-step__item">{bullet}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {/* Sticky diagram — Diagram A highlighting edge/IoT areas */}
          <div className="deck-diagram-pin" aria-hidden="true">
            <ArchitectureDiagram />
            <p className="deck-keyboard-hint" aria-hidden="true">
              Arrow keys · Space · Home · End to navigate
            </p>
          </div>
        </div>
      </SubStepContext.Provider>
    </section>
  );
}

// --- 7. Closing ---

function ClosingSection(): React.ReactElement {
  return (
    <ContentSection id="closing">
      <div className="section-closing">
        <div className="section-closing__bars" aria-hidden="true" />
        <p className="slide-closing__eyebrow">What We Built</p>
        <h2 className="slide-h2 section-closing__title">What&apos;s Next?</h2>
        <ul className="section-list section-list--closing">
          <li>
            <strong className="slide-strong">Edge mTLS validated on hardware</strong> —
            ESP32 connects to IoT Core with X.509 mutual-auth, port 8883
          </li>
          <li>
            <strong className="slide-strong">3 CDK stacks deployed and healthy</strong> —
            UgpIotStack, SelfHealingStack, DashboardStack in the sandbox account
          </li>
          <li>
            <strong className="slide-strong">3-agent crew on Bedrock</strong> —
            Claude Sonnet 4.5 diagnosed a real bug and opened a fix/* PR end-to-end
          </li>
          <li>
            <strong className="slide-strong">main branch-protected</strong> —
            required CI checks, enforce_admins, dismiss stale reviews active
          </li>
        </ul>
        <p className="slide-body--caption section-closing__debt">
          <strong>Honest debt:</strong> DHT11 real sensor driver and secure boot are deferred.
          Code signing is OFF &mdash; integrity guaranteed by TLS 1.2 + SHA-256 OTA digest,
          not by code-signing authenticity.
        </p>
      </div>
    </ContentSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav dots
// ─────────────────────────────────────────────────────────────────────────────

function NavDots({
  activeId,
  onNavigate,
}: {
  activeId: SectionId;
  onNavigate: (id: SectionId) => void;
}): React.ReactElement {
  return (
    <nav className="deck-nav-dots" aria-label="Presentation sections">
      <ul role="list">
        {SECTION_META.map((s) => (
          <li key={s.id}>
            <button
              className="deck-nav-dot"
              aria-label={s.label}
              aria-current={activeId === s.id ? "location" : undefined}
              data-active={activeId === s.id ? "true" : "false"}
              onClick={() => onNavigate(s.id)}
            />
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ScrollDeck — root
// ─────────────────────────────────────────────────────────────────────────────

export function ScrollDeck(): React.ReactElement {
  const [activeSection, setActiveSection] = useState<SectionId>("cover");

  // Track which section is most visible
  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    SECTION_META.forEach(({ id }) => {
      const el = document.getElementById(`section-${id}`);
      if (!el) return;
      const io = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveSection(id); },
        { root: null, threshold: 0.35 },
      );
      io.observe(el);
      observers.push(io);
    });
    return () => observers.forEach((o) => o.disconnect());
  }, []);

  const navigateTo = useCallback((id: SectionId) => {
    const el = document.getElementById(`section-${id}`);
    if (!el) return;
    const reduced =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    el.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "start" });
  }, []);

  return (
    <div className="scroll-deck" data-testid="scroll-deck">
      <NavDots activeId={activeSection} onNavigate={navigateTo} />

      {/* 1. Cover */}
      <CoverSection />

      {/* 2. Platform */}
      <PlatformSection />

      {/* 3. Firmware / Edge — Diagram A highlighting ESP32 + IoT Core */}
      <FirmwareSection />

      {/* 4. Architecture — Diagram A, all AWS services */}
      <DiagramSection
        id="architecture"
        label="AWS Architecture"
        steps={ARCH_STEPS}
        renderDiagram={() => <ArchitectureDiagram />}
        contextWrapper={({ activeStep, isActive, children }) => (
          <SubStepContext.Provider value={{ subStep: activeStep, isActive }}>
            {children}
          </SubStepContext.Provider>
        )}
      />

      {/* 5. AI Agents — Diagram B */}
      <DiagramSection
        id="agents"
        label="AI Agents — CrewAI"
        steps={CREW_STEPS}
        renderDiagram={() => <CrewDiagram />}
        contextWrapper={({ activeStep, isActive, children }) => (
          <CrewSubStepContext.Provider value={{ subStep: activeStep, isActive }}>
            {children}
          </CrewSubStepContext.Provider>
        )}
      />

      {/* 6. Self-Healing — Diagram C */}
      <DiagramSection
        id="self-healing"
        label="Self-Healing Flow"
        steps={SH_STEPS}
        renderDiagram={() => <SelfHealingDiagram />}
        contextWrapper={({ activeStep, isActive, children }) => (
          <SelfHealingSubStepContext.Provider value={{ subStep: activeStep, isActive }}>
            {children}
          </SelfHealingSubStepContext.Provider>
        )}
      />

      {/* 7. Closing */}
      <ClosingSection />
    </div>
  );
}
