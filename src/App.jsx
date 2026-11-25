import { lazy, Suspense } from "react";
import Guest from "./Guest.jsx";
import { backendMode } from "./eventStore.js";
import { getAppRole, Shell } from "./ui.jsx";

const LiveEventGate = lazy(() => import("./LiveEventGate.jsx"));
const Admin = lazy(() => import("./Admin.jsx"));
const Bartender = lazy(() => import("./Bartender.jsx"));

export default function App() {
  const mode = getAppRole();
  const role = mode[0].toUpperCase() + mode.slice(1);

  const screen = mode === "admin" ? <Admin /> : mode === "bartender" ? <Bartender /> : <Guest mode={mode} role={role} />;

  return (
    <Shell role={role}>
      <Suspense fallback={<p className="loading" role="status">Loading Drink Pass…</p>}>
        {backendMode ? <LiveEventGate mode={mode} role={role}>{screen}</LiveEventGate> : screen}
      </Suspense>
    </Shell>
  );
}
