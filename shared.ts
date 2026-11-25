import type { FileClick, MachineState as ConnectionState, Profile } from '@lengmoxxl/sdk';
export type { Machine, Session } from '@lengmoxxl/sdk';

// The config this plugin accepts: main.ts declares a schema for the same fields.
export type Font = { family: string; size: number; lineHeight: number };
export type CodexSettings = { enabled: boolean; command: string; remoteCommand: string; port: number; args: string[] };
export type Settings = Profile & { font: Font; images: { maxCount: number }; codex: CodexSettings };
export const maxImageBytes = 16 * 1024 * 1024;
// A codex workspace runs its terminal locally (machineId 'local'); codex.machineId is the remote machine
// whose app-server does the work, and codex.cwd is the remote directory. No cwd yet means the prompt is up.
export interface Workspace { id: string; machineId: string; sessionId?: string; cwd?: string; name?: string; manual?: boolean; codex?: { machineId: string; cwd?: string } }
export interface MachineState extends ConnectionState { machineId: string }
export interface Config { workspaces: Workspace[]; active?: string }
export interface WangcaiAPI {
  click(sessionId: string, location: Pick<FileClick, 'path' | 'line' | 'column'>): Promise<void>;
  config(): Promise<Config>;
  states(): Promise<MachineState[]>;
  activity(sessionId: string): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  address(machineId: string): Promise<string>;
  codexOpen(id: string, cwd: string): Promise<void>;
  codexDirectories(id: string, path: string): Promise<string[]>;
  resolve(sessionId: string, paths: string[]): Promise<Record<string, string>>;
  image(sessionId: string, dataUrl: string): Promise<string>;
  onConfig(callback: (config: Config) => void): () => void;
  onState(callback: (state: MachineState) => void): () => void;
}
