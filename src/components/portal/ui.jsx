"use client";

/**
 * Shared workspace compositions. Primitive styling lives in the design system;
 * portal.css supplies layouts used by the customer portal and public demo.
 */

import Link from "next/link";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, Check, X } from "lucide-react";

const cx = (...parts) => parts.filter(Boolean).join(" ");

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <header className="pv-page-header">
      <div>
        {eyebrow ? <p className="pv-page-header__eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="pv-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, description, actions, footer, flush, className, children, ...rest }) {
  return (
    <section className={cx("pv-card", flush && "pv-card--flush", className)} {...rest}>
      {title || actions ? (
        <div className="pv-card__header">
          <div>
            {title ? <h2 className="pv-card__title">{title}</h2> : null}
            {description ? <p className="pv-card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="pv-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children !== undefined && children !== null ? <div className="pv-card__body">{children}</div> : null}
      {footer ? <div className="pv-card__footer">{footer}</div> : null}
    </section>
  );
}

/** A KPI tile. `value` null/undefined renders an em dash, never 0. */
export function Stat({ label, icon: Icon, value, suffix, sub, className }) {
  const blank = value === null || value === undefined || value === "";
  return (
    <div className={cx("pv-card pv-stat", className)}>
      <span className="pv-stat__label">{Icon ? <Icon aria-hidden="true" /> : null}{label}</span>
      <span className={cx("pv-stat__value", blank && "is-empty")}>
        {blank ? "—" : value}
        {!blank && suffix ? <small>{suffix}</small> : null}
      </span>
      {sub ? <span className="pv-stat__sub">{sub}</span> : null}
    </div>
  );
}

/**
 * Button. Pass `href` to render a Next <Link> styled as a button.
 * variant: primary | secondary | ghost | danger. size: md | sm.
 */
export function Button({ variant = "primary", size = "md", href, icon: Icon, loading, block, disabled, type = "button", className, children, ...rest }) {
  const classes = cx("pv-btn", `pv-btn--${variant}`, size === "sm" && "pv-btn--sm", block && "pv-btn--block", className);
  const content = (
    <>
      {loading ? <span className="pv-spinner" aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </>
  );
  if (href) return <Link href={href} className={classes} {...rest}>{content}</Link>;
  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading}>
      {content}
    </button>
  );
}

/** tone: neutral | brand | good | warn | crit. `live` pulses the dot. */
export function Badge({ tone = "neutral", dot, live, className, children }) {
  return (
    <span className={cx("pv-badge", tone !== "neutral" && `pv-badge--${tone}`, live && "pv-badge--live", className)}>
      {dot || live ? <i className="pv-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

const BANNER_ICON = { info: Info, success: CheckCircle2, warn: TriangleAlert, error: AlertCircle };

/** tone: info | success | warn | error. */
export function Banner({ tone = "info", title, children, action, onDismiss }) {
  const Icon = BANNER_ICON[tone] || Info;
  return (
    <div className={`pv-banner pv-banner--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon aria-hidden="true" />
      <div className="pv-banner__body">
        {title ? <div className="pv-banner__title">{title}</div> : null}
        {children}
      </div>
      {action}
      {onDismiss ? (
        <button type="button" className="pv-icon-btn" onClick={onDismiss} aria-label="Dismiss">
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }) {
  return (
    <div className="pv-empty">
      {Icon ? <div className="pv-empty__icon"><Icon aria-hidden="true" /></div> : null}
      {title ? <p className="pv-empty__title">{title}</p> : null}
      {children ? <p className="pv-empty__text">{children}</p> : null}
      {action ? <div className="pv-empty__action">{action}</div> : null}
    </div>
  );
}

/**
 * Progress bar. `value` is 0–100; null/undefined draws the indeterminate sweep
 * (we do not know yet — never shown as 0%). Pass `indeterminate={false}` where a
 * null value is a finished "not measured" result rather than a pending reading,
 * so the rail stays still instead of sweeping forever.
 * `active` adds a moving sheen so a bar waiting on its next reading looks alive.
 */
export function ProgressBar({ value, active = false, indeterminate, size = "md", tone, label = "Progress" }) {
  const known = typeof value === "number" && Number.isFinite(value);
  const pct = known ? Math.min(100, Math.max(0, value)) : null;
  const sweeping = !known && indeterminate !== false;
  return (
    <div
      className={cx(
        "pv-progress",
        size === "sm" && "pv-progress--sm",
        size === "lg" && "pv-progress--lg",
        sweeping && "pv-progress--indeterminate",
        tone && `pv-progress--${tone}`,
        active && known && "is-active",
      )}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(pct) : undefined}
      aria-valuetext={known ? `${Math.round(pct)}%` : sweeping ? "In progress" : "Not measured"}
    >
      {known || sweeping ? (
        <span className="pv-progress__fill" style={known ? { transform: `scaleX(${pct / 100})` } : undefined} />
      ) : null}
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

/** Segmented tabs. items = [{ value, label, count? }]. */
export function Tabs({ items, value, onChange, label = "Views" }) {
  return (
    <div className="pv-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={cx("pv-tab", item.value === value && "is-active")}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count !== undefined ? <span className="pv-tab__count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ width = "100%", height = 12, style }) {
  return <span className="pv-skeleton" style={{ width, height, ...style }} aria-hidden="true" />;
}

/** A few skeleton rows for list/table placeholders. */
export function SkeletonRows({ rows = 3 }) {
  return (
    <div className="pv-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="pv-list__row">
          <div className="pv-list__main" style={{ gap: 8 }}>
            <Skeleton width={`${55 - i * 8}%`} />
            <Skeleton width={`${30 + i * 5}%`} height={10} />
          </div>
          <Skeleton width={56} height={20} />
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label = "Loading" }) {
  return <span className="pv-spinner" role="status" aria-label={label} />;
}

/** Thin indeterminate bar pinned to the top of the viewport while data loads. */
export function TopLoadingBar({ show }) {
  return show ? <div className="pv-topbar" role="progressbar" aria-label="Loading" /> : null;
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
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return "—";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** 41.6 -> "42%"; null -> "—". */
export function formatPct(value) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) ? `${Math.round(n)}%` : "—";
}
