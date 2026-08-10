import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue';
import type { EObject } from '@emfts/core';
import type { Expression } from '../generated/Expression';
import { evaluateBoolean } from '../utils/evaluateExpression';

/**
 * Reactive visibility flag derived from a UIModel Expression.
 * Returns true if the expression is absent (default: visible).
 */
export function useVisibility(
  expression: MaybeRefOrGetter<Expression | undefined>,
  context: MaybeRefOrGetter<EObject>
): ComputedRef<boolean> {
  return computed(() => evaluateBoolean(toValue(expression), toValue(context)));
}
