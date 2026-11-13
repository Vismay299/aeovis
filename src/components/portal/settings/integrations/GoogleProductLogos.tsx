/** The Google Analytics mark (three rising bars), for the connection card title. */
export function GoogleAnalyticsLogo({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <rect x="16.5" y="2" width="5.5" height="20" rx="2.75" fill="#F9AB00" />
      <rect x="9.25" y="9" width="5.5" height="13" rx="2.75" fill="#E37400" />
      <circle cx="4.75" cy="19.25" r="2.75" fill="#E37400" />
    </svg>
  );
}
