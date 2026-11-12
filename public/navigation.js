// Keep route updates in order so a slow request cannot replace a newer page.
export function createPageRenderer(update, view) {
  const doc = view.ownerDocument, win = doc.defaultView;
  let queue = Promise.resolve(), latest = 0, previousRoute;
  return function render() {
    const ticket = ++latest, route = win.location.hash;
    const run = async () => {
      if (ticket !== latest) return;
      const changed = previousRoute !== undefined && previousRoute !== route;
      const reduced = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const commit = async () => {
        view.setAttribute('aria-busy', 'true');
        try { await update(); previousRoute = route; }
        finally { view.removeAttribute('aria-busy'); }
      };
      if (changed && !reduced && typeof doc.startViewTransition === 'function') {
        const transition = doc.startViewTransition(commit);
        transition.ready.catch(() => {}); // Browsers can skip an animation when the tab is hidden.
        transition.finished.catch(() => {});
        await transition.updateCallbackDone;
      } else {
        await commit();
        if (changed && !reduced) {
          view.getAnimations?.().forEach(animation => animation.cancel());
          view.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 160, easing: 'ease-out' });
        }
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };
}
