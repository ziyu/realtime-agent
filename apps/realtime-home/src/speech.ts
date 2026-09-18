export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface RecognitionEvent { resultIndex: number; results: ArrayLike<RecognitionResult> }
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
export type VoiceStatus = 'off' | 'starting' | 'listening' | 'hearing' | 'reconnecting';
export interface SpeechCallbacks {
  status(value: VoiceStatus): void;
  transcript(value: string): void;
  interrupt(): void;
  utterance(text: string): void;
  error(message: string): void;
}

/** Continuous browser recognition. Interim hypotheses are visible, never executable input. */
export class VoiceConversation {
  private enabled = false;
  private generation = 0;
  private recognition: Recognition | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private finalText = '';
  private interimText = '';
  private hearing = false;
  private emptyRestarts = 0;

  constructor(private create: () => Recognition, private callbacks: SpeechCallbacks) {}

  start() {
    if (this.enabled) return;
    this.enabled = true; this.emptyRestarts = 0;
    this.connect();
  }
  stop() {
    this.enabled = false; this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.restartTimer = null; this.finalTimer = null;
    const recognition = this.recognition; this.recognition = null;
    if (recognition) {
      recognition.onstart = recognition.onspeechstart = recognition.onspeechend = recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* Already ended. */ }
    }
    this.finalText = ''; this.interimText = ''; this.hearing = false;
    this.callbacks.transcript(''); this.callbacks.status('off');
  }
  private fail(message: string) { this.stop(); this.callbacks.error(message); }
  private beginSpeech() {
    if (!this.hearing) { this.hearing = true; this.callbacks.interrupt(); }
    this.callbacks.status('hearing');
  }
  private flush() {
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.finalTimer = null;
    const text = this.finalText.trim();
    this.finalText = ''; this.hearing = false;
    this.callbacks.transcript(this.interimText);
    this.callbacks.status(this.enabled ? 'listening' : 'off');
    if (!text) return;
    if (text.length > 1200) { this.fail('这句话太长，请分成短句再说。'); return; }
    this.callbacks.utterance(text);
  }
  private connect() {
    if (!this.enabled) return;
    const generation = ++this.generation;
    const current = () => this.enabled && generation === this.generation;
    let processed = 0;
    const started = Date.now();
    try {
      const recognition = this.create(); this.recognition = recognition;
      recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
      this.callbacks.status('starting');
      recognition.onstart = () => { if (current()) this.callbacks.status('listening'); };
      recognition.onspeechstart = () => { if (current()) this.beginSpeech(); };
      recognition.onspeechend = () => {
        if (current() && this.finalText && !this.interimText) this.flush();
      };
      recognition.onresult = event => {
        if (!current()) return;
        this.emptyRestarts = 0;
        let newFinal = '', interim = '';
        // Results contain earlier final entries too. Consume each index once per connection.
        for (let i = processed; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) { newFinal += result[0].transcript; processed = i + 1; }
          else interim += result[0].transcript;
        }
        if (!newFinal && !interim) return;
        this.beginSpeech();
        this.finalText += newFinal; this.interimText = interim;
        this.callbacks.transcript(this.finalText + interim);
        if (this.finalTimer) clearTimeout(this.finalTimer);
        this.finalTimer = null;
        // Briefly merge fragmented final results; never submit unstable interim text.
        if (this.finalText && !interim) this.finalTimer = setTimeout(() => { if (current()) this.flush(); }, 160);
      };
      recognition.onerror = event => {
        if (!current() || event.error === 'no-speech') return;
        const messages: Record<string, string> = {
          'not-allowed': '麦克风未获允许。请允许此页面使用麦克风后重新开始。',
          'service-not-allowed': '浏览器没有允许语音识别服务，请使用文字对话。',
          'audio-capture': '没有可用的麦克风，请检查输入设备。',
          network: '语音识别服务连接失败，实时语音已结束；文字对话仍可使用。',
          'language-not-supported': '语音识别服务暂不支持中文，请使用文字对话。',
        };
        this.fail(messages[event.error] ?? '语音识别中断，请重新开始或使用文字对话。');
      };
      recognition.onend = () => {
        if (!current()) return;
        // An ended recognizer must not deliver a late result during the reconnect delay.
        this.generation++;
        if (this.interimText.trim()) {
          this.finalText = '';
          this.callbacks.error('这句话没有识别完整，请再说一次。');
        }
        this.interimText = '';
        this.flush();
        this.recognition = null;
        if (!this.enabled) return;
        if (Date.now() - started < 1500) this.emptyRestarts++;
        else this.emptyRestarts = 0;
        if (this.emptyRestarts >= 3) { this.fail('语音识别反复断开，已结束监听，请检查麦克风和网络。'); return; }
        this.callbacks.status('reconnecting');
        this.restartTimer = setTimeout(() => { this.restartTimer = null; this.connect(); }, 350);
      };
      recognition.start();
    } catch { this.fail('无法启动语音识别，请检查浏览器权限或使用文字对话。'); }
  }
}
