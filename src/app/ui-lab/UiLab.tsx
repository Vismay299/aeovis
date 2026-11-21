"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { LayoutGroup, motion } from "motion/react";
import {
  ArrowRight,
  ArrowUp,
  ChartColumn,
  ChevronDown,
  Copy,
  Eye,
  Globe,
  LayoutDashboard,
  MessageSquareText,
  Pencil,
  Radar,
  RotateCcw,
  Search,
  Share2,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { PageLoader, PerceevLoader, PerceevLogo, PerceevMark } from "@/components/app/brand/PerceevLogo";
import { StatTile, type StatTileVariant } from "@/components/app/StatTile";
import { RollingNumber } from "@/components/app/motion/RollingNumber";
import { SidebarActivePill } from "@/components/app/motion/SidebarActivePill";
import { VerifyCheck, type VerifyState } from "@/components/app/motion/VerifyCheck";
import { SectionNav } from "@/components/app/navigation/SectionNav";
import { CopyButton } from "@/components/app/CopyButton";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner, SuccessCheck } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/utils";
import {
  AlertAndEmptyDemo,
  BklitBars,
  BklitLines,
  BklitRings,
  BklitSparklines,
  BklitTrend,
  ConfirmDemo,
  EffectsDemo,
  KokonutCards,
  MorphingDialogDemo,
  NotificationsDemo,
  ScanGridDemo,
  StatusIslandDemo,
  TextDemo,
  WatermelonDemo,
} from "./LibraryDemos";

/* ── data ─────────────────────────────────────────────────────────── */

const KPI_SETS = [
  { visibility: 38, questions: 1204, answers: 457, spend: "12.40" },
  { visibility: 57, questions: 1310, answers: 746, spend: "18.95" },
  { visibility: 44, questions: 980, answers: 431, spend: "9.08" },
];

const SERIES = [
  [22, 27, 31, 29, 38, 44, 49, 57],
  [900, 940, 1010, 990, 1100, 1180, 1204, 1310],
  [210, 260, 250, 320, 380, 410, 457, 746],
  [14, 12, 15, 11, 13, 10, 12, 9],
];

const TILE_VARIANTS: readonly { id: StatTileVariant; label: string }[] = [
  { id: "spark", label: "Spark" },
  { id: "rail", label: "Rail" },
  { id: "ring", label: "Ring" },
  { id: "inverse", label: "Inverse" },
  { id: "plain", label: "Plain" },
];

const SCROLL_STYLES = [
  { id: "reveal-on-scroll", label: "Rise" },
  { id: "reveal-slide", label: "Slide" },
  { id: "reveal-focus", label: "Focus" },
  { id: "reveal-flip", label: "Flip" },
] as const;

/** The stat tile design picked in the lab, shared by every demo that shows tiles. */
const TileVariant = React.createContext<StatTileVariant>("spark");

const NAV = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, group: null },
  { id: "questions", label: "Questions", icon: MessageSquareText, group: "AI Visibility" },
  { id: "scans", label: "Scans", icon: Radar, group: "AI Visibility" },
  { id: "keywords", label: "Keywords", icon: Search, group: "Research" },
  { id: "domain", label: "Domain", icon: Globe, group: "Research" },
  { id: "rank", label: "Rank Tracking", icon: TrendingUp, group: "My Site" },
  { id: "analytics", label: "Analytics", icon: ChartColumn, group: "My Site" },
] as const;

const SECTIONS = [
  { id: "brand", label: "Brand" },
  { id: "entrances", label: "Entrances" },
  { id: "controls", label: "Controls" },
  { id: "navigation", label: "Navigation" },
  { id: "scrolling", label: "Scrolling" },
  { id: "data", label: "Charts" },
  { id: "library", label: "Library" },
] as const;

/* ── helpers ──────────────────────────────────────────────────────── */

/** Runs timed steps each time `run` changes (not on first mount). */
function useSequence(run: number, steps: ReadonlyArray<readonly [number, () => void]>) {
  const latest = React.useRef(steps);
  latest.current = steps;
  React.useEffect(() => {
    if (run === 0) return;
    const ids = latest.current.map(([delay], index) =>
      window.setTimeout(() => latest.current[index]?.[1](), delay),
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [run]);
}

/** A row of choices with one highlight that slides to the picked one. */
function Segmented<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const layoutId = React.useId();
  return (
    <div role="tablist" aria-label={label} className="inline-flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className="relative h-7 rounded-full px-3 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-selected:text-primary-foreground"
        >
          {value === item.id ? (
            <motion.span
              layoutId={layoutId}
              transition={{ type: "spring", bounce: 0.2, visualDuration: 0.32 }}
              className="absolute inset-0 rounded-full bg-primary"
            />
          ) : null}
          <span className="relative">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function ReplayButton({ onClick, label = "Replay" }: { onClick: () => void; label?: string }) {
  const [turn, setTurn] = React.useState(0);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        setTurn((value) => value + 1);
        onClick();
      }}
    >
      <RotateCcw key={turn} className={turn ? "animate-replay-spin" : undefined} />
      {label}
    </Button>
  );
}

/** One animation on show: what it is, a Replay button, and the thing itself. */
function Demo({
  title,
  hint,
  className,
  replayLabel,
  children,
}: {
  title: string;
  hint: string;
  className?: string;
  replayLabel?: string;
  children: (run: number) => React.ReactNode;
}) {
  const [run, setRun] = React.useState(0);
  return (
    <article className={cn("reveal-on-scroll flex flex-col rounded-xl border border-border bg-card", className)}>
      <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <ReplayButton label={replayLabel} onClick={() => setRun((value) => value + 1)} />
      </header>
      <div className="flex-1 p-4">{children(run)}</div>
    </article>
  );
}

function SectionTitle({ id, title, hint }: { id: string; title: string; hint: string }) {
  return (
    <div id={id} data-section className="scroll-mt-32 pt-2">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  );
}

/* ── demos ────────────────────────────────────────────────────────── */

function PageEntranceDemo({ run }: { run: number }) {
  const variant = React.useContext(TileVariant);
  const [loaded, setLoaded] = React.useState(true);
  useSequence(run, [
    [0, () => setLoaded(false)],
    [1100, () => setLoaded(true)],
  ]);
  if (!loaded) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-7/12" />
      </div>
    );
  }
  return (
    <div key={run} className="animate-page-in space-y-3">
      <h4 className="text-base font-semibold">Overview</h4>
      <div className="stagger-children grid grid-cols-2 gap-3">
        <StatTile variant={variant} label="Visibility" icon={Eye} value="57" suffix="%" percent={57} series={SERIES[0]} delta={{ text: "+8 pts", direction: "up" }} sub="since last scan" />
        <StatTile variant={variant} label="Questions" icon={MessageSquareText} value="1,310" percent={82} series={SERIES[1]} delta={{ text: "+106", direction: "up" }} sub="tracked" />
      </div>
      <div className="stagger-children space-y-1.5">
        <p className="text-sm">Perceev asked 1,310 buyer questions across five answer engines.</p>
        <p className="text-sm text-muted-foreground">Your brand was named in 746 answers.</p>
        <Badge variant="secondary">Updated just now</Badge>
      </div>
    </div>
  );
}

function PageLoaderDemo({ run }: { run: number }) {
  const [loading, setLoading] = React.useState(false);
  useSequence(run, [
    [0, () => setLoading(true)],
    [2600, () => setLoading(false)],
  ]);
  return (
    <div className="h-56 overflow-hidden rounded-lg border border-border bg-background">
      {loading ? (
        <PageLoader className="min-h-0" label="Signing you in" />
      ) : (
        <div key={run} className="animate-page-in flex h-full flex-col items-center justify-center gap-2 text-center">
          <PerceevMark className="h-9" />
          <p className="text-sm font-medium">You are signed in</p>
          <p className="text-xs text-muted-foreground">Press Replay to see the loader a long sign-in or page load shows.</p>
        </div>
      )}
    </div>
  );
}

function StatTilesDemo({
  run,
  variant,
  onVariant,
}: {
  run: number;
  variant: StatTileVariant;
  onVariant: (value: StatTileVariant) => void;
}) {
  const [kpi, setKpi] = React.useState(0);
  const data = KPI_SETS[kpi];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Stat tile design" items={TILE_VARIANTS} value={variant} onChange={onVariant} />
        <Button variant="outline" size="sm" onClick={() => setKpi((value) => (value + 1) % KPI_SETS.length)}>
          Change the values
        </Button>
      </div>
      <div key={`${run}-${variant}`} className="stagger-children grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile variant={variant} label="AI visibility" icon={Eye} value={`${data.visibility}`} suffix="%" percent={data.visibility} series={SERIES[0]} delta={{ text: "+8 pts", direction: "up" }} sub="since 12 Nov" />
        <StatTile variant={variant} label="Questions tracked" icon={MessageSquareText} value={data.questions.toLocaleString("en-US")} percent={82} series={SERIES[1]} delta={{ text: "+106", direction: "up" }} sub="in your latest scan" />
        <StatTile variant={variant} label="Answers naming you" icon={Sparkles} value={data.answers.toLocaleString("en-US")} percent={Math.round((data.answers / data.questions) * 100)} series={SERIES[2]} delta={{ text: "+289", direction: "up" }} sub={`of ${data.questions.toLocaleString("en-US")} questions`} />
        <StatTile variant={variant} label="Spend this month" icon={Search} value={`$${data.spend}`} percent={41} series={SERIES[3]} delta={{ text: "−$3.10", direction: "down" }} sub="of $30 budget" />
      </div>
    </div>
  );
}

function ButtonsDemo({ run }: { run: number }) {
  const [state, setState] = React.useState<"idle" | "pending" | "success">("idle");
  const save = React.useCallback(() => setState("pending"), []);
  React.useEffect(() => {
    if (state === "idle") return;
    const id = window.setTimeout(() => setState(state === "pending" ? "success" : "idle"), state === "pending" ? 1400 : 1700);
    return () => window.clearTimeout(id);
  }, [state]);
  useSequence(run, [[0, save]]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={save} pending={state === "pending"} success={state === "success"}>
          {state === "pending" ? "Saving" : state === "success" ? "Saved" : "Save changes"}
        </Button>
        <Button className="group/cta">
          Run a scan
          <ArrowRight className="transition-transform duration-300 ease-(--ease-spring) group-hover/cta:translate-x-1" />
        </Button>
        <Button variant="outline">Outline</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Delete</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg">Large</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
        <CopyButton value="perceev.com" successMessage="Copied" size="sm" />
      </div>
      <div className="flex items-center gap-6 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Spinner className="size-5" /> Spinner
        </span>
        <span className="flex items-center gap-2">
          <SuccessCheck key={run} className="size-6 text-success" /> Success tick
        </span>
        <span className="flex items-center gap-2 text-foreground">
          <PerceevLoader className="h-6" /> Brand loader
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Press and hold any button: it shrinks, ink spreads from your pointer, and it springs back on release.
      </p>
    </div>
  );
}

function ChoicesDemo({ run }: { run: number }) {
  const [boxes, setBoxes] = React.useState([false, true, false]);
  const [radio, setRadio] = React.useState("weekly");
  const [switches, setSwitches] = React.useState([true, false]);
  const setBox = (index: number, value: boolean) => setBoxes((current) => current.map((v, i) => (i === index ? value : v)));
  const setSwitch = (index: number, value: boolean) => setSwitches((current) => current.map((v, i) => (i === index ? value : v)));
  useSequence(run, [
    [0, () => { setBoxes([false, false, false]); setSwitches([false, false]); setRadio("daily"); }],
    [450, () => setBox(0, true)],
    [750, () => setBox(1, true)],
    [1050, () => setBox(2, true)],
    [1350, () => setRadio("weekly")],
    [1900, () => setRadio("monthly")],
    [2300, () => setSwitch(0, true)],
    [2650, () => setSwitch(1, true)],
  ]);
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground">Checkbox</div>
        <div className="flex items-center gap-4">
          <Checkbox className="size-9 rounded-lg" checked={boxes[0]} onCheckedChange={(v) => setBox(0, v === true)} aria-label="Large checkbox" />
          <Checkbox className="size-6 rounded-md" checked={boxes[1]} onCheckedChange={(v) => setBox(1, v === true)} aria-label="Medium checkbox" />
          <Checkbox checked={boxes[2]} onCheckedChange={(v) => setBox(2, v === true)} aria-label="Standard checkbox" />
        </div>
        <Label className="flex items-center gap-2">
          <Checkbox checked={boxes[2]} onCheckedChange={(v) => setBox(2, v === true)} />
          Email me the weekly report
        </Label>
        <Label className="flex items-center gap-2">
          <Checkbox indeterminate />
          Some engines selected
        </Label>
      </div>
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground">Radio</div>
        <RadioGroup value={radio} onValueChange={(value) => setRadio(String(value))} className="flex w-auto items-center gap-4">
          <RadioGroupItem value="daily" className="size-9" aria-label="Daily, large" />
          <RadioGroupItem value="weekly" className="size-6" aria-label="Weekly, medium" />
          <RadioGroupItem value="monthly" aria-label="Monthly, standard" />
        </RadioGroup>
        <RadioGroup value={radio} onValueChange={(value) => setRadio(String(value))}>
          {["daily", "weekly", "monthly"].map((value) => (
            <Label key={value} className="flex items-center gap-2 capitalize">
              <RadioGroupItem value={value} />
              {value} scans
            </Label>
          ))}
        </RadioGroup>
      </div>
      <div className="space-y-3">
        <div className="text-xs font-medium text-muted-foreground">Switch</div>
        <Label className="flex items-center justify-between gap-2">
          Track competitors <Switch checked={switches[0]} onCheckedChange={(v) => setSwitch(0, v)} />
        </Label>
        <Label className="flex items-center justify-between gap-2">
          Notify on drops <Switch checked={switches[1]} onCheckedChange={(v) => setSwitch(1, v)} />
        </Label>
        <Label className="flex items-center justify-between gap-2">
          Compact rows <Switch size="sm" checked={switches[1]} onCheckedChange={(v) => setSwitch(1, v)} />
        </Label>
      </div>
    </div>
  );
}

function VerifyDemo({ run }: { run: number }) {
  const [state, setState] = React.useState<VerifyState>("idle");
  const verify = React.useCallback(() => setState("checking"), []);
  React.useEffect(() => {
    if (state !== "checking") return;
    const id = window.setTimeout(() => setState("verified"), 1500);
    return () => window.clearTimeout(id);
  }, [state]);
  useSequence(run, [
    [0, () => setState("idle")],
    [500, verify],
  ]);
  return (
    <div className="flex flex-col items-start gap-3">
      <VerifyCheck state={state} onVerify={verify} />
      <p className="text-xs text-muted-foreground">
        Click it: the box rounds into a spinner while it checks, then fills, bursts and draws its tick.
      </p>
    </div>
  );
}

function TabsDemo({ run }: { run: number }) {
  const first = ["overview", "engines", "questions", "rivals"];
  const second = ["visibility", "mentions", "citations"];
  const [a, setA] = React.useState(first[0]);
  const [b, setB] = React.useState(second[0]);
  useSequence(run, [
    [0, () => { setA(first[0]); setB(second[0]); }],
    [450, () => setA(first[2])],
    [1050, () => setA(first[3])],
    [1650, () => setA(first[1])],
    [700, () => setB(second[2])],
    [1400, () => setB(second[1])],
  ]);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Tabs value={a} onValueChange={(value) => setA(String(value))}>
        <TabsList>
          {first.map((value) => (
            <TabsTrigger key={value} value={value} className="capitalize">
              {value}
            </TabsTrigger>
          ))}
        </TabsList>
        {first.map((value) => (
          <TabsContent key={value} value={value} className="rounded-lg border border-border bg-background p-4 capitalize">
            {value} panel
          </TabsContent>
        ))}
      </Tabs>
      <Tabs value={b} onValueChange={(value) => setB(String(value))}>
        <TabsList variant="line">
          {second.map((value) => (
            <TabsTrigger key={value} value={value} className="capitalize">
              {value}
            </TabsTrigger>
          ))}
        </TabsList>
        {second.map((value) => (
          <TabsContent key={value} value={value} className="rounded-lg border border-border bg-background p-4 capitalize">
            {value} panel
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function OverlaysDemo({ run }: { run: number }) {
  const [dialog, setDialog] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  useSequence(run, [
    [0, () => setMenu(true)],
    [1300, () => setMenu(false)],
    [1600, () => setDialog(true)],
    [3400, () => setDialog(false)],
  ]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog open={dialog} onOpenChange={setDialog}>
        <Button variant="outline" onClick={() => setDialog(true)}>
          Open dialog
        </Button>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <span data-slot="dialog-emblem">
              <Radar />
            </span>
            <DialogTitle>Run a new scan?</DialogTitle>
            <DialogDescription>
              Perceev will ask your tracked buyer questions on every answer engine and record which brand each answer names.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border border-border bg-background/60 text-center">
            {[
              ["Questions", "120"],
              ["Engines", "5"],
              ["Est. cost", "$4.20"],
            ].map(([term, value]) => (
              <div key={term} className="px-3 py-2.5">
                <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{term}</dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <DialogClose render={<Button />}>Run scan</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger render={<Button variant="outline" />}>
          Menu <ChevronDown className={cn("transition-transform duration-300 ease-(--ease-spring)", menu && "rotate-180")} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Scan · 12 Nov</DropdownMenuLabel>
            <DropdownMenuItem>
              <Pencil /> Rename <DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Copy /> Duplicate <DropdownMenuShortcut>D</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Share2 /> Share report
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <Trash2 /> Delete <DropdownMenuShortcut>⌫</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Select
        defaultValue="chatgpt"
        items={[
          { value: "chatgpt", label: "ChatGPT" },
          { value: "gemini", label: "Gemini" },
          { value: "claude", label: "Claude" },
          { value: "perplexity", label: "Perplexity" },
        ]}
      >
        <SelectTrigger className="w-44" aria-label="Answer engine">
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value="chatgpt">ChatGPT</SelectItem>
          <SelectItem value="gemini">Gemini</SelectItem>
          <SelectItem value="claude">Claude</SelectItem>
          <SelectItem value="perplexity">Perplexity</SelectItem>
        </SelectContent>
      </Select>

      <Sheet>
        <SheetTrigger render={<Button variant="outline" />}>Side panel</SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Question details</SheetTitle>
            <SheetDescription>The panel slides in from the edge and the page dims behind it.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>

      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" />}>Hover for a tooltip</TooltipTrigger>
        <TooltipContent>Share of answers that name your brand</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ToastsDemo({ run }: { run: number }) {
  const success = () => toast.success("Scan queued", { description: "We will tell you when it finishes." });
  useSequence(run, [[0, success]]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" onClick={success}>
        Success
      </Button>
      <Button variant="outline" onClick={() => toast.error("Scan failed", { description: "Gemini did not answer. Nothing was charged." })}>
        Error
      </Button>
      <Button variant="outline" onClick={() => toast.info("New engine available", { description: "Copilot can now be added to your scans." })}>
        Info
      </Button>
      <Button variant="outline" onClick={() => toast.warning("Budget almost used", { description: "$27.40 of $30 spent this month." })}>
        Warning
      </Button>
      <Button
        variant="outline"
        onClick={() => toast("Question removed", { description: "It will not be asked in the next scan.", action: { label: "Undo", onClick: () => toast.success("Question restored") } })}
      >
        With an action
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          toast.promise(new Promise((resolve) => window.setTimeout(resolve, 2200)), {
            loading: "Running scan",
            success: "Scan finished",
            error: "Scan failed",
          })
        }
      >
        Loading, then done
      </Button>
    </div>
  );
}

function SidebarDemo({ run }: { run: number }) {
  const variant = React.useContext(TileVariant);
  const [active, setActive] = React.useState<string>("overview");
  useSequence(run, [
    [0, () => setActive("overview")],
    [500, () => setActive("scans")],
    [1100, () => setActive("domain")],
    [1700, () => setActive("analytics")],
    [2400, () => setActive("questions")],
  ]);
  const current = NAV.find((item) => item.id === active) ?? NAV[0];
  let lastGroup: string | null = null;
  return (
    <div className="flex h-[27rem] overflow-hidden rounded-lg border border-border">
      <LayoutGroup id="lab-sidebar">
        <div data-slot="sidebar" className="flex w-52 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
          <div className="px-4 pb-2 pt-4">
            <PerceevLogo size="sm" />
          </div>
          <nav aria-label="Demo navigation" className="flex-1 overflow-auto px-2 pb-2">
            <ul className="flex flex-col gap-0.5">
              {NAV.map((item) => {
                const heading = item.group !== lastGroup ? item.group : null;
                lastGroup = item.group;
                const isActive = item.id === active;
                return (
                  <React.Fragment key={item.id}>
                    {heading ? (
                      <li className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-foreground/60">
                        {heading}
                      </li>
                    ) : null}
                    <li className="relative">
                      {isActive ? <SidebarActivePill /> : null}
                      <button
                        type="button"
                        data-slot="sidebar-menu-button"
                        data-active={isActive ? "" : undefined}
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => setActive(item.id)}
                        className="relative flex w-full items-center gap-2 rounded-md p-2 text-left text-sm text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-active:font-medium data-active:text-sidebar-accent-foreground data-active:hover:bg-transparent [&_svg]:size-4 [&_svg]:shrink-0"
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </button>
                    </li>
                  </React.Fragment>
                );
              })}
            </ul>
          </nav>
        </div>
      </LayoutGroup>
      <div className="min-w-0 flex-1 overflow-hidden bg-background p-5">
        <div key={active} className="animate-page-in space-y-3">
          <div className="flex items-center gap-2">
            <current.icon className="size-5" />
            <h4 className="text-lg font-semibold">{current.label}</h4>
          </div>
          <div className="stagger-children grid grid-cols-2 gap-3">
            <StatTile variant={variant} label="This week" icon={current.icon} value={String(120 + current.label.length * 37)} percent={40 + current.label.length * 4} series={SERIES[1]} delta={{ text: `+${current.label.length + 3}%`, direction: "up" }} sub="vs last week" />
            <StatTile variant={variant} label="Named in" value={String(30 + current.label.length * 5)} suffix="%" percent={30 + current.label.length * 5} series={SERIES[0]} delta={{ text: "−2 pts", direction: "down" }} sub="of answers" />
            <div className="col-span-2 space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="h-2.5 w-10/12 rounded-full bg-foreground/10" />
              <div className="h-2.5 w-7/12 rounded-full bg-foreground/10" />
              <div className="h-2.5 w-9/12 rounded-full bg-foreground/10" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScrollDemo({ run }: { run: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [style, setStyle] = React.useState<(typeof SCROLL_STYLES)[number]["id"]>("reveal-on-scroll");
  useSequence(run, [
    [0, () => ref.current?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior })],
    [350, () => ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" })],
  ]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="How rows arrive"
          items={SCROLL_STYLES}
          value={style}
          onChange={(next) => {
            setStyle(next);
            ref.current?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
          }}
        />
        <span className="text-xs text-muted-foreground">
          {style === "reveal-on-scroll" && "Rows rise up into place."}
          {style === "reveal-slide" && "Rows slide in from alternate sides."}
          {style === "reveal-focus" && "Rows sharpen in the middle and soften at both ends."}
          {style === "reveal-flip" && "Rows tip up from flat, hinged at the top."}
        </span>
      </div>
      <div className="relative overflow-hidden rounded-lg border border-border">
        <div ref={ref} className="scroll-edge h-96 overflow-y-auto overflow-x-hidden bg-background [scroll-behavior:smooth]">
          <div className="sticky top-0 z-40 h-1 bg-foreground/10">
            <div className="scroll-progress h-full bg-primary" />
          </div>
          <div key={style} className="space-y-3 p-4">
            <p className="text-sm text-muted-foreground">Scroll this panel, or press Auto-scroll. The bar tracks your position and the top edge shades once you have moved.</p>
            {Array.from({ length: 14 }, (_, index) => (
              <div key={index} className={cn(style, "flex items-center gap-3 rounded-lg border border-border bg-card p-3")}>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/12 text-sm font-semibold text-primary tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="text-sm font-medium">Which analytics tools track clinical outcomes?</div>
                  <div className="h-2 w-8/12 rounded-full bg-foreground/10" />
                </div>
                <Badge variant="secondary">{index % 3 === 0 ? "Named" : "Missed"}</Badge>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DisclosureDemo({ run }: { run: number }) {
  const [open, setOpen] = React.useState(false);
  const [progress, setProgress] = React.useState(35);
  useSequence(run, [
    [0, () => { setOpen(false); setProgress(0); }],
    [400, () => setOpen(true)],
    [500, () => setProgress(45)],
    [1300, () => setProgress(80)],
    [2100, () => setProgress(100)],
  ]);
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="space-y-3">
        <Accordion>
          <AccordionItem value="a">
            <AccordionTrigger>What does visibility mean?</AccordionTrigger>
            <AccordionContent>The share of unbranded buyer questions whose answer names your brand.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="b">
            <AccordionTrigger>How often are scans run?</AccordionTrigger>
            <AccordionContent>On the schedule you choose: daily, weekly or monthly.</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
            Advanced options
            <ChevronDown className={cn("transition-transform duration-300 ease-(--ease-spring)", open && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="pt-3 text-sm text-muted-foreground">
              Choose the country and language each question is asked in, and how many times it is repeated.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="lab-site">Website</Label>
          <Input id="lab-site" placeholder="example.com" />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>Scan progress</span>
            <span className="tabular-nums text-muted-foreground">
              <RollingNumber>{`${progress}%`}</RollingNumber>
            </span>
          </div>
          <Progress value={progress} />
          <Button variant="outline" size="sm" onClick={() => setProgress((value) => (value >= 100 ? 10 : Math.min(100, value + 25)))}>
            Advance
          </Button>
        </div>
      </div>
    </div>
  );
}

function LoadingDemo({ run }: { run: number }) {
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    setLoaded(false);
    const id = window.setTimeout(() => setLoaded(true), 1800);
    return () => window.clearTimeout(id);
  }, [run]);
  return loaded ? (
    <div className="stagger-children space-y-2">
      <p className="text-sm">Perceev asked 1,204 buyer questions across five answer engines.</p>
      <p className="text-sm text-muted-foreground">Your brand was named in 457 answers.</p>
      <Badge variant="secondary">Updated just now</Badge>
    </div>
  ) : (
    <div className="space-y-2" aria-busy="true">
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-8/12" />
      <Skeleton className="h-5 w-28" />
    </div>
  );
}

function Swatch({ name, token, text }: { name: string; token: string; text: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex h-14 items-end p-2 text-xs font-medium" style={{ background: `var(${token})`, color: `var(${text})` }}>
        Aa
      </div>
      <div className="bg-card px-2 py-1.5 text-xs">
        <div className="font-medium">{name}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{token}</div>
      </div>
    </div>
  );
}

/* ── section nav: the pill follows the section in view ────────────── */

// The shared SectionNav (src/components/app/navigation/SectionNav.tsx). The
// lab scrolls the window, not #app-content, and sits in its own sticky
// header, so the nav itself is not sticky here.
function LabSectionNav() {
  return (
    <SectionNav
      sections={SECTIONS}
      scrollerId={null}
      className="static mx-0 bg-transparent px-0 backdrop-blur-none"
    />
  );
}

function BackToTop() {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 600);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <Button
      size="icon"
      aria-label="Back to top"
      tabIndex={shown ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={cn(
        "fixed bottom-6 right-6 z-30 rounded-full shadow-lg transition-[opacity,translate,scale] duration-300 ease-(--ease-spring)",
        shown ? "opacity-100" : "pointer-events-none translate-y-4 scale-75 opacity-0",
      )}
    >
      <ArrowUp />
    </Button>
  );
}

/* ── page ─────────────────────────────────────────────────────────── */

export default function UiLab() {
  const [tile, setTile] = React.useState<StatTileVariant>("spark");
  return (
    <TileVariant.Provider value={tile}>
    <TooltipProvider>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
            <Link href="/ui-lab" aria-label="Perceev UI lab">
              <PerceevLogo />
            </Link>
            <nav className="flex items-center gap-1">
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/" />}>
                Website
              </Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/login" />}>
                Sign in
              </Button>
            </nav>
          </div>
          <div className="mx-auto max-w-6xl px-4 md:px-6">
            <LabSectionNav />
          </div>
          {/* fills as the page scrolls */}
          <div className="absolute inset-x-0 bottom-0 h-0.5">
            <div className="scroll-progress h-full bg-primary" />
          </div>
        </header>

        <main className="mx-auto max-w-6xl animate-page-in space-y-6 px-4 py-8 pb-44 md:px-6">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">UI lab</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Every animation and component, one card each. Press Replay on a card to watch it again, or use the
              control yourself. The dock at the bottom tries variants of the Onyx and White base: Shades stay
              two-colour, Accent adds one colour that pops, and Shape changes how every component is built.
            </p>
          </div>

          <SectionTitle id="brand" title="Brand" hint="The logo and how the current scheme spends its colours." />
          <div className="grid gap-4 lg:grid-cols-2">
            <Demo title="Logo" hint="The two panels of the mark rise in, one after the other.">
              {(run) => (
                <div key={run} className="grid grid-cols-3 gap-3">
                  <div className="flex h-24 items-center justify-center rounded-lg border border-border bg-background">
                    <PerceevLogo size="lg" />
                  </div>
                  <div className="flex h-24 items-center justify-center rounded-lg bg-sidebar text-sidebar-foreground">
                    <PerceevLogo size="lg" />
                  </div>
                  <div className="flex h-24 items-center justify-center gap-6 rounded-lg bg-primary text-primary-foreground">
                    <PerceevMark className="h-11" />
                    <PerceevLoader className="h-11" />
                  </div>
                </div>
              )}
            </Demo>
            <Demo title="Page loader" hint="Shown when sign-in or a whole page takes a while. Hidden for the first 300ms so quick loads never flash it.">
              {(run) => <PageLoaderDemo run={run} />}
            </Demo>
            <Demo title="Colour roles" hint="Page, card, sidebar, text and action in the chosen scheme." className="lg:col-span-2">
              {(run) => (
                <div key={run} className="stagger-children grid grid-cols-3 gap-3 lg:grid-cols-6">
                  <Swatch name="Page" token="--background" text="--foreground" />
                  <Swatch name="Card" token="--card" text="--card-foreground" />
                  <Swatch name="Sidebar" token="--sidebar" text="--sidebar-foreground" />
                  <Swatch name="Text" token="--foreground" text="--background" />
                  <Swatch name="Action" token="--primary" text="--primary-foreground" />
                  <Swatch name="Muted" token="--muted" text="--muted-foreground" />
                </div>
              )}
            </Demo>
          </div>

          <SectionTitle id="entrances" title="Entrances" hint="What a page, a number and a block of content do when they arrive." />
          <div className="grid gap-4 lg:grid-cols-2">
            <Demo title="Page arriving" hint="Placeholders sweep, then the page rises in and its parts follow in order.">
              {(run) => <PageEntranceDemo run={run} />}
            </Demo>
            <Demo title="Stat tiles" hint="Five designs for a headline number. The pick here is used in the other demos too." className="lg:col-span-2 lg:order-first">
              {(run) => <StatTilesDemo run={run} variant={tile} onVariant={setTile} />}
            </Demo>
            <Demo title="Loading into content" hint="A shimmer while it loads, then the content steps in.">
              {(run) => <LoadingDemo run={run} />}
            </Demo>
            <Demo title="Verify" hint="A captcha-style check: box, spinner, burst, tick.">
              {(run) => <VerifyDemo run={run} />}
            </Demo>
          </div>

          <SectionTitle id="controls" title="Controls" hint="Everything you click, tick or flip." />
          <div className="grid gap-4">
            <Demo title="Buttons" hint="Press, ripple, lift on hover, spinner while busy, tick when done.">
              {(run) => <ButtonsDemo run={run} />}
            </Demo>
            <Demo title="Tick, radio and switch" hint="The fill grows from the centre, the tick draws, a ring bursts out, and everything lands with a bounce.">
              {(run) => <ChoicesDemo run={run} />}
            </Demo>
            <Demo title="Tabs" hint="One indicator slides between tabs and the panel steps in.">
              {(run) => <TabsDemo run={run} />}
            </Demo>
            <Demo title="Menus, dialogs and panels" hint="Switch Shape in the dock to rebuild these: Soft, Edge or Pill.">
              {(run) => <OverlaysDemo run={run} />}
            </Demo>
            <Demo title="Toasts" hint="A tinted icon chip, a drawn tick on success, and a line that runs out with the toast's time.">
              {(run) => <ToastsDemo run={run} />}
            </Demo>
            <Demo title="Disclosure, fields and progress" hint="Panels open to their measured height; the bar and its number move together.">
              {(run) => <DisclosureDemo run={run} />}
            </Demo>
          </div>

          <SectionTitle id="navigation" title="Navigation" hint="How the sidebar answers a click." />
          <Demo title="Sidebar" hint="The highlight slides to the row you pick, its icon pops, and the page on the right arrives. Hover a row: icon and label lean in.">
            {(run) => <SidebarDemo run={run} />}
          </Demo>

          <SectionTitle id="scrolling" title="Scrolling" hint="What moves as you scroll. This whole page does it too: cards rise in, the bar under the header fills, the section pill follows you." />
          <Demo title="Scrolling a list" hint="Four ways for rows to arrive. Pick one, then scroll." replayLabel="Auto-scroll">
            {(run) => <ScrollDemo run={run} />}
          </Demo>

          <SectionTitle id="data" title="Charts" hint="Built on the Bklit chart components: series draw in, a crosshair and tooltip follow the pointer, and the axis label slides with it." />
          <div className="grid gap-4 lg:grid-cols-2">
            <Demo title="Area trend" hint="AI visibility over eight weeks: you against your top rival.">
              {(run) => <BklitTrend run={run} />}
            </Demo>
            <Demo title="Line trend" hint="The same data as lines.">
              {(run) => <BklitLines run={run} />}
            </Demo>
            <Demo title="Bars" hint="Answers that named you and missed you, by engine.">
              {(run) => <BklitBars run={run} />}
            </Demo>
            <Demo title="Rings and gauge" hint="Share of answers per engine, and one headline score.">
              {(run) => <BklitRings run={run} />}
            </Demo>
            <Demo title="Sparklines" hint="Small inline charts for tables and stat tiles. The Spark stat tile uses the area one." className="lg:col-span-2">
              {(run) => <BklitSparklines run={run} />}
            </Demo>
          </div>

          <SectionTitle id="library" title="Library" hint="More options from the component libraries now installed in the project: Motion Primitives, Kokonut UI, Watermelon UI and anime.js." />
          <div className="grid gap-4">
            <Demo title="Text" hint="Motion Primitives: headline reveals, a shimmer for work in progress, a scramble, a sliding number.">
              {(run) => <TextDemo run={run} />}
            </Demo>
            <Demo title="Surface effects" hint="Motion Primitives: border trail, spotlight, tilt, magnetic glow. Move the pointer over each.">
              {() => <EffectsDemo />}
            </Demo>
            <div className="grid gap-4 lg:grid-cols-2">
              <Demo title="Scan in progress" hint="anime.js: a dot grid pulsing outward from its centre.">
                {(run) => <ScanGridDemo run={run} />}
              </Demo>
              <Demo title="Morphing dialog" hint="Motion Primitives: the row itself grows into the dialog and shrinks back.">
                {() => <MorphingDialogDemo />}
              </Demo>
              <Demo title="Confirming an action" hint="Kokonut UI: hold to delete, slide to spend.">
                {() => <ConfirmDemo />}
              </Demo>
              <Demo title="Background work" hint="Kokonut UI: a pill that reports running tasks and reshapes as they change.">
                {(run) => <StatusIslandDemo run={run} />}
              </Demo>
            </div>
            <Demo title="Notifications" hint="Kokonut UI: a stack that fans out on hover and swipes away.">
              {(run) => <NotificationsDemo run={run} />}
            </Demo>
            <Demo title="Data cards" hint="Kokonut UI: a metric card you can scrub, an uptime strip, a liquid usage gauge.">
              {() => <KokonutCards />}
            </Demo>
            <Demo title="Alerts and empty states" hint="Kokonut UI: an alert that lists failed checks and re-runs them, and an empty state that turns into the first item.">
              {() => <AlertAndEmptyDemo />}
            </Demo>
            <Demo title="Tabs, progress and checklist" hint="Watermelon UI (Base UI variants).">
              {() => <WatermelonDemo />}
            </Demo>
          </div>
        </main>
        <BackToTop />
      </div>
    </TooltipProvider>
    </TileVariant.Provider>
  );
}
