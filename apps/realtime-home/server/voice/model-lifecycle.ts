import { llm } from '@livekit/agents';

type ProviderSession = llm.RealtimeSession | llm.DuplexSession;

/** Public model adapters retain provider connections so ending a call cannot wait on playout. */
export function observeModel(model: llm.RealtimeModel | llm.DuplexModel, observe: (session: ProviderSession) => void) {
  const sessions = new Set<ProviderSession>();
  const created = <T extends ProviderSession>(session: T): T => { sessions.add(session); observe(session); return session; };
  class Realtime extends llm.RealtimeModel {
    constructor(private inner: llm.RealtimeModel) { super(inner.capabilities); }
    get model() { return this.inner.model; }
    get provider() { return this.inner.provider; }
    session() { return created(this.inner.session()); }
    close() { return this.inner.close(); }
  }
  class Duplex extends llm.DuplexModel {
    constructor(private inner: llm.DuplexModel) { super(inner.capabilities); }
    get model() { return this.inner.model; }
    get provider() { return this.inner.provider; }
    audioGate() { return this.inner.audioGate(); }
    session() { return created(this.inner.session()); }
    close() { return this.inner.close(); }
  }
  return {
    model: model instanceof llm.DuplexModel ? new Duplex(model) : new Realtime(model),
    async closeConnections() {
      await Promise.allSettled([...sessions].map(async session => {
        // Also clear pending input. In the pinned OpenAI plugin this wakes an idle
        // outgoing queue so its close flag can terminate the WebSocket promptly.
        await session.close();
        // close() in OpenAI 1.9.0 clears the outgoing queue before its reader wakes.
        // Waking it afterwards lets that reader observe the closed flag and close WS.
        if (session instanceof llm.RealtimeSession) await session.clearAudio().catch(() => undefined);
      }));
      sessions.clear();
    },
  };
}
