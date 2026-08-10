import type { BaseStyle } from '../generated/BaseStyle';
import type { LayoutStyle } from '../generated/LayoutStyle';
import type { WidgetStyle } from '../generated/WidgetStyle';
import type { ResolvedStyle } from '../types/ResolvedStyle';

/**
 * Resolves the full extends-chain of a BaseStyle into a flat ResolvedStyle.
 * Child values override parent values (like CSS cascade / SCSS @extend).
 * Cycle-safe: tracks visited styles to prevent infinite loops.
 */
export function resolveStyleChain(
  style: BaseStyle | undefined,
  visited = new Set<BaseStyle>()
): ResolvedStyle {
  if (!style) return {};
  if (visited.has(style)) return {};

  visited.add(style);

  const parent = style.extends
    ? resolveStyleChain(style.extends, visited)
    : {};

  const own = extractStyleValues(style);

  return merge(parent, own);
}

/**
 * Resolves multiple styles in order (like multiple CSS classes).
 * Later styles override earlier ones.
 */
export function resolveStyleList(styles: BaseStyle[]): ResolvedStyle {
  return styles.reduce<ResolvedStyle>(
    (acc, style) => merge(acc, resolveStyleChain(style)),
    {}
  );
}

function extractStyleValues(style: BaseStyle): ResolvedStyle {
  const result: ResolvedStyle = {};

  if (style.css !== undefined) result.css = style.css;
  if (style.vueComponent !== undefined) result.vueComponent = style.vueComponent;

  const layoutStyle = style as LayoutStyle;
  if (layoutStyle.layout !== undefined) result.layout = layoutStyle.layout;
  if (layoutStyle.order !== undefined) result.order = layoutStyle.order;

  const widgetStyle = style as WidgetStyle;
  if (widgetStyle.widgetType !== undefined) result.widgetType = widgetStyle.widgetType;
  if (widgetStyle.label !== undefined) result.label = widgetStyle.label;
  if (widgetStyle.readOnly !== undefined) result.readOnly = widgetStyle.readOnly;
  if ((widgetStyle as WidgetStyle & { order?: number }).order !== undefined) {
    result.order = (widgetStyle as WidgetStyle & { order?: number }).order;
  }

  return result;
}

function merge(parent: ResolvedStyle, child: ResolvedStyle): ResolvedStyle {
  return {
    ...parent,
    ...Object.fromEntries(
      Object.entries(child).filter(([, v]) => v !== undefined)
    ),
    // Merge CSS classes (append, not replace)
    css: [parent.css, child.css].filter(Boolean).join(' ') || undefined,
  };
}
