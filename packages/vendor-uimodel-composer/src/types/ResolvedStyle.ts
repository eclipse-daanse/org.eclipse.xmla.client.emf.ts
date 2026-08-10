import type { LayoutType } from '../generated/LayoutType';
import type { WidgetType } from '../generated/WidgetType';

/**
 * Flattened, fully resolved style after applying the extends-chain.
 * Child values override parent values (like CSS cascade).
 */
export interface ResolvedStyle {
  css?: string;
  vueComponent?: string;
  // LayoutStyle
  layout?: LayoutType;
  order?: number;
  // WidgetStyle
  widgetType?: WidgetType;
  label?: string;
  readOnly?: boolean;
}
