"use client";

// Demos built from the component libraries vendored into this project:
// Bklit (charts), Motion Primitives, Kokonut UI, Watermelon UI, and anime.js.

import * as React from "react";
import { curveNatural } from "d3-shape";
import { Eye, FileText, Radar, Search, Sparkles, X } from "lucide-react";
import {
  Area,
  AreaChart,
  AreaSparkline,
  Bar,
  BarChart,
  BarSparkline,
  BarXAxis,
  ChartTooltip,
  Gauge,
  Grid,
  Line,
  LineChart,
  LineSparkline,
  Ring,
  RingCenter,
  RingChart,
  XAxis,
} from "@/components/charts";
import { DotGridPulse } from "@/components/app/motion/DotGridPulse";
import { Button } from "@/components/ui/button";
import { BorderTrail } from "@/components/motion-primitives/border-trail";
import { GlowEffect } from "@/components/motion-primitives/glow-effect";
import { Magnetic } from "@/components/motion-primitives/magnetic";
import {
  MorphingDialog,
  MorphingDialogClose,
  MorphingDialogContainer,
  MorphingDialogContent,
  MorphingDialogDescription,
  MorphingDialogSubtitle,
  MorphingDialogTitle,
  MorphingDialogTrigger,
} from "@/components/motion-primitives/morphing-dialog";
import { SlidingNumber } from "@/components/motion-primitives/sliding-number";
import { Spotlight } from "@/components/motion-primitives/spotlight";
import { TextEffect } from "@/components/motion-primitives/text-effect";
import { TextScramble } from "@/components/motion-primitives/text-scramble";
import { TextShimmer } from "@/components/motion-primitives/text-shimmer";
import { Tilt } from "@/components/motion-primitives/tilt";
import EmptyState from "@/components/kokonutui/empty-state";
import HoldButton from "@/components/kokonutui/hold-button";
import InlineAlert from "@/components/kokonutui/inline-alert";
import LiquidGauge from "@/components/kokonutui/liquid-gauge";
import MetricCard from "@/components/kokonutui/metric-card";
import NotificationStack from "@/components/kokonutui/notification-stack";
import SlideToConfirm from "@/components/kokonutui/slide-to-confirm";
import { StatusIsland, type IslandTask } from "@/components/kokonutui/status-island";
import UptimeCard from "@/components/kokonutui/uptime-card";
import { ContinuousTabs } from "@/components/watermelon/continuous-tabs";
import { LabeledProgressIndicator } from "@/components/watermelon/labeled-progress-indicator";
import { OnboardingChecklist } from "@/components/watermelon/onboarding-checklist";

/* ── data ─────────────────────────────────────────────────────────── */

const WEEKS = [22, 27, 31, 29, 38, 44, 49, 57];
const RIVAL = [41, 43, 40, 44, 42, 39, 41, 38];
const TREND = WEEKS.map((you, index) => ({
  date: new Date(2026, 8, 21 + index * 7),
  you,
  rival: RIVAL[index],
}));

const ENGINES = [
  { engine: "ChatGPT", named: 64, missed: 36 },
  { engine: "Gemini", named: 48, missed: 52 },
  { engine: "Claude", named: 71, missed: 29 },
  { engine: "Perplexity", named: 39, missed: 61 },
  { engine: "Copilot", named: 27, missed: 73 },
];

const RINGS = [
  { label: "ChatGPT", value: 64, maxValue: 100, color: "var(--chart-you)" },
  { label: "Claude", value: 71, maxValue: 100, color: "color-mix(in oklab, var(--chart-you) 70%, var(--background))" },
  { label: "Gemini", value: 48, maxValue: 100, color: "color-mix(in oklab, var(--chart-you) 45%, var(--background))" },
  { label: "Perplexity", value: 39, maxValue: 100, color: "color-mix(in oklab, var(--chart-you) 28%, var(--background))" },
];

const SPARK = Array.from({ length: 24 }, (_, index) => ({
  day: index + 1,
  value: Math.round(30 + index * 1.1 + Math.sin(index * 0.7) * 6),
}));

/* ── Bklit charts ─────────────────────────────────────────────────── */

export function BklitTrend({ run }: { run: number }) {
  return (
    <AreaChart key={run} data={TREND} aspectRatio="16 / 7" animationDuration={1300}>
      <Grid horizontal />
      <Area dataKey="rival" curve={curveNatural} stroke="var(--chart-rival-1)" fill="var(--chart-rival-1)" fillOpacity={0.12} strokeWidth={2} />
      <Area dataKey="you" curve={curveNatural} stroke="var(--chart-you)" fill="var(--chart-you)" fillOpacity={0.3} strokeWidth={2.5} />
      <XAxis />
      <ChartTooltip />
    </AreaChart>
  );
}

export function BklitLines({ run }: { run: number }) {
  return (
    <LineChart key={run} data={TREND} aspectRatio="16 / 7" animationDuration={1300}>
      <Grid horizontal />
      <Line dataKey="rival" curve={curveNatural} stroke="var(--chart-rival-1)" strokeWidth={2} />
      <Line dataKey="you" curve={curveNatural} stroke="var(--chart-you)" strokeWidth={2.5} />
      <XAxis />
      <ChartTooltip />
    </LineChart>
  );
}

export function BklitBars({ run }: { run: number }) {
  return (
    <BarChart key={run} data={ENGINES} xDataKey="engine" aspectRatio="16 / 7">
      <Grid horizontal />
      <Bar dataKey="named" fill="var(--chart-you)" lineCap="round" />
      <Bar dataKey="missed" fill="var(--chart-rival-2)" lineCap="round" />
      <BarXAxis />
      <ChartTooltip />
    </BarChart>
  );
}

/** True after mount. Ring and Gauge read their size and use NumberFlow, a
 *  custom element, so they are drawn on the client only. */
function useMounted() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

export function BklitRings({ run }: { run: number }) {
  const mounted = useMounted();
  if (!mounted) return <div className="h-60" aria-hidden />;
  return (
    <div key={run} className="grid items-center gap-6 sm:grid-cols-2">
      <div className="mx-auto w-full max-w-[240px]">
        <RingChart data={RINGS} size={240} strokeWidth={13}>
          {RINGS.map((item, index) => (
            <Ring index={index} key={item.label} />
          ))}
          <RingCenter defaultLabel="Named" />
        </RingChart>
      </div>
      <div className="mx-auto w-full max-w-[260px]">
        <Gauge value={57} centerValue={57} totalNotches={44} defaultLabel="AI visibility" suffix="%" useGradient={false} activeFill="var(--chart-you)" inactiveFill="var(--chart-scale-01)" />
      </div>
    </div>
  );
}

export function BklitSparklines({ run }: { run: number }) {
  return (
    <div key={run} className="grid gap-4 sm:grid-cols-3">
      {[
        { label: "Line", node: <LineSparkline data={SPARK} dataKey="value" height={56} color="var(--chart-you)" endDot /> },
        { label: "Area", node: <AreaSparkline data={SPARK} dataKey="value" height={56} color="var(--chart-you)" /> },
        { label: "Bars", node: <BarSparkline data={SPARK} dataKey="value" height={56} color="var(--chart-you)" /> },
      ].map((item) => (
        <div key={item.label} className="rounded-lg border border-border bg-background p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">{item.label} · hover to read</div>
          {item.node}
        </div>
      ))}
    </div>
  );
}

/* ── Motion Primitives ────────────────────────────────────────────── */

export function TextDemo({ run }: { run: number }) {
  const [count, setCount] = React.useState(1204);
  React.useEffect(() => {
    if (run === 0) return;
    setCount((value) => value + 137);
  }, [run]);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="space-y-3">
        <TextEffect key={`a${run}`} per="word" preset="fade-in-blur" as="h4" className="text-xl font-semibold tracking-tight">
          The answer names two brands. Is one of them yours?
        </TextEffect>
        <TextEffect key={`b${run}`} per="char" preset="slide" delay={0.5} className="text-sm text-muted-foreground">
          Words blur in one by one, then letters slide.
        </TextEffect>
      </div>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-muted-foreground">Shimmer, for work in progress</span>
          <TextShimmer className="font-medium" duration={1.4}>
            Asking Gemini…
          </TextShimmer>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-muted-foreground">Scramble, for a reveal</span>
          <TextScramble key={run} className="font-mono text-xs font-medium uppercase tracking-wider" duration={1.1}>
            Scan complete
          </TextScramble>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
          <span className="text-muted-foreground">Sliding number</span>
          <span className="inline-flex text-lg font-semibold tabular-nums">
            <SlidingNumber value={count} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function EffectsDemo() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="relative overflow-hidden rounded-xl border border-border bg-background p-4">
        <BorderTrail size={90} style={{ boxShadow: "0 0 30px 10px color-mix(in oklab, var(--primary) 40%, transparent)" }} className="bg-primary" />
        <div className="text-sm font-medium">Border trail</div>
        <p className="mt-1 text-xs text-muted-foreground">A light circles the card while a scan runs.</p>
      </div>
      <div className="relative overflow-hidden rounded-xl border border-border bg-background p-4">
        <Spotlight className="bg-foreground/25 blur-2xl" size={180} />
        <div className="relative text-sm font-medium">Spotlight</div>
        <p className="relative mt-1 text-xs text-muted-foreground">Move the pointer over this card.</p>
      </div>
      <Tilt rotationFactor={10} isRevese className="rounded-xl">
        <div className="h-full rounded-xl border border-border bg-foreground p-4 text-background">
          <div className="text-sm font-semibold">Tilt</div>
          <p className="mt-1 text-xs opacity-70">The card leans toward the pointer.</p>
        </div>
      </Tilt>
      <div className="flex items-center justify-center rounded-xl border border-border bg-background p-4">
        <Magnetic intensity={0.3} range={120}>
          <span className="relative inline-flex">
            <GlowEffect colors={["#ffffff", "#9a9aa3", "#ffffff", "#5c5c66"]} mode="rotate" blur="soft" duration={4} scale={1.08} className="rounded-full opacity-60" />
            <Button className="relative">
              <Sparkles /> Magnetic glow
            </Button>
          </span>
        </Magnetic>
      </div>
    </div>
  );
}

export function MorphingDialogDemo() {
  return (
    <MorphingDialog transition={{ type: "spring", bounce: 0.12, duration: 0.45 }}>
      <MorphingDialogTrigger className="flex w-full max-w-sm items-center gap-3 rounded-xl border border-border bg-background p-3 text-left">
        <span data-slot="dialog-emblem" className="shrink-0">
          <Radar />
        </span>
        <span className="min-w-0">
          <MorphingDialogTitle className="block text-sm font-semibold">Scan · 12 Nov</MorphingDialogTitle>
          <MorphingDialogSubtitle className="block text-xs text-muted-foreground">120 questions · 5 engines · click to open</MorphingDialogSubtitle>
        </span>
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="pointer-events-auto relative w-[min(92vw,30rem)] overflow-hidden rounded-2xl border border-border bg-popover p-5 shadow-2xl">
          <div className="flex items-center gap-3">
            <span data-slot="dialog-emblem" className="shrink-0">
              <Radar />
            </span>
            <span>
              <MorphingDialogTitle className="block text-base font-semibold">Scan · 12 Nov</MorphingDialogTitle>
              <MorphingDialogSubtitle className="block text-xs text-muted-foreground">120 questions · 5 engines</MorphingDialogSubtitle>
            </span>
          </div>
          <MorphingDialogDescription
            disableLayoutAnimation
            variants={{ initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 12 } }}
          >
            <p className="mt-4 text-sm text-muted-foreground">
              Your brand was named in 57% of answers, up 8 points. Claude named you most often; Copilot least.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                ["Named", "68"],
                ["Missed", "52"],
                ["Cost", "$4.20"],
              ].map(([term, value]) => (
                <div key={term} className="rounded-lg border border-border bg-background px-2 py-2">
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{term}</div>
                  <div className="text-lg font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>
          </MorphingDialogDescription>
          <MorphingDialogClose className="absolute right-3 top-3 grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground">
            <X className="size-4" />
          </MorphingDialogClose>
        </MorphingDialogContent>
      </MorphingDialogContainer>
    </MorphingDialog>
  );
}

/* ── Kokonut UI ───────────────────────────────────────────────────── */

export function ConfirmDemo() {
  return (
    <div className="grid items-center gap-5 sm:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Hold to confirm: for deleting</div>
        <HoldButton holdDuration={1400} holdingLabel="Keep holding" completeLabel="Deleted">
          Hold to delete scan
        </HoldButton>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Slide to confirm: for spending</div>
        <SlideToConfirm
          label="Slide to run scan · $4.20"
          confirmingLabel="Starting scan"
          doneLabel="Scan started"
          onConfirm={() => new Promise((resolve) => window.setTimeout(resolve, 1200))}
          resetAfter={2200}
        />
      </div>
    </div>
  );
}

export function StatusIslandDemo({ run }: { run: number }) {
  const [tasks, setTasks] = React.useState<IslandTask[]>([]);
  React.useEffect(() => {
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    setTasks([{ id: "scan", label: "Running scan", detail: "ChatGPT", status: "running", progress: 0.1 }]);
    at(900, () => setTasks([{ id: "scan", label: "Running scan", detail: "Gemini", status: "running", progress: 0.4 }]));
    at(1800, () =>
      setTasks([
        { id: "scan", label: "Running scan", detail: "Claude", status: "running", progress: 0.7 },
        { id: "export", label: "Exporting report", status: "running" },
      ]),
    );
    at(2900, () =>
      setTasks([
        { id: "scan", label: "Scan finished", detail: "120 questions", status: "done" },
        { id: "export", label: "Report exported", status: "done" },
      ]),
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [run]);
  return (
    <div className="flex min-h-28 items-start justify-center pt-2">
      <StatusIsland tasks={tasks} onDismiss={(id) => setTasks((current) => current.filter((task) => task.id !== id))} />
    </div>
  );
}

export function NotificationsDemo({ run }: { run: number }) {
  return (
    <div className="mx-auto w-full max-w-sm">
      <NotificationStack
        key={run}
        notifications={[
          { id: "1", app: "Perceev", title: "Scan finished", body: "You were named in 57% of answers, up 8 points.", time: "now", icon: <Radar className="size-4" /> },
          { id: "2", app: "Perceev", title: "New rival spotted", body: "Brightwave appeared in 14 answers this week.", time: "2m", icon: <Eye className="size-4" /> },
          { id: "3", app: "Perceev", title: "Draft ready to review", body: "“Clinical outcomes tracking, compared” is waiting.", time: "1h", icon: <FileText className="size-4" /> },
          { id: "4", app: "Perceev", title: "Search Console connected", body: "Imported 2,140 queries for example.com.", time: "3h", icon: <Search className="size-4" /> },
        ]}
      />
    </div>
  );
}

export function KokonutCards() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <MetricCard label="Answers naming you" format="number" />
      <div className="grid gap-4">
        <UptimeCard title="Answer engines" />
        <LiquidGauge defaultValue={64} label="Scan budget" total={30} unit="$" warnAt={85} />
      </div>
    </div>
  );
}

export function AlertAndEmptyDemo() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <InlineAlert
        target="example.com"
        checks={[
          { name: "robots.txt allows GPTBot", ok: true },
          { name: "robots.txt allows ClaudeBot", detail: "Disallow: / for ClaudeBot", ok: false },
          { name: "llms.txt present", detail: "404 at /llms.txt", ok: false },
        ]}
      />
      <EmptyState title="No questions yet" description="Add the questions your buyers ask and Perceev will track every answer." />
    </div>
  );
}

/* ── Watermelon UI ────────────────────────────────────────────────── */

export function WatermelonDemo() {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Continuous tabs</div>
          <ContinuousTabs
            tabs={[
              { id: "overview", label: "Overview" },
              { id: "engines", label: "Engines" },
              { id: "questions", label: "Questions" },
              { id: "rivals", label: "Rivals" },
            ]}
            defaultActiveId="overview"
          />
        </div>
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Labelled progress</div>
          <LabeledProgressIndicator labels={["Asking ChatGPT", "Asking Gemini", "Asking Claude", "Scoring answers"]} progress="62%" intervalMs={1600} />
        </div>
      </div>
      <OnboardingChecklist
        title="Get set up"
        steps={[
          { id: 1, title: "Add your website", isCompleted: true },
          { id: 2, title: "Pick your buyer questions", isCompleted: true },
          { id: 3, title: "Run your first scan", isCompleted: false },
          { id: 4, title: "Connect Search Console", isCompleted: false },
        ]}
      />
    </div>
  );
}

/* ── anime.js ─────────────────────────────────────────────────────── */

export function ScanGridDemo({ run }: { run: number }) {
  return (
    <div className="relative grid h-44 place-items-center overflow-hidden rounded-lg border border-border bg-background px-6">
      <DotGridPulse key={run} columns={21} rows={7} className="w-full max-w-xl" />
      <div className="absolute rounded-full border border-border bg-card/90 px-3 py-1 text-xs font-medium backdrop-blur">
        <TextShimmer duration={1.6}>Scanning 5 answer engines</TextShimmer>
      </div>
    </div>
  );
}
