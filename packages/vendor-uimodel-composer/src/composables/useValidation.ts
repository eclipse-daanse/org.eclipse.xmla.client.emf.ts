import { computed, type ComputedRef, type MaybeRefOrGetter, toValue } from 'vue';
import type { EObject } from '@emfts/core';
import type { ValidationExpression } from '../generated/ValidationExpression';
import { evaluateBoolean } from '../utils/evaluateExpression';

export type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'FATAL';

export interface ValidationResult {
  valid: boolean;
  message: string;
  severity: Severity;
}

/**
 * Evaluates a list of ValidationExpressions against a domain EObject.
 * Returns the first failing validation, or null if all pass.
 */
export function useValidation(
  validations: MaybeRefOrGetter<ValidationExpression[]>,
  context: MaybeRefOrGetter<EObject>
): ComputedRef<ValidationResult | null> {
  return computed(() => {
    const ctx = toValue(context);
    for (const v of toValue(validations)) {
      try {
        const passes = evaluateBoolean(v, ctx);
        if (!passes) {
          return {
            valid: false,
            message: v.defaultMessage ?? 'Ungültiger Wert.',
            severity: (v.severity as Severity | undefined) ?? 'ERROR',
          };
        }
      } catch {
        // evaluation error → treat as valid (fail-open)
      }
    }
    return null;
  });
}
