import { builtinPricing, Pricing } from './pricing-view.js';
import { builtinRegistry, Registry } from './registry.js';

/**
 * The registry and the prices the rest of the AI code reads (config, catalog view, provider construction, estimates). They start as
 * the built-in ones, which are exactly the original catalog, so nothing behaves differently until the gateway installs a store's
 * registry. Replacing one is a single assignment of an already validated object: there is never a half-loaded state.
 */
let active: Registry = builtinRegistry();
let pricing: Pricing | null = null;
/**
 * Counts every time a different registry was installed. The dashboard's state poll carries it, so a page that fetched the model
 * catalog earlier knows when to fetch it again (a model added, switched off or removed) instead of showing a stale dropdown.
 */
let revision = 1;

export function activeRegistryRevision(): number {
  return revision;
}

export function activeRegistry(): Registry {
  return active;
}

export function setActiveRegistry(registry: Registry): void {
  active = registry;
  revision++;
}

/** Prices are optional and separate: until a pricing store is installed these are the built-in prices. */
export function activePricing(): Pricing {
  pricing ??= builtinPricing();
  return pricing;
}

export function setActivePricing(next: Pricing): void {
  pricing = next;
}

export function resetActiveRegistry(): void {
  active = builtinRegistry();
  pricing = null;
  revision++;
}
