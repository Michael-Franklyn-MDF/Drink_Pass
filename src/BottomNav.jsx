export default function BottomNav({ label, tabs, active, onSelect, add }) {
  return (
    <div className="bottom-nav-group">
      <nav className="bottom-nav" aria-label={label}>
        {tabs.map(({ id, label: name, icon = id, disabled }) => (
          <button key={id} type="button" aria-label={name} aria-current={id === active ? "page" : undefined}
            disabled={disabled} onClick={() => onSelect(id)}>
            <img src={`/assets/${icon}${id === active ? "-active" : ""}.svg`} alt="" />
            {id === active && <span>{name}</span>}
          </button>
        ))}
      </nav>
      {add && (
        <button type="button" className="bottom-nav-add" aria-label={add.label} onClick={add.onClick}>
          <img src="/assets/add.svg" alt="" />
        </button>
      )}
    </div>
  );
}
