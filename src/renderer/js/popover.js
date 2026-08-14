// A small panel that hangs above a button in the control bar.
//
// Two controls need one — the speed picker and the skip-amount editor — so it
// exists once here rather than twice in the bar. It owns placement and nothing
// else: callers hand it markup and receive back the data-cmd that was clicked.
//
// Deliberately not the settings menu. That one is a stack of pages anchored to
// the corner; this is a single tray anchored to whichever button opened it, and
// it stays open while you use it so several speeds can be tried in a row.

export class BarPopover {
  constructor(host, { onCommand } = {}) {
    this.host = host;
    this.onCommand = onCommand || (() => {});
    this.open = false;
    this.key = null;      // which control opened it
    this.anchor = null;

    this.root = document.createElement('div');
    this.root.className = 'barpop';
    this.root.hidden = true;
    host.appendChild(this.root);

    // The bar sits over the video surface, where a press means play/pause.
    this.root.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.root.addEventListener('dblclick', (event) => event.stopPropagation());

    this.root.addEventListener('click', (event) => {
      const node = event.target.closest('[data-cmd]');
      if (!node || !this.root.contains(node)) return;
      event.stopPropagation();
      // Buttons inside keep focus off, so the space bar still means play/pause.
      node.blur();
      this.onCommand(node.dataset.cmd, node.dataset.value, this.key);
    });
  }

  show(key, anchor, html) {
    this.key = key;
    this.anchor = anchor;
    this.root.innerHTML = html;
    this.root.hidden = false;
    this.open = true;
    this.root.classList.add('is-open');
    // Width is unknown until it is in the document.
    requestAnimationFrame(() => this.position());
  }

  // Re-renders in place. Picking a speed should leave the tray open with the new
  // choice marked, not dismiss it just as you started comparing.
  setContent(html) {
    if (!this.open) return;
    this.root.innerHTML = html;
    this.position();
  }

  position() {
    if (!this.open || !this.anchor) return;
    const hostRect = this.host.getBoundingClientRect();
    const anchorRect = this.anchor.getBoundingClientRect();
    if (hostRect.width <= 0) return;

    const width = this.root.offsetWidth || 200;
    const margin = 4;
    const centre = anchorRect.left + anchorRect.width / 2 - hostRect.left;
    const furthest = Math.max(margin, hostRect.width - width - margin);
    this.root.style.left = `${Math.min(Math.max(centre - width / 2, margin), furthest)}px`;
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.key = null;
    this.anchor = null;
    this.root.classList.remove('is-open');
    this.root.hidden = true;
  }

  // Clicking the button that opened it closes it again; clicking a different
  // button swaps the contents rather than stacking a second tray.
  toggle(key, anchor, html) {
    if (this.open && this.key === key) this.hide();
    else this.show(key, anchor, html);
  }
}
