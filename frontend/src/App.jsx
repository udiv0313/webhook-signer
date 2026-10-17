import { useState } from "react";
import DashboardPage from "./pages/DashboardPage.jsx";
import CreateEndpointPage from "./pages/CreateEndpointPage.jsx";
import EndpointPage from "./pages/EndpointPage.jsx";

// Navigation is plain React state: which page is shown, and for which endpoint.
// (A router library would be overkill for three pages.)
export default function App() {
  const [view, setView] = useState({ page: "dashboard" });

  const showDashboard = () => setView({ page: "dashboard" });
  const showCreate = () => setView({ page: "create" });
  // `demo` is set only right after "Start the guided demo": it carries the new
  // endpoint's secret to that one page, and is dropped when you navigate away.
  const showEndpoint = (endpointId, demo = null) => setView({ page: "endpoint", endpointId, demo });
  const startDemo = (endpoint) => showEndpoint(endpoint.id, { secret: endpoint.secret });

  return (
    <div className="app">
      <header className="app-header">
        <button type="button" className="brand" onClick={showDashboard}>
          <span className="brand-mark" aria-hidden="true">
            {"{ }"}
          </span>{" "}
          Webhook Signer
        </button>
        <nav aria-label="Main">
          <button
            type="button"
            className="nav-link"
            aria-current={view.page !== "create" ? "page" : undefined}
            onClick={showDashboard}
          >
            Endpoints
          </button>
          <button
            type="button"
            className="nav-link"
            aria-current={view.page === "create" ? "page" : undefined}
            onClick={showCreate}
          >
            Create endpoint
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view.page === "dashboard" && (
          <DashboardPage onOpenEndpoint={showEndpoint} onCreateEndpoint={showCreate} onStartDemo={startDemo} />
        )}
        {view.page === "create" && <CreateEndpointPage onOpenEndpoint={showEndpoint} onCancel={showDashboard} />}
        {view.page === "endpoint" && (
          <EndpointPage key={view.endpointId} endpointId={view.endpointId} demo={view.demo} onBack={showDashboard} />
        )}
      </main>

      <footer className="app-footer small muted">
        Prototype: your endpoints and events belong to this browser and are deleted after 72 hours.
      </footer>
    </div>
  );
}
