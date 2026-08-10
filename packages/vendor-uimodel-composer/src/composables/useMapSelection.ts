import { inject, type InjectionKey } from 'vue';
import type { EObject } from '@emfts/core';

/**
 * Called by MapViewComposer when a map feature is clicked, in addition to
 * writing any MapSelectionBinding back into the EMF model. Lets a Vue ancestor
 * react to selections (e.g. update a reactive ref driving a detail panel).
 *
 * @param feature   The clicked feature's underlying EObject (or undefined).
 * @param component The MapView component EObject.
 */
export type MapSelectionHandler = (
  feature: EObject | undefined,
  component: EObject
) => void;

export const MAP_SELECTION_KEY: InjectionKey<MapSelectionHandler> =
  Symbol('uimodelMapSelection');

/**
 * Access the map-selection handler provided by an ancestor, if any.
 */
export function useMapSelection(): MapSelectionHandler | null {
  return inject<MapSelectionHandler | null>(MAP_SELECTION_KEY, null);
}
