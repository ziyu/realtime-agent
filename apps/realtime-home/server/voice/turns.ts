import type { VoiceBridge } from './bridge';

interface Transcript { itemId: string; transcript: string; isFinal: boolean; turnStartedAt?: number }

/** Correlate provider transcripts to speech onset, never to their arrival order. */
export class VoiceTurns {
  sequence = 0;
  hearing = false;
  private items = new Map<string, number>();
  private pending: { sequence: number; startedAt: number }[] = [];
  constructor(private bridge: VoiceBridge, private now = Date.now) {}
  start(id?: string): number {
    const known = id && this.items.get(id);
    if (known) return known;
    this.sequence++; this.hearing = true;
    this.pending.push({ sequence: this.sequence, startedAt: this.now() });
    this.pending = this.pending.slice(-16);
    if (id) this.remember(id, this.sequence);
    this.bridge.event({ type: 'speech-start', sequence: this.sequence });
    return this.sequence;
  }
  stop() { this.hearing = false; this.bridge.event({ type: 'speech-end', sequence: this.sequence }); }
  private remember(id: string, sequence: number) {
    this.items.set(id, sequence);
    if (this.items.size > 128) this.items.delete(this.items.keys().next().value!);
  }
  transcript(event: Transcript): boolean {
    let sequence = this.items.get(event.itemId);
    if (sequence === undefined && event.turnStartedAt !== undefined) {
      sequence = this.pending.findLast(turn => turn.startedAt <= event.turnStartedAt! + 100)?.sequence;
    }
    if (sequence === undefined && this.pending.length === 1) sequence = this.pending[0].sequence;
    if (sequence === undefined) {
      if (this.pending.length > 1) this.bridge.fail('连续语音的转写无法确定所属轮次，已停止处理，请重新开始通话。');
      return false;
    }
    this.remember(event.itemId, sequence);
    if (!event.isFinal) return true;
    this.pending = this.pending.filter(turn => turn.sequence !== sequence);
    if (sequence === this.sequence) this.hearing = false;
    return this.bridge.event({ type: 'input', sequence, itemId: event.itemId, text: event.transcript, source: 'voice' });
  }
  text(text: string, id: string): number {
    const sequence = this.start(id);
    this.pending = this.pending.filter(turn => turn.sequence !== sequence);
    this.hearing = false;
    this.bridge.event({ type: 'input', sequence, itemId: id, text, source: 'text' });
    return sequence;
  }
}
