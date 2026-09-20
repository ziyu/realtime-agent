import { realtime as xai } from '@livekit/agents-plugin-xai';
import { realtime as openai } from '@livekit/agents-plugin-openai';

/** xAI 1.9.0 discards its current generation after awaiting a cancellation.
 * A new response can arrive in that gap, so scope cleanup to the generation
 * present when the interrupt was requested, before yielding to the event loop.
 */
class GrokRealtimeSession extends xai.RealtimeSession {
  override interrupt(): Promise<void> {
    const generation = this.currentGeneration;
    const cancel = openai.RealtimeSession.prototype.interrupt.call(this);
    if (generation && !(generation instanceof openai.DiscardedGeneration) && this.currentGeneration === generation) {
      this.closeCurrentGeneration('user interruption');
      this.currentGeneration = new openai.DiscardedGeneration();
    }
    return cancel;
  }
}

export class GrokRealtimeModel extends xai.RealtimeModel {
  override session(): xai.RealtimeSession { return new GrokRealtimeSession(this); }
}
