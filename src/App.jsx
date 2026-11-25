import { lazy, Suspense } from "react";
import Guest from "./Guest.jsx";
import { getAppRole, Shell } from "./ui.jsx";

const Admin = lazy(() => import("./Admin.jsx"));
const Bartender = lazy(() => import("./Bartender.jsx"));

export default function App() {
  const mode = getAppRole();
  const role = mode[0].toUpperCase() + mode.slice(1);

  return (
    <Shell role={role}>
      <Suspense fallback={<p className="loading" role="status">Loading Drink Pass…</p>}>
        {mode === "admin" && <Admin />}
        {mode === "bartender" && <Bartender />}
        {(mode === "staff" || mode === "manager") && <Guest mode={mode} role={role} />}
      </Suspense>
    </Shell>
  );
}
