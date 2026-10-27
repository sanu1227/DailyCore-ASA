const root = '/assets/asa/';
export const SCENES = {
  studio: { label: 'MOON', base: root + 'moon.jpg' },
  casual: { label: 'CHOOM', base: root + 'choom.jpg' },
  rest: { label: 'SUPA DUPA LUV', base: root + 'supa-dupa-luv.jpg' }
};

// Preserve the interface and stored scene keys; animate the unmodified photograph only.
export function createPortrait(element, { scene = 'studio' } = {}) {
  const stage = element.querySelector('.seoa-portrait-stage');
  const base = stage.querySelector('.seoa-portrait-base');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = false, visible = true, disposed = false, sceneName;
  function refresh() {
    stage.dataset.expression = stage.dataset.frame = 'portrait';
    stage.classList.toggle('is-breathing', !disposed && enabled && visible && !document.hidden && !reducedMotion.matches && base.complete && base.naturalWidth > 0);
  }
  function setScene(value) {
    const next = Object.hasOwn(SCENES, value) ? value : 'studio';
    if (sceneName === next) return;
    sceneName = next; stage.dataset.scene = next;
    base.alt = '아사 · ' + SCENES[next].label + ' 공식 사진';
    base.src = SCENES[next].base;
    element.classList.remove('portrait-unavailable');
    refresh();
    element.dispatchEvent(new CustomEvent('portraitscenechange', { detail: next }));
  }
  base.addEventListener('load', () => { element.classList.remove('portrait-unavailable'); refresh(); });
  base.addEventListener('error', () => {
    if (sceneName !== 'studio') { setScene('studio'); return; }
    element.classList.add('portrait-unavailable'); refresh();
  });
  document.addEventListener('visibilitychange', refresh);
  reducedMotion.addEventListener('change', refresh);
  window.addEventListener('pagehide', event => { disposed = !event.persisted; stage.classList.remove('is-breathing'); });
  window.addEventListener('pageshow', refresh);
  setScene(scene);
  return {
    setScene,
    setVisible(value) { visible = value; refresh(); },
    setEnabled(value) { enabled = value; refresh(); },
    setBusy() {},
    reply() {}
  };
}
