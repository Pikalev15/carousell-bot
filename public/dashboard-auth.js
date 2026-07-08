(() => {
  const originalFetch = window.fetch.bind(window);
  const STORAGE_KEY = "dashboardToken";
  let token = sessionStorage.getItem(STORAGE_KEY) || "";

  window.fetch = async (resource, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) headers.set("x-dashboard-token", token);
    let response = await originalFetch(resource, { ...options, headers });

    if (response.status === 401 && response.headers.get("x-auth-required") === "dashboard-token") {
      token = await requestDashboardToken();
      if (!token) return response;
      sessionStorage.setItem(STORAGE_KEY, token);
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set("x-dashboard-token", token);
      response = await originalFetch(resource, { ...options, headers: retryHeaders });
    }

    return response;
  };

  async function requestDashboardToken() {
    const existing = sessionStorage.getItem(STORAGE_KEY) || "";
    const entered = window.prompt("Enter DASHBOARD_TOKEN for this dashboard session", existing);
    return String(entered || "").trim();
  }
})();
