/** A row of filter pills. The active one inverts to solid ink. */

export const Tabs = ({ items, active, onChange, className = '' }) => (
  <div className={`filters ${className}`.trim()} role="tablist" style={{ marginBottom: 0 }}>
    {items.map((item) => {
      const isActive = item.key === active;
      return (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={isActive}
          className={`filter${isActive ? ' is-on' : ''}`}
          onClick={() => onChange(item.key)}
          data-testid={item.testId}
        >
          {item.label}
          {item.count != null && (
            <span style={{ opacity: 0.6, marginLeft: 6 }}>{item.count}</span>
          )}
        </button>
      );
    })}
  </div>
);

export default Tabs;
