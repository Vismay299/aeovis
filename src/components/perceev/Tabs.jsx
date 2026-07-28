/**
 * The route selector: the row of illuminated route buttons along the top
 * of a panel. The set route carries a lit strip on its bottom edge.
 */

export const Tabs = ({ items, active, onChange, className = '' }) => (
  <div className={`sb-routes ${className}`} role="tablist">
    {items.map((item) => {
      const isActive = item.key === active;
      return (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={isActive}
          data-active={isActive ? 'true' : 'false'}
          className="sb-route"
          onClick={() => onChange(item.key)}
          data-testid={item.testId}
        >
          {item.label}
          {item.count != null && <span className="sb-route__count">{item.count}</span>}
        </button>
      );
    })}
  </div>
);

export default Tabs;
