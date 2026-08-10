import type { MatchContext } from '@emfts/vue-registry';
import type { WidgetComponent } from '../generated/WidgetComponent';
import type { ResolvedStyle } from './ResolvedStyle';

/**
 * Extended MatchContext that carries the resolved uimodel widget configuration.
 * Passed via MatchContext.custom to allow Vue components to adapt their rendering.
 */
export interface UIModelContext extends MatchContext {
  custom: {
    /** The resolved, flattened style configuration */
    resolvedStyle: ResolvedStyle;
    /** The raw WidgetComponent EObject from the uimodel */
    rawWidget: WidgetComponent;
  };
}
