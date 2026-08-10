import { inject, type Component } from 'vue';

/**
 * Registry that maps UIModel component EClass names to their Vue composer components.
 * Separate from the domain ComponentRegistry to avoid conflicts.
 */
export interface ComposerRegistry {
  getComposer(eclassName: string): Component | undefined;
  register(eclassName: string, component: Component): void;
}

export const COMPOSER_REGISTRY_KEY = Symbol('uimodelComposerRegistry');

/**
 * Access the ComposerRegistry injected by UIModelComposer.
 */
export function useComposerRegistry(): ComposerRegistry {
  const registry = inject<ComposerRegistry>(COMPOSER_REGISTRY_KEY);
  if (!registry) {
    throw new Error(
      '[uimodel-composer] No ComposerRegistry provided. ' +
        'Make sure UIModelComposer is an ancestor of this component.'
    );
  }
  return registry;
}

/**
 * Create a new ComposerRegistry instance.
 */
export function createComposerRegistry(
  initial?: Record<string, Component>
): ComposerRegistry {
  const map = new Map<string, Component>(
    initial ? Object.entries(initial) : []
  );

  return {
    getComposer(eclassName) {
      return map.get(eclassName);
    },
    register(eclassName, component) {
      map.set(eclassName, component);
    },
  };
}
