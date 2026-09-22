export interface DesktopBounds { x: number; y: number; width: number; height: number }
export interface DesktopWindow {
  id: string;
  processId: number;
  processName: string;
  title: string;
  bounds: DesktopBounds;
  minimized: boolean;
}
export interface DesktopElement {
  id: string;
  name: string;
  role: string;
  bounds: DesktopBounds;
  enabled: boolean;
  offscreen: boolean;
  value?: string;
}
export interface DesktopObservation {
  id: string;
  capturedAt: number;
  desktop: DesktopBounds;
  windows: DesktopWindow[];
  foregroundWindowId: string | null;
  selectedWindowId: string | null;
  elements: DesktopElement[];
  accessibilityError?: string;
}
export interface DesktopFrame {
  png: Buffer;
  bounds: DesktopBounds;
  capturedAt: number;
}
/** Coordinates always refer to physical pixels in the virtual Windows desktop. */
export type DesktopCommand =
  | { kind: 'focus'; windowId: string }
  | { kind: 'click'; windowId: string; x: number; y: number; button?: 'left' | 'right'; clicks?: 1 | 2 }
  | { kind: 'type'; windowId: string; text: string }
  | { kind: 'key'; windowId: string; keys: string[] }
  | { kind: 'scroll'; windowId: string; x: number; y: number; delta: number };

export interface DesktopDriver {
  readonly deviceSessionId: string;
  observe(windowId?: string | null): Promise<DesktopObservation>;
  screen(windowId?: string | null): Promise<DesktopFrame>;
  execute(command: DesktopCommand, expected: DesktopObservation, signal: AbortSignal, onIssued?: () => void): Promise<DesktopObservation>;
  release(): Promise<void>;
  close(): Promise<void>;
}
