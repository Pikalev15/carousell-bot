let lastRuntimeId = 0;

export function nextRuntimeId() {
  const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  if (candidate <= lastRuntimeId) {
    lastRuntimeId += 1;
  } else {
    lastRuntimeId = candidate;
  }
  return lastRuntimeId;
}
