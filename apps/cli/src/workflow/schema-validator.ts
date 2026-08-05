/**
 * Lightweight JSON Schema validator for workflow agent() schema parameter.
 *
 * Supports:
 *   - type: string | number | integer | boolean | object | array
 *   - properties (objects), items (arrays), required, enum
 *   - Nested objects and arrays (recursive validation)
 *
 * Zero external dependencies — pure TypeScript implementation.
 */

export interface ValidationError {
  path: string // JSON path to the error, e.g. "$.name" or "$.items[0].value"
  message: string
}

/**
 * Validate `data` against a JSON Schema definition.
 * Returns an array of ValidationError — empty means valid.
 */
export function validateJSONSchema(
  data: unknown,
  schema: Record<string, unknown>,
): ValidationError[] {
  const errors: ValidationError[] = []
  _validate(data, schema, '$', errors)
  return errors
}

/**
 * Format validation errors into a human-readable message for LLM feedback.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return ''
  return errors.map((e) => `  • ${e.path}: ${e.message}`).join('\n')
}

// ── Internal recursive validator ──

function _validate(
  data: unknown,
  schema: Record<string, unknown>,
  path: string,
  errors: ValidationError[],
): void {
  const type = schema.type as string | undefined

  // ── Null check ──
  if (data === null || data === undefined) {
    // If required, the parent object handles this. Here we just check type mismatch.
    if (type && type !== 'null') {
      errors.push({ path, message: `expected ${type}, got null` })
    }
    return
  }

  // ── Type checking ──
  if (type) {
    const actualType = Array.isArray(data) ? 'array' : typeof data
    const expectedType = type === 'integer' ? 'number' : type

    if (expectedType === 'number' && actualType === 'number') {
      // OK — integer is a subset of number
    } else if (expectedType !== actualType) {
      errors.push({ path, message: `expected type "${type}", got "${actualType}"` })
      return // Can't validate further if type is wrong
    }

    // Integer check
    if (type === 'integer' && !Number.isInteger(data)) {
      errors.push({ path, message: `expected integer, got ${data}` })
    }
  }

  // ── Enum validation ──
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path,
        message: `value must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      })
    }
  }

  // ── Object validation ──
  if (type === 'object' || (!type && typeof data === 'object' && !Array.isArray(data))) {
    const obj = data as Record<string, unknown>
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
    const required = schema.required as string[] | undefined

    // Required fields
    if (required) {
      for (const field of required) {
        if (obj[field] === undefined || obj[field] === null) {
          errors.push({ path: `${path}.${field}`, message: `required field is missing` })
        }
      }
    }

    // Property validation
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        const value = obj[key]
        if (value !== undefined && value !== null) {
          _validate(value, propSchema, `${path}.${key}`, errors)
        }
      }
    }
  }

  // ── Array validation ──
  if (type === 'array' || (!type && Array.isArray(data))) {
    const arr = data as unknown[]
    const items = schema.items as Record<string, unknown> | undefined

    if (items) {
      for (let i = 0; i < arr.length; i++) {
        _validate(arr[i], items, `${path}[${i}]`, errors)
      }
    }

    // minItems / maxItems
    if (schema.minItems !== undefined && arr.length < (schema.minItems as number)) {
      errors.push({
        path,
        message: `array has ${arr.length} items, minimum is ${schema.minItems}`,
      })
    }
    if (schema.maxItems !== undefined && arr.length > (schema.maxItems as number)) {
      errors.push({
        path,
        message: `array has ${arr.length} items, maximum is ${schema.maxItems}`,
      })
    }
  }

  // ── String validation ──
  if ((type === 'string' || typeof data === 'string') && typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < (schema.minLength as number)) {
      errors.push({
        path,
        message: `string length ${data.length} is less than minimum ${schema.minLength}`,
      })
    }
    if (schema.maxLength !== undefined && data.length > (schema.maxLength as number)) {
      errors.push({
        path,
        message: `string length ${data.length} exceeds maximum ${schema.maxLength}`,
      })
    }
  }

  // ── Number validation ──
  if ((type === 'number' || type === 'integer') && typeof data === 'number') {
    if (schema.minimum !== undefined && data < (schema.minimum as number)) {
      errors.push({ path, message: `value ${data} is less than minimum ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && data > (schema.maximum as number)) {
      errors.push({ path, message: `value ${data} exceeds maximum ${schema.maximum}` })
    }
  }
}
