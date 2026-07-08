(function attachDashboardAuthCore(root) {
  function createDashboardTokenCoordinator({ getStoredToken, setStoredToken, askForToken }) {
    let pendingTokenRequest = null;

    async function acquireToken() {
      if (!pendingTokenRequest) {
        pendingTokenRequest = Promise.resolve()
          .then(() => askForToken(getStoredToken() || ""))
          .then((value) => {
            const token = String(value || "").trim();
            setStoredToken(token);
            return token;
          })
          .finally(() => {
            pendingTokenRequest = null;
          });
      }
      return pendingTokenRequest;
    }

    return { acquireToken };
  }

  root.createDashboardTokenCoordinator = createDashboardTokenCoordinator;
})(typeof globalThis !== "undefined" ? globalThis : window);
