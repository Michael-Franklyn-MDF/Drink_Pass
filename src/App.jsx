import { lazy, Suspense } from "react";
import { backendMode } from "./eventStore.js";
import { getAppRole, Screen, ScreenTitle, Shell } from "./ui.jsx";

const LiveEventGate = lazy(() => import("./LiveEventGate.jsx"));
const Admin = lazy(() => import("./Admin.jsx"));
const Bartender = lazy(() => import("./Bartender.jsx"));

export default function App() {
  const mode = getAppRole();
  if (mode === "cards") {
    return (
      <Shell role="Physical cards">
        <Screen role="Physical cards">
          <div className="screen-content">
            <ScreenTitle description="Show your card to the bartender.">Use your physical Drink Pass card</ScreenTitle>
          </div>
        </Screen>
      </Shell>
    );
  }
  const role = mode[0].toUpperCase() + mode.slice(1);
  const screen = mode === "admin" ? <Admin /> : <Bartender />;

  return (
    <Shell role={role}>
      <Suspense fallback={<p className="loading" role="status">Loading Drink Pass…</p>}>
        {backendMode ? <LiveEventGate role={role}>{screen}</LiveEventGate> : screen}
      </Suspense>
    </Shell>
  );
}
