type ShutdownSignal = "SIGINT" | "SIGTERM";

type SignalSource = {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
};

type HttpServerOwner = {
  close(): unknown;
  closeAllConnections?(): void;
  once(event: "close", listener: () => void): unknown;
  off(event: "close", listener: () => void): unknown;
};

type WebSocketServerOwner = {
  clients: Iterable<{ terminate(): void }>;
  close(): unknown;
};

type GracefulShutdownOptions = {
  server: HttpServerOwner;
  webSockets: WebSocketServerOwner;
  onShutdown: () => void;
  forceAfterMs?: number;
  signalSource?: SignalSource;
};

export function installGracefulShutdown({
  server,
  webSockets,
  onShutdown,
  forceAfterMs = 10_000,
  signalSource = process,
}: GracefulShutdownOptions): { close(): void } {
  let started = false;
  let forceTimer: ReturnType<typeof setTimeout> | null = null;

  const terminateWebSockets = () => {
    for (const client of webSockets.clients) client.terminate();
  };
  const removeListeners = () => {
    signalSource.off("SIGINT", beginShutdown);
    signalSource.off("SIGTERM", beginShutdown);
    server.off("close", finishShutdown);
  };
  const finishShutdown = () => {
    if (forceTimer) clearTimeout(forceTimer);
    forceTimer = null;
    removeListeners();
  };
  const forceShutdown = () => {
    terminateWebSockets();
    server.closeAllConnections?.();
  };
  function beginShutdown() {
    if (started) return;
    started = true;
    onShutdown();
    terminateWebSockets();
    webSockets.close();
    forceTimer = setTimeout(forceShutdown, Math.max(0, forceAfterMs));
    forceTimer.unref();
    server.close();
  }

  signalSource.once("SIGINT", beginShutdown);
  signalSource.once("SIGTERM", beginShutdown);
  server.once("close", finishShutdown);

  return { close: finishShutdown };
}
