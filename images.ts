import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Machine, MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';
import { maxImageBytes } from './shared';

const extensions: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/avif': 'avif',
};

export function registerImages(context: MainContext, hostOf: (sessionId: string) => { machine: Machine; node: MachineConnection } | undefined, maxCount: number) {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) throw new Error('images.maxCount must be a positive integer');
  const pending = new Map<string, Promise<string>>();
  return context.ui.handle('image', ({ sessionId, dataUrl }: { sessionId: string; dataUrl: string }) => {
    const host = hostOf(sessionId);
    if (!host) throw new Error('Machine is not connected');
    if (typeof dataUrl !== 'string') throw new Error('Invalid clipboard image');
    if (dataUrl.length > Math.ceil(maxImageBytes / 3) * 4 + 100) throw new Error('Image exceeds 16 MiB');
    const match = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    const extension = match && extensions[match[1]];
    if (!match || !extension || match[2].length % 4 !== 0) throw new Error('Invalid clipboard image');
    const data = match[2];
    if (Buffer.from(data, 'base64').length > maxImageBytes) throw new Error('Image exceeds 16 MiB');
    const { node, machine } = host;
    const result = (pending.get(machine.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const exec = async (script: string, ...args: string[]) => {
        const result = await node.subprocess.exec('/bin/sh', ['-c', script, 'wangcai-image', ...args], { cwd: '/' });
        if (result.code !== 0) throw new Error(Buffer.from(result.stderr).toString().trim() || 'Failed to cache clipboard image');
        return Buffer.from(result.stdout).toString();
      };
      const directory = await exec(`set -eu
test -n "$HOME"
umask 077
directory="$HOME/.cache/WangCai-terminal-agent/images"
case "$directory" in
  /*) ;;
  *) printf %s "Machine home must be an absolute path" >&2; exit 1 ;;
esac
mkdir -p "$directory"
printf %s "$directory"`);
      const name = `image-${Date.now()}-${randomUUID()}.${extension}`;
      const path = posix.join(directory, name);
      const temporary = `${path}.tmp`;
      try {
        await exec('umask 077; : > "$1"', temporary);
        // Exec has no stdin; aligned base64 chunks stay below OS argument limits.
        for (let offset = 0; offset < data.length; offset += 64 * 1024) {
          await exec('printf %s "$2" | base64 -d >> "$1"', temporary, data.slice(offset, offset + 64 * 1024));
        }
        await exec('mv -- "$1" "$2"', temporary, path);
        const older = (await node.fs.readDirectory(directory))
          .filter((entry) => !entry.isDirectory && entry.name !== name && /^image-\d+-[0-9a-f-]+\.(png|jpg|gif|webp|bmp|tiff|svg|avif)$/.test(entry.name))
          .map((entry) => entry.name).sort();
        const expired = older.slice(0, Math.max(0, older.length - maxCount + 1));
        for (let offset = 0; offset < expired.length; offset += 100) {
          await exec('rm -f -- "$@"', ...expired.slice(offset, offset + 100).map((name) => posix.join(directory, name)));
        }
        return path;
      } catch (error) {
        await exec('rm -f -- "$1" "$2"', temporary, path).catch(() => {});
        throw error;
      }
    });
    pending.set(machine.id, result);
    void result.finally(() => { if (pending.get(machine.id) === result) pending.delete(machine.id); }).catch(() => {});
    return result;
  });
}
