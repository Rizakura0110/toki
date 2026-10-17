import { useLayoutEffect, useState } from "react";
import { Route, Routes, useLocation, useNavigationType } from "react-router";
import { CalendarScreen } from "./calendar";
import { CalendarStore } from "./calendar-store";
import { MeasurementScreen } from "./measurement";
import { MeasurementStore } from "./measurement-store";

export function createStores() {
  return {
    measurement: new MeasurementStore(),
    calendar: new CalendarStore(() => window.matchMedia("(max-width: 700px)").matches),
  };
}
export function Application({ stores: supplied }: { stores?: ReturnType<typeof createStores> }) {
  // Owned above routes: uncertain outcomes/request keys survive client navigation.
  // Constructors have no network/timer/mutation side effects under StrictMode.
  const [stores] = useState(() => supplied ?? createStores());
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useLayoutEffect(() => {
    // New page links behaved as document navigations before React. Keep their
    // top-of-page landing; let browser history retain its normal POP behavior.
    if (navigationType !== "POP" && ["/", "/index.html", "/calendar.html"].includes(pathname))
      window.scrollTo(0, 0);
  }, [pathname, navigationType]);
  return (
    <Routes>
      <Route path="/" element={<MeasurementScreen store={stores.measurement} />} />
      <Route path="/index.html" element={<MeasurementScreen store={stores.measurement} />} />
      <Route path="/calendar.html" element={<CalendarScreen store={stores.calendar} />} />
      <Route
        path="*"
        element={
          <main>
            <h1>ページが見つかりません</h1>
          </main>
        }
      />
    </Routes>
  );
}
