// Pure decision helpers for the <Drawer> + <ConfirmDialog> focus trap.
// The DOM-walking part lives here; the React effect that mounts the
// event listeners lives in the component.
//
// Trap rule: Tab from the last focusable wraps to the first, and
// Shift+Tab from the first wraps to the last. Escape closes (handled
// by the component, not here). When no focusable exists in the
// container, both wrappers return null and the component should focus
// the container itself.

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

// Returns the active wrap behaviour given the current focus +
// container. `null` means "nothing focusable, let the container
// itself catch focus".
export function nextFocusAfterTrap(
  container: HTMLElement,
  current: Element | null,
  direction: 'forward' | 'backward',
): HTMLElement | null {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    // offsetParent is null for display:none, but visibility:hidden
    // elements keep their offsetParent — check computed style too.
    (n) => n.offsetParent !== null && getComputedStyle(n).visibility !== 'hidden',
  )
  if (nodes.length === 0) return null
  if (current === null || !container.contains(current)) {
    return direction === 'forward' ? nodes[0]! : nodes[nodes.length - 1]!
  }
  const idx = nodes.indexOf(current as HTMLElement)
  if (idx < 0) return direction === 'forward' ? nodes[0]! : nodes[nodes.length - 1]!
  if (direction === 'forward') {
    return nodes[(idx + 1) % nodes.length]!
  }
  return nodes[(idx - 1 + nodes.length) % nodes.length]!
}
