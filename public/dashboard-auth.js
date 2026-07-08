(() => {
  const originalFetch = window.fetch.bind(window);
  const STORAGE_KEY = "dashboardToken";
  const REQUIRED_HEADER = "x-auth-required";
  const REQUIRED_VALUE = "dashboard-token";
  let token = sessionStorage.getItem(STORAGE_KEY) || "";
  let tokenRequiredShown = false;

  const coordinator = globalThis.createDashboardTokenCoordinator({
    getStoredToken: () => sessionStorage.getItem(STORAGE_KEY) || token || "",
    setStoredToken: (value) => {
      token = String(value || "").trim();
      if (token) sessionStorage.setItem(STORAGE_KEY, token);
    },
    askForToken: (existing) => window.prompt("Enter DASHBOARD_TOKEN for this dashboard session", existing || "")
  });

  window.fetch = async (resource, options = {}) => {
    const response = await fetchWithToken(resource, options, token);
    if (!requiresDashboardToken(response)) return response;

    const nextToken = await coordinator.acquireToken();
    token = nextToken;
    if (!nextToken) {
      showTokenRequiredMessage();
      return response;
    }

    return fetchWithToken(resource, options, nextToken);
  };

  async function fetchWithToken(resource, options, value) {
    const headers = new Headers(options.headers || {});
    if (value) headers.set("x-dashboard-token", value);
    return originalFetch(resource, { ...options, headers });
  }

  function requiresDashboardToken(response) {
    return response.status === 401 && response.headers.get(REQUIRED_HEADER) === REQUIRED_VALUE;
  }

  function showTokenRequiredMessage() {
    if (tokenRequiredShown) return;
    tokenRequiredShown = true;
    const message = "Dashboard token required — reload the page to try again.";
    const toast = document.createElement("div");
    toast.className = "toast error";
    toast.textContent = message;
    const root = document.getElementById("toast-root");
    if (root) root.appendChild(toast);
    const summary = document.getElementById("search-summary");
    if (summary) summary.textContent = message;
  }
})();
