import 'amazing-glass/styles.css';
import 'amazing-glass';
import { registerIcon } from 'amazing-glass';
import type { AudioEngine, SourceKind } from '../audio/AudioEngine';

// The glass UI. The page starts with nothing but the ink and a hint; a long
// press reveals the floating toolbar, and the toolbar opens the source chooser
// and the settings panel. Everything hides again with H or the eye button.

export const DEFAULT_STREAM =
  'https://archive.org/download/WkBw0034/01-Monochromatic-Immobility-.mp3';
export const LUMEN_CHAMBER_YT = 'https://www.youtube.com/watch?v=Rx2IqPD5BMs';

const SOURCE_NOTES: Record<string, string> = {
  Stream:
    'Streams a Creative Commons track (MonoChromatic, "Immobility", CC BY-NC-SA) straight from archive.org. Paste any CORS-enabled MP3 URL.',
  'Tab audio':
    'Play "Lumen Chamber" by Deescawa on YouTube in another tab, then pick that tab and tick "Share tab audio". Analysed live, nothing is downloaded. Desktop Chrome and Edge only.',
  File: 'Pick a local audio file. It plays from disk, nothing is uploaded.',
  Mic: 'Listens to the microphone or line input.',
  Silent: 'No audio. Beats come from the manual BPM clock in the settings panel.',
};

registerIcon(
  'pause',
  '<rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>'
);
registerIcon(
  'sliders',
  '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="15" cy="7" r="2.4" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="2.4" fill="currentColor" stroke="none"/></g>'
);
registerIcon(
  'eyeSlash',
  '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/><path d="M4 20 20 4"/></g>'
);
registerIcon(
  'arrowTriangle2Circlepath',
  '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 0 1-13.7 5.6M4 12a8 8 0 0 1 13.7-5.6"/><path d="M17 3v4h-4M7 21v-4h4"/></g>'
);
// Elements upgraded before the icons above existed: re-apply so they render.
for (const el of document.querySelectorAll('ag-button[icon]')) el.setAttribute('icon', el.getAttribute('icon')!);

export interface OverlayHandlers {
  onStart: (choice: SourceKind, extra: { url?: string; file?: File }) => Promise<void>;
  onTogglePlay: () => void;
  onToggleSettings: () => void;
  onToggleMode: () => void;
}

export class Overlay {
  readonly gate = document.getElementById('gate') as HTMLDivElement;
  readonly hud = document.getElementById('hud') as HTMLDivElement;
  readonly panel = document.getElementById('panel') as HTMLElement;
  private hint = document.getElementById('hint') as HTMLDivElement;
  private source = document.getElementById('source') as HTMLElement & { value: string };
  private sourceNote = document.getElementById('source-note') as HTMLParagraphElement;
  private streamUrl = document.getElementById('stream-url') as HTMLInputElement;
  private fileInput = document.getElementById('file-input') as HTMLInputElement;
  private startBtn = document.getElementById('start') as HTMLElement;
  private gateError = document.getElementById('gate-error') as HTMLParagraphElement;
  private playBtn = document.getElementById('play') as HTMLElement;
  private beatDot = document.getElementById('beat') as HTMLSpanElement;
  private trackLabel = document.getElementById('track') as HTMLSpanElement;
  private fpsLabel = document.getElementById('fps') as HTMLSpanElement;
  hidden = true;
  private file: File | null = null;

  constructor(private handlers: OverlayHandlers) {
    this.streamUrl.value = DEFAULT_STREAM;
    this.updateSourceNote();
    this.source.addEventListener('change', () => this.updateSourceNote());
    this.fileInput.addEventListener('change', () => {
      this.file = this.fileInput.files?.[0] ?? null;
      this.updateSourceNote();
    });
    this.startBtn.addEventListener('click', () => void this.start());
    document.getElementById('gate-close')!.addEventListener('click', () => (this.gate.hidden = true));
    this.playBtn.addEventListener('click', () => handlers.onTogglePlay());
    document.getElementById('change-source')!.addEventListener('click', () => this.showGate());
    document.getElementById('settings')!.addEventListener('click', () => handlers.onToggleSettings());
    document.getElementById('mode')!.addEventListener('click', () => handlers.onToggleMode());
    document.getElementById('hide')!.addEventListener('click', () => this.setHidden(true));
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'h' || e.key === 'H') this.setHidden(!this.hidden);
      if (e.key === ' ') {
        e.preventDefault();
        handlers.onTogglePlay();
      }
      if (e.key === 'm' || e.key === 'M') handlers.onToggleMode();
      if (e.key === 'Escape') {
        if (!this.gate.hidden) this.gate.hidden = true;
        else if (this.hidden) this.setHidden(false);
      }
    });
    this.hud.classList.add('hidden');
  }

  private choice(): SourceKind {
    switch (this.source.value) {
      case 'Tab audio':
        return 'tab';
      case 'File':
        return 'file';
      case 'Mic':
        return 'mic';
      case 'Silent':
        return 'none';
      default:
        return 'stream';
    }
  }

  private updateSourceNote(): void {
    const v = this.source.value;
    this.sourceNote.textContent = SOURCE_NOTES[v] ?? '';
    this.streamUrl.hidden = v !== 'Stream';
    if (v === 'File') {
      this.sourceNote.textContent = this.file ? `Selected: ${this.file.name}` : SOURCE_NOTES.File;
    }
    this.gateError.hidden = true;
  }

  private async start(): Promise<void> {
    const kind = this.choice();
    if (kind === 'file' && !this.file) {
      this.fileInput.click();
      return;
    }
    this.gateError.hidden = true;
    this.startBtn.setAttribute('disabled', '');
    try {
      await this.handlers.onStart(kind, { url: this.streamUrl.value.trim(), file: this.file ?? undefined });
      this.gate.hidden = true;
      this.setHidden(false);
    } catch (err) {
      this.gateError.textContent = err instanceof Error ? err.message : String(err);
      this.gateError.hidden = false;
    } finally {
      this.startBtn.removeAttribute('disabled');
    }
  }

  showGate(): void {
    this.gate.hidden = false;
  }

  /** Called once the long press has lasted long enough. */
  reveal(): void {
    this.hint.classList.add('gone');
    this.setHidden(false);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.hud.classList.toggle('hidden', hidden);
    if (!hidden) this.hint.classList.add('gone');
  }

  setPanelOpen(open: boolean): void {
    this.panel.classList.toggle('closed', !open);
  }

  setPlaying(audio: AudioEngine): void {
    const live = audio.isLive;
    this.playBtn.setAttribute('icon', audio.playing || live ? 'pause' : 'play');
    this.playBtn.toggleAttribute('disabled', live || audio.kind === 'none');
    const labels: Record<SourceKind, string> = {
      stream: 'stream',
      tab: 'tab audio (live)',
      file: 'file',
      mic: 'microphone',
      none: 'silent',
    };
    let label = labels[audio.kind];
    if (audio.kind === 'stream') {
      try {
        const name = decodeURIComponent(audio.media.src.split('/').pop() ?? '');
        if (name) label = name.replace(/\.[a-z0-9]+$/i, '');
      } catch {
        /* keep generic label */
      }
    }
    this.trackLabel.textContent = label;
  }

  setBeat(env: number, hit: boolean): void {
    this.beatDot.style.setProperty('--beat', (0.6 + env * 0.9).toFixed(3));
    this.beatDot.classList.toggle('on', hit || env > 0.35);
  }

  setFps(fps: number, slow: boolean): void {
    this.fpsLabel.textContent = `${fps.toFixed(0)} fps`;
    this.fpsLabel.classList.toggle('slow', slow);
  }
}
