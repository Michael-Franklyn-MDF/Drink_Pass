import { useEffect, useRef } from "react";

const operatorRoles = ["bartender", "admin"];
const retiredRoles = ["staff", "manager"];

export function getAppRole() {
  const queryRole = new URLSearchParams(window.location.search).get("role");
  const path = window.location.pathname.split("/");
  if (retiredRoles.includes(queryRole) || path.some((part) => retiredRoles.includes(part))) return "cards";
  return [queryRole, ...path, import.meta.env.MODE].find((part) => operatorRoles.includes(part))
    ?? (retiredRoles.includes(import.meta.env.MODE) ? "cards" : "admin");
}

export function isDemoMode() {
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

export function Shell({ role, children }) {
  useEffect(() => {
    document.title = `Drink Pass — ${role}`;
  }, [role]);

  return (
    <main className="app-shell">
      {children}
    </main>
  );
}

export function Screen({ children, className = "", role }) {
  return (
    <section className={`screen screen-enter ${className}`}>
      <header className="top-bar">
        <span>Drink Pass</span>
        <span>{role}</span>
      </header>
      {children}
    </section>
  );
}

export function ScreenTitle({ children, description }) {
  return (
    <>
      <h1 className="screen-title">{children}</h1>
      {description && <p className="screen-description">{description}</p>}
    </>
  );
}

export function TextField({ label, name, ...props }) {
  return (
    <label className="admin-field">
      <span className="field-label">{label}</span>
      <input className="text-field" name={name} required {...props} />
    </label>
  );
}

export function Dialog({ titleId, onClose, children, className = "" }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
