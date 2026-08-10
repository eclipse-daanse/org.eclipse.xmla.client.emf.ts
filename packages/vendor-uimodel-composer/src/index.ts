// Package + Factory (für XMI-Loading)
export { UimodelPackage } from './generated/UimodelPackage';
export { UimodelFactory } from './generated/UimodelFactory';

// Main composer component
export { default as UIModelComposer } from './composers/UIModelComposer.vue';

// Individual composer components (for custom registration or extension)
export { default as FormViewComposer } from './composers/FormViewComposer.vue';
export { default as SectionViewComposer } from './composers/SectionViewComposer.vue';
export { default as TabViewComposer } from './composers/TabViewComposer.vue';
export { default as SummaryViewComposer } from './composers/SummaryViewComposer.vue';
export { default as TableViewComposer } from './composers/TableViewComposer.vue';
export { default as MasterDetailComposer } from './composers/MasterDetailComposer.vue';
export { default as WidgetComposer } from './composers/WidgetComposer.vue';
export { default as ComponentDispatcher } from './composers/ComponentDispatcher.vue';

// Composables
export { useVisibility } from './composables/useVisibility';
export { useWidgetConfig } from './composables/useWidgetConfig';
export { useValidation } from './composables/useValidation';
export type { ValidationResult } from './composables/useValidation';
export {
  useComposerRegistry,
  createComposerRegistry,
  COMPOSER_REGISTRY_KEY,
} from './composables/useComposerRegistry';
export type { ComposerRegistry } from './composables/useComposerRegistry';
export { useMapSelection, MAP_SELECTION_KEY } from './composables/useMapSelection';
export type { MapSelectionHandler } from './composables/useMapSelection';

// Utilities
export { resolveStyleChain, resolveStyleList } from './utils/resolveStyleChain';
export { evaluateBoolean, registerOclEvaluator } from './utils/evaluateExpression';

// Types
export type { ResolvedStyle } from './types/ResolvedStyle';
export type { UIModelContext } from './types/UIModelContext';

// Generated interfaces (re-exported for consumers)
export type { UIModel } from './generated/UIModel';
export type { Component } from './generated/Component';
export type { FormView } from './generated/FormView';
export type { SectionView } from './generated/SectionView';
export type { TabView } from './generated/TabView';
export type { TableView } from './generated/TableView';
export type { SummaryView } from './generated/SummaryView';
export type { MasterDetail } from './generated/MasterDetail';
export type { WidgetComponent } from './generated/WidgetComponent';
export type { InputWidget } from './generated/InputWidget';
export type { TextAreaWidget } from './generated/TextAreaWidget';
export type { NumberWidget } from './generated/NumberWidget';
export type { CheckboxWidget } from './generated/CheckboxWidget';
export type { DateWidget } from './generated/DateWidget';
export type { ComboboxWidget } from './generated/ComboboxWidget';
export type { SelectWidget } from './generated/SelectWidget';
export type { ReferenceLinkWidget } from './generated/ReferenceLinkWidget';
export type { Expression } from './generated/Expression';
export type { ValidationExpression } from './generated/ValidationExpression';
export type { ValidationMessageMapper } from './generated/ValidationMessageMapper';
export type { BaseStyle } from './generated/BaseStyle';
export type { LayoutStyle } from './generated/LayoutStyle';
export type { WidgetStyle } from './generated/WidgetStyle';
export { WidgetType } from './generated/WidgetType';
export { LayoutType } from './generated/LayoutType';
export { Severity } from './generated/Severity';
export { MapperExecutionOrder } from './generated/MapperExecutionOrder';

// Vega extension — separate import to avoid eager init before UIModel is registered

// Maps extension (QGIS-orientiert) — separate import to avoid eager init before UIModel is registered
