"use client";

/**
 * Shared workspace compositions. Re-skinned on shadcn base-nova primitives
 * for F04 Phase 5, preserving DOM and test contracts.
 */

import Link from "next/link";
import { RollingNumber } from "@/components/app/motion/RollingNumber";
import { ripple } from "@/components/app/motion/ripple";
import { StatTile } from "@/components/app/StatTile";
import { EmptyArt } from "@/components/app/motion/EmptyArt";
import { TabsGlider } from "@/components/app/motion/TabsGlider";
import { WordReveal } from "@/components/app/motion/WordReveal";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, Check, X, Loader2 } from "lucide-react";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export function PageHeader({ eyebrow, title, description, actions, backLink }) {
  const header = (
    <header className="app-page-header flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        {eyebrow ? <p className="app-eyebrow text-sm text-muted-foreground">{eyebrow}</p> : null}
        <h1 className="app-title text-2xl font-semibold tracking-tight"><WordReveal text={title} /></h1>
        {description ? <p className="app-subtitle text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="app-page-actions flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
  if (!backLink) return header;
  return (
    <div className="space-y-3">
      {backLink}
      {header}
    </div>
  );
}

const CARD_BASE_CLASSES =
  "group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-xl border border-border bg-card py-(--card-spacing) text-sm text-card-foreground shadow-sm [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=lg]:[--card-spacing:--spacing(5)] data-[size=sm]:rounded-lg data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl";

export function Card({ title, description, actions, footer, flush, className, children, ...rest }) {
  return (
    <section className={cx(CARD_BASE_CLASSES, "pv-card", flush && "pv-card--flush", className)} {...rest}>
      {title || actions ? (
        <div
          data-slot="card-header"
          className="group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl border-border px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] border-b pb-(--card-spacing) pv-card__header"
        >
          <div>
            {title ? <h2 data-slot="card-title" className="text-base leading-snug font-semibold group-data-[size=sm]/card:text-sm pv-card__title">{title}</h2> : null}
            {description ? <p data-slot="card-description" className="text-sm text-muted-foreground pv-card__desc">{description}</p> : null}
          </div>
          {actions ? <div data-slot="card-action" className="pv-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children !== undefined && children !== null ? (
        <div data-slot="card-content" className={cx("px-(--card-spacing) pv-card__body", flush && "!px-0")}>
          {children}
        </div>
      ) : null}
      {footer ? (
        <div data-slot="card-footer" className="px-(--card-spacing) pv-card__footer">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/**
 * A KPI tile. `value` null/undefined renders an em dash, never 0.
 *
 * The locked design is the Spark tile, so this facade renders a `StatTile`
 * and keeps the legacy `pv-card pv-stat` hooks on the outer element for the
 * existing CSS. `series` is a real recent history, oldest first — with fewer
 * than two points no sparkline is drawn, and it is never fabricated.
 */
export function Stat({ label, icon, value, suffix, sub, series, delta, className }) {
  const blank = value === null || value === undefined || value === "";
  return (
    <StatTile
      variant="spark"
      label={label}
      icon={icon}
      value={blank ? null : String(value)}
      suffix={suffix}
      sub={sub}
      series={series}
      delta={delta}
      className={cx("pv-card pv-stat", className)}
    />
  );
}

const BUTTON_BASE =
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap motion-control motion-press outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

const BUTTON_VARIANTS = {
  primary: "bg-primary text-primary-foreground motion-raise hover:bg-primary/90",
  secondary:
    "border-border bg-card shadow-xs hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:shadow-none dark:hover:bg-input/50",
  ghost:
    "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
  danger:
    "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
};

const BUTTON_SIZES = {
  md: "h-10 gap-1.5 px-4 [--button-gap:--spacing(1.5)]",
  sm: "h-7 gap-1 [--button-gap:--spacing(1)] rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
};

/**
 * Button. Pass `href` to render a Next <Link> styled as a button.
 * variant: primary | secondary | ghost | danger. size: md | sm.
 */
export function Button({
  variant = "primary",
  size = "md",
  href,
  icon: Icon,
  loading,
  block,
  disabled,
  type = "button",
  className,
  children,
  ...rest
}) {
  const variantClass = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary;
  const sizeClass = BUTTON_SIZES[size] || BUTTON_SIZES.md;
  const classes = cx(
    BUTTON_BASE,
    variantClass,
    sizeClass,
    "pv-btn",
    `pv-btn--${variant}`,
    size === "sm" && "pv-btn--sm",
    block && "pv-btn--block w-full",
    className,
  );
  const content = (
    <>
      {loading ? (
        <Loader2 className="size-4 animate-spin pv-spinner" aria-hidden="true" />
      ) : Icon ? (
        <Icon aria-hidden="true" className="size-4" />
      ) : null}
      {children}
    </>
  );
  const press = (event) => {
    ripple(event);
    rest.onPointerDown?.(event);
  };
  if (href) return <Link href={href} className={classes} {...rest} onPointerDown={press}>{content}</Link>;
  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading} onPointerDown={press}>
      {content}
    </button>
  );
}

const BADGE_BASE =
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!";

const BADGE_VARIANTS = {
  neutral: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
  brand: "bg-primary/10 text-primary [a]:hover:bg-primary/20",
  good: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
  crit: "border-destructive/30 bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
};

/** tone: neutral | brand | good | warn | crit. `live` pulses the dot. */
export function Badge({ tone = "neutral", dot, live, className, children, ...rest }) {
  const variantClass = BADGE_VARIANTS[tone] || BADGE_VARIANTS.neutral;
  return (
    <span
      className={cx(
        BADGE_BASE,
        variantClass,
        "pv-badge",
        tone !== "neutral" && `pv-badge--${tone}`,
        live && "pv-badge--live",
        className,
      )}
      {...rest}
    >
      {dot || live ? <i className="pv-badge__dot inline-block size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const BANNER_ICON = { info: Info, success: CheckCircle2, warn: TriangleAlert, error: AlertCircle };

const ALERT_BASE =
  "group/alert relative grid w-full gap-0.5 rounded-lg border border-border px-2.5 py-2 text-left text-sm has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4";

const ALERT_VARIANTS = {
  info: "border-info/30 bg-info/10 *:[svg]:text-info",
  success: "border-success/30 bg-success/10 *:[svg]:text-success",
  warn: "border-warning/40 bg-warning/15 *:[svg]:text-warning-foreground dark:*:[svg]:text-warning",
  error: "border-destructive/30 bg-destructive/10 *:data-[slot=alert-title]:text-destructive *:[svg]:text-destructive",
};

/** tone: info | success | warn | error. */
export function Banner({ tone = "info", title, children, action, onDismiss, className }) {
  const Icon = BANNER_ICON[tone] || Info;
  const variantClass = ALERT_VARIANTS[tone] || ALERT_VARIANTS.info;
  return (
    <div
      data-slot="alert"
      className={cx(ALERT_BASE, variantClass, "pv-banner", `pv-banner--${tone}`, className)}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" />
      <div className="pv-banner__body">
        {title ? (
          <div data-slot="alert-title" className="font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground pv-banner__title">
            {title}
          </div>
        ) : null}
        <div data-slot="alert-description" className="text-muted-foreground group-has-[>svg]/alert:col-start-2 [&_p~p]:mt-1">
          {children}
        </div>
      </div>
      {action ? <div data-slot="alert-action" className="pv-banner__action">{action}</div> : null}
      {onDismiss ? (
        <button type="button" className="pv-icon-btn absolute top-2 right-2.5" onClick={onDismiss} aria-label="Dismiss">
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

const EMPTY_DASHED =
  "group/empty flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border p-6 text-center text-balance";

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div data-slot="empty" className={cx(EMPTY_DASHED, "pv-empty")}>
      {Icon ? (
        <div className="mb-1 flex shrink-0 items-center justify-center pv-empty__icon">
          {/* T8: the locked drawing; the icon rides on its front card. */}
          <EmptyArt>
            <Icon aria-hidden="true" />
          </EmptyArt>
        </div>
      ) : null}
      {title ? <p className="font-semibold text-foreground pv-empty__title">{title}</p> : null}
      {children ? <p className="text-sm text-muted-foreground max-w-sm pv-empty__text">{children}</p> : null}
      {action ? <div className="mt-2 pv-empty__action">{action}</div> : null}
    </div>
  );
}

/**
 * Progress bar. `value` is 0–100 and draws a determinate fill.
 */
export function ProgressBar({ value, active = false, indeterminate = false, size = "md", tone, label = "Progress" }) {
  const known = typeof value === "number" && Number.isFinite(value);
  const pct = known ? Math.min(100, Math.max(0, value)) : null;
  const sizeClass = size === "sm" ? "h-1.5 pv-progress--sm" : size === "lg" ? "h-3 pv-progress--lg" : "h-2";
  const toneClass = tone ? `pv-progress--${tone}` : null;

  if (!known && !indeterminate) {
    return (
      <div
        className={cx(
          "relative flex w-full items-center overflow-x-hidden rounded-full bg-foreground/10 pv-progress pv-progress--unmeasured",
          sizeClass,
          toneClass,
        )}
        role="img"
        aria-label={`${label}: not measured`}
      />
    );
  }

  return (
    <div
      className={cx(
        "relative flex w-full items-center overflow-x-hidden rounded-full bg-foreground/10 pv-progress",
        sizeClass,
        toneClass,
        !known && "pv-progress--indeterminate",
        active && known && "is-active",
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(pct) : undefined}
      aria-valuetext={known ? `${Math.round(pct)}%` : "In progress"}
    >
      <span
        className="h-full bg-primary transition-all pv-progress__fill"
        style={known ? { transform: `scaleX(${pct / 100})` } : undefined}
      />
    </div>
  );
}

/**
 * Horizontal stage stepper. `steps` = [{ label, detail? }]; `current` is the
 * index of the running stage (steps before it are done). `current >= steps.length`
 * marks everything done. `failed` paints the current step red.
 */
export function StageSteps({ steps, current, failed = false }) {
  return (
    <ol className="pv-steps" style={{ "--pv-steps": steps.length }}>
      {steps.map((step, index) => {
        const done = index < current;
        const now = index === current;
        const state = now && failed ? "is-failed" : done ? "is-done" : now ? "is-current" : "";
        return (
          <li key={step.label} className={cx("pv-step", state)} aria-current={now ? "step" : undefined}>
            <span className="pv-step__bar" aria-hidden="true" />
            <span className="pv-step__head">
              <span className="pv-step__icon" aria-hidden="true">
                {now && failed ? <X /> : done ? <Check /> : null}
              </span>
              <span className="pv-step__label">{step.label}</span>
            </span>
            {step.detail ? <span className="pv-step__detail">{step.detail}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

const TABS_LIST_LINE =
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none gap-1 bg-transparent";

/** Segmented tabs. items = [{ value, label, count? }]. */
export function Tabs({ items, value, onChange, label = "Views" }) {
  return (
    <div className={cx(TABS_LIST_LINE, "relative pv-tabs")} role="tablist" aria-label={label} data-variant="line">
      {/* Continuous tabs: the highlight glides between tabs once measured. */}
      <TabsGlider activeKey={value} />
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={cx(
            "inline-flex items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-all outline-none rounded-md px-3 py-1 pv-tab",
            item.value === value ? "bg-muted text-foreground is-active font-semibold shadow-xs" : "hover:text-foreground",
          )}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined ? (
            <span className="text-xs text-muted-foreground pv-tab__count">{item.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 12, style, className }) {
  return (
    <span
      className={cx("block skeleton-shimmer rounded-md bg-foreground/10 pv-skeleton", className)}
      style={{ width, height, ...style }}
      aria-hidden="true"
    />
  );
}

/** A few skeleton rows for list/table placeholders. */
export function SkeletonRows({ rows = 3 }) {
  return (
    <div className="divide-y divide-border pv-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-4 py-3 pv-list__row">
          <div className="flex flex-1 flex-col gap-2 pv-list__main">
            <Skeleton width={`${55 - i * 8}%`} height={14} />
            <Skeleton width={`${30 + i * 5}%`} height={10} />
          </div>
          <Skeleton width={56} height={20} />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading", className }) {
  return (
    <span role="status" aria-label={label} className={cx("inline-flex items-center justify-center", className)}>
      <Loader2 className="size-4 animate-spin pv-spinner" aria-hidden="true" />
    </span>
  );
}

/** Thin indeterminate bar pinned to the top of the viewport while data loads. */
export function TopLoadingBar({ show }) {
  if (!show) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden pv-topbar"
      role="progressbar"
      aria-label="Loading"
    >
      <div className="skeleton-shimmer h-full w-full bg-primary" />
    </div>
  );
}

export function formatDate(value, { withTime = false } = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export function formatRelative(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const delta = (Date.now() - date.getTime()) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return formatDate(value);
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function formatPct(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}
