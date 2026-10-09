import type { FileClick, MachineState as ConnectionState, Profile, TerminalEvent } from '@lengmoxxl/sdk';
export type { Machine, Session } from '@lengmoxxl/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type Settings = Profile & { font: Font };
export interface Workspace { id: string; machineId: string; sessionId?: string; cwd?: string; name?: string }
export interface MachineState extends ConnectionState { machineId: string }
export interface Config { workspaces: Workspace[]; active?: string }
export interface WangcaiAPI {
  click(sessionId: string, location: Pick<FileClick, 'path' | 'line' | 'column'>): Promise<void>;
  config(): Promise<Config>;
  states(): Promise<MachineState[]>;
  selectWorkspace(id: string): Promise<void>;
  pty(op: string, sessionId: string, params?: Record<string, unknown>): Promise<unknown>;
  resolve(sessionId: string, paths: string[]): Promise<Record<string, string>>;
  onConfig(callback: (config: Config) => void): () => void;
  onState(callback: (state: MachineState) => void): () => void;
  onTerminal(callback: (event: TerminalEvent) => void): () => void;
}
