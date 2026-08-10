import type { EObject } from '@emfts/core';
import type { Expression } from '../generated/Expression';

/**
 * Wraps an EObject in a Proxy that allows string-based property access
 * by delegating to eClass().getEStructuralFeature(name) + eGet(feature).
 * This enables OCL/JS expressions like `self.firstName` to work on DynamicEObjects.
 */
function wrapEObject(context: EObject): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(context as any, {
    get(target, prop) {
      if (typeof prop !== 'string') return target[prop];
      // Wrap eGet so the OCL evaluator can call eGet('featureName') with a string
      if (prop === 'eGet') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (featureOrName: any) => {
          if (typeof featureOrName === 'string') {
            const f = target.eClass?.()?.getEStructuralFeature?.(featureOrName);
            return f ? target.eGet(f) : undefined;
          }
          return target.eGet(featureOrName);
        };
      }
      if (prop in target) return target[prop];
      // String-based feature access: self.firstName → eGet(feature)
      const feature = target.eClass?.()?.getEStructuralFeature?.(prop);
      if (feature) return target.eGet(feature);
      return undefined;
    }
  });
}

/**
 * Evaluates an Expression against an EObject context.
 * Returns true if the expression is absent (default: visible/valid).
 */
export function evaluateBoolean(
  expression: Expression | undefined,
  context: EObject
): boolean {
  if (!expression) return true;

  try {
    switch (expression.language) {
      case 'OCL':
        return evaluateOcl(expression.body, context);
      case 'AQL':
        return evaluateAql(expression.body, context);
      case 'JS':
        return evaluateJs(expression.body, context);
      default:
        console.warn(`[uimodel-composer] Unknown expression language: ${expression.language}`);
        return true;
    }
  } catch (e) {
    console.error(`[uimodel-composer] Expression evaluation failed (${expression.language}):`, e);
    return true;
  }
}

function evaluateOcl(body: string, context: EObject): boolean {
  // Delegate to @emfts/ocl EMFOclValidator
  // Lazy import to keep @emfts/ocl as optional peer dependency
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { EMFOclValidator } = (globalThis as any).__emftsOcl__ ?? {};
    if (!EMFOclValidator) {
      console.warn('[uimodel-composer] @emfts/ocl not registered. Call registerOclEvaluator() during setup.');
      return true;
    }
    const validator = new EMFOclValidator();
    const result = validator.evaluateExpression(body, wrapEObject(context));
    return result === true;
  } catch {
    return true;
  }
}

function evaluateAql(_body: string, _context: EObject): boolean {
  console.warn('[uimodel-composer] AQL evaluation not yet implemented.');
  return true;
}

function evaluateJs(body: string, context: EObject): boolean {
  // eslint-disable-next-line no-new-func
  const fn = new Function('self', `"use strict"; return (${body});`);
  const result = fn(wrapEObject(context));
  return Boolean(result);
}

/**
 * Register the @emfts/ocl EMFOclValidator for OCL expression evaluation.
 * Call once during application setup.
 */
export function registerOclEvaluator(EMFOclValidator: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__emftsOcl__ = { EMFOclValidator };
}
