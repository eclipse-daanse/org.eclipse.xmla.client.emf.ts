import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue';
import type { WidgetComponent } from '../generated/WidgetComponent';
import { resolveStyleList } from '../utils/resolveStyleChain';
import type { ResolvedStyle } from '../types/ResolvedStyle';

/**
 * Resolves the effective display configuration for a WidgetComponent.
 * Merges the style chain with the widget's own overrides.
 */
export function useWidgetConfig(
  widget: MaybeRefOrGetter<WidgetComponent>
): ComputedRef<ResolvedStyle> {
  return computed(() => {
    const w = toValue(widget);
    const fromStyles = resolveStyleList(w.styles);

    // Direct widget attributes take precedence over style chain
    return {
      ...fromStyles,
      ...(w.label !== undefined ? { label: w.label } : {}),
      ...(w.readOnly !== undefined ? { readOnly: w.readOnly } : {}),
    };
  });
}
