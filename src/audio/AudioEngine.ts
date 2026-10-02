// Audio input: one AudioContext, one AnalyserNode, several interchangeable
// sources. Nothing is downloaded up front: the stream source plays a remote
// MP3 progressively through an <audio> element, and the tab source analyses
// whatever another browser tab is playing (YouTube, Spotify web, ...).

export type SourceKind = 'stream' | 'tab' | 'file' | 'mic' | 'none';

export interface Analysis {
  /** Linear magnitudes per FFT bin, current frame. */
  spectrum: Float32Array;
  /** Hz per bin. */
  binHz: number;
  /** 0..1-ish loudness (RMS of the spectrum). */
  loudness: number;
  /** 0..1-ish energy above 4 kHz. */
  high: number;
  /** AudioContext time of this analysis. */
  time: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly analyser: AnalyserNode;
  readonly media: HTMLAudioElement;
  kind: SourceKind = 'none';
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private liveNode: MediaStreamAudioSourceNode | null = null;
  private liveStream: MediaStream | null = null;
  private dbBuf: Float32Array<ArrayBuffer>;
  private linBuf: Float32Array<ArrayBuffer>;
  readonly analysis: Analysis;
  onStateChange: (() => void) | null = null;
  private wantPlaying = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0;
    this.dbBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.linBuf = new Float32Array(this.analyser.frequencyBinCount);
    this.media = new Audio();
    this.media.crossOrigin = 'anonymous';
    this.media.preload = 'auto';
    this.media.loop = true;
    this.analysis = {
      spectrum: this.linBuf,
      binHz: this.ctx.sampleRate / this.analyser.fftSize,
      loudness: 0,
      high: 0,
      time: 0,
    };
    for (const ev of ['play', 'pause', 'ended', 'error', 'waiting', 'playing', 'loadedmetadata'])
      this.media.addEventListener(ev, () => this.onStateChange?.());
    this.media.addEventListener('error', () => (this.wantPlaying = false));
  }

  get isLive(): boolean {
    return this.kind === 'tab' || this.kind === 'mic';
  }

  get playing(): boolean {
    if (this.isLive) return this.liveStream !== null && this.liveStream.active;
    return this.kind !== 'none' && !this.media.paused;
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  private disconnectAll(): void {
    this.mediaNode?.disconnect();
    this.liveNode?.disconnect();
    this.liveNode = null;
    if (this.liveStream) {
      for (const t of this.liveStream.getTracks()) t.stop();
      this.liveStream = null;
    }
    this.media.pause();
  }

  private ensureMediaNode(): MediaElementAudioSourceNode {
    if (!this.mediaNode) this.mediaNode = this.ctx.createMediaElementSource(this.media);
    return this.mediaNode;
  }

  /** Progressive playback of a remote URL. The server must send CORS headers. */
  async useStream(url: string): Promise<void> {
    this.prepareStream(url);
    this.wantPlaying = true;
    await this.resume();
    await this.media.play();
    this.onStateChange?.();
  }

  /**
   * Point the element at a URL and let it buffer, without playing: browsers
   * refuse audio before a gesture, but they do allow the download to begin,
   * so the first tap starts a stream that is already ahead of the needle.
   */
  prepareStream(url: string): void {
    this.disconnectAll();
    this.kind = 'stream';
    const node = this.ensureMediaNode();
    node.connect(this.analyser);
    node.connect(this.ctx.destination);
    this.media.src = url;
    this.media.load();
    this.wantPlaying = false;
    this.onStateChange?.();
  }

  /** Start a prepared stream. Call synchronously inside a user gesture handler. */
  startPrepared(): void {
    if (this.kind !== 'stream' || !this.media.paused) return;
    void this.ctx.resume();
    this.wantPlaying = true;
    void this.media.play().catch((err: unknown) => {
      this.wantPlaying = false;
      console.warn('stream start refused', err);
      this.onStateChange?.();
    });
    this.onStateChange?.();
  }

  /** True while a stream or file we want to hear has not buffered enough to play. */
  get buffering(): boolean {
    if (this.kind !== 'stream' && this.kind !== 'file') return false;
    return this.wantPlaying && !this.media.error && this.media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA;
  }

  async useFile(file: File): Promise<void> {
    this.disconnectAll();
    this.kind = 'file';
    const node = this.ensureMediaNode();
    node.connect(this.analyser);
    node.connect(this.ctx.destination);
    this.media.src = URL.createObjectURL(file);
    this.wantPlaying = true;
    await this.resume();
    await this.media.play();
    this.onStateChange?.();
  }

  /** Analyse the audio of another tab. The tab keeps playing on its own; we only listen. */
  async useTab(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      // Chromium-only hints: offer tabs first, never this tab, keep the source audible.
      ...({ preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include', suppressLocalAudioPlayback: false } as object),
    });
    if (stream.getAudioTracks().length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('No audio track: tick "Share tab audio" in the picker.');
    }
    for (const t of stream.getVideoTracks()) t.stop();
    this.disconnectAll();
    this.kind = 'tab';
    this.liveStream = stream;
    this.liveNode = this.ctx.createMediaStreamSource(stream);
    this.liveNode.connect(this.analyser);
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      this.kind = 'none';
      this.onStateChange?.();
    });
    await this.resume();
    this.onStateChange?.();
  }

  async useMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.disconnectAll();
    this.kind = 'mic';
    this.liveStream = stream;
    this.liveNode = this.ctx.createMediaStreamSource(stream);
    this.liveNode.connect(this.analyser);
    await this.resume();
    this.onStateChange?.();
  }

  stop(): void {
    this.disconnectAll();
    this.wantPlaying = false;
    this.kind = 'none';
    this.onStateChange?.();
  }

  togglePlay(): void {
    if (this.isLive) return;
    if (this.media.paused) {
      this.wantPlaying = true;
      void this.ctx.resume();
      void this.media.play();
    } else {
      this.wantPlaying = false;
      this.media.pause();
    }
  }

  /** Pull one frame of spectrum data. Call once per animation frame. */
  update(): Analysis {
    const a = this.analysis;
    a.time = this.ctx.currentTime;
    if (this.kind === 'none') {
      this.linBuf.fill(0);
      a.loudness = 0;
      a.high = 0;
      return a;
    }
    this.analyser.getFloatFrequencyData(this.dbBuf);
    const n = this.dbBuf.length;
    let sum = 0;
    let highSum = 0;
    const highStart = Math.min(n - 1, Math.floor(4000 / a.binHz));
    for (let i = 0; i < n; i++) {
      const db = this.dbBuf[i];
      const lin = db <= -160 ? 0 : Math.pow(10, db / 20);
      this.linBuf[i] = lin;
      sum += lin * lin;
      if (i >= highStart) highSum += lin * lin;
    }
    // Rough perceptual scaling: a normal mix sits around 0.3 to 0.7.
    a.loudness = Math.min(1, Math.sqrt(sum / n) * 300);
    a.high = Math.min(1, Math.sqrt(highSum / (n - highStart)) * 1200);
    return a;
  }
}
