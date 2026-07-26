/* ==========================================================================
   Keyboard shortcuts help overlay — press "?" anywhere outside a text
   field to see what's available.
   ========================================================================== */
const KEYBOARD_SHORTCUTS = [
  { keys: 'Space', desc: 'Play / pause the current video' },
  { keys: '← / →', desc: 'Skip back / forward 5 seconds' },
  { keys: 'F', desc: 'Toggle fullscreen' },
  { keys: 'M', desc: 'Mute / unmute' },
  { keys: 'Double-click video', desc: 'Toggle fullscreen' },
  { keys: '⌘/Ctrl + K', desc: 'Search your whole library' },
  { keys: 'Esc', desc: 'Close whatever modal or overlay is open' },
  { keys: '?', desc: 'Show this list' },
];

function renderKeyboardShortcutsList(){
  const listEl = document.getElementById('keyboardShortcutsList');
  if(!listEl) return;
  listEl.innerHTML = KEYBOARD_SHORTCUTS.map(s => `
    <div class="folder-row" style="justify-content:space-between; padding:8px 10px;">
      <span class="fr-name">${escapeHtml(s.desc)}</span>
      <span class="kbd-hint" style="pointer-events:none;">${escapeHtml(s.keys)}</span>
    </div>
  `).join('');
}

function openKeyboardShortcuts(){
  renderKeyboardShortcutsList();
  const backdrop = document.getElementById('keyboardShortcutsBackdrop');
  if(backdrop) backdrop.hidden = false;
}
function closeKeyboardShortcuts(){
  const backdrop = document.getElementById('keyboardShortcutsBackdrop');
  if(backdrop) backdrop.hidden = true;
}

function bindKeyboardShortcutsUI(){
  const backdrop = document.getElementById('keyboardShortcutsBackdrop');
  const closeBtn = document.getElementById('keyboardShortcutsClose');
  const openBtn = document.getElementById('keyboardShortcutsBtn');
  if(!backdrop) return;
  if(closeBtn) closeBtn.addEventListener('click', closeKeyboardShortcuts);
  backdrop.addEventListener('click', (e) => { if(e.target === backdrop) closeKeyboardShortcuts(); });
  if(openBtn) openBtn.addEventListener('click', openKeyboardShortcuts);

  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape' && !backdrop.hidden){ closeKeyboardShortcuts(); return; }
    if(e.key !== '?') return;
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    if(!backdrop.hidden){ closeKeyboardShortcuts(); return; }
    openKeyboardShortcuts();
  });
}