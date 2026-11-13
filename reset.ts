import type { Terminal } from '@xterm/xterm';

// xterm 6.0.0: reset() drops both buffers without disposing their markers, and every OSC 8 link
// holds a marker in OscLinkService whose dispose closure keeps the whole old buffer alive, so
// each reset leaks a full scrollback. Clear the markers of both buffers first, the way clear()
// and the alt-buffer switch do: a fullscreen TUI sits on the alt screen while the normal buffer
// still holds links. clearAllMarkers is not public, so this reaches into the core.
export function resetTerminal(term: Terminal): void {
  const { buffers } = (term as unknown as {
    _core: { _bufferService: { buffers: Record<'normal' | 'alt', { clearAllMarkers(): void }> } };
  })._core._bufferService;
  buffers.normal.clearAllMarkers();
  buffers.alt.clearAllMarkers();
  term.reset();
}
