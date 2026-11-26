import { useEffect, useRef } from "react";

const ROLES = ["staff", "manager", "bartender", "admin"];

export function getAppRole() {
  const queryRole = new URLSearchParams(window.location.search).get("role");
  const pathRole = window.location.pathname.split("/").find((part) => ROLES.includes(part));
  if (ROLES.includes(queryRole)) return queryRole;
  if (pathRole) return pathRole;
  return ROLES.includes(import.meta.env.MODE) ? import.meta.env.MODE : "staff";
}

export function isDemoMode() {
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

export function Shell({ role, children }) {
  useEffect(() => {
    document.title = `Drink Pass — ${role}`;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", role === "Manager" ? "#1c1c1e" : "#FFFFFF");
  }, [role]);

  return (
    <main className={`app-shell ${role === "Manager" ? "manager-theme" : ""}`}>
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

export function ScreenTitle({ children, description, focusRef }) {
  return (
    <>
      <h1 className="screen-title" ref={focusRef} tabIndex={focusRef ? -1 : undefined}>{children}</h1>
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

export function Dialog({ titleId, onClose, children, className = "", focusKey }) {
  const ref = useRef(null);

  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (focusKey !== undefined) {
      ref.current.querySelector(`#${titleId}`)?.focus({ preventScroll: true });
    }
  }, [focusKey, titleId]);

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
