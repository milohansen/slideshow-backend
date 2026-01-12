## TypeScript Code Standards

- Always prefer `const` over `let` and `let` over `var`.
- Always use `type` aliases for object shapes instead of `interface` unless you need to use `extends` or `implements`.
- Use explicit return types for all functions and methods.
- Prefer `type[]` over `Array<type>` for array types.
- Use `readonly` modifier for properties that should not be reassigned.
- Never use the `any` type; prefer `unknown` if the type is not known.
- Use `null` and `undefined` explicitly; avoid using them interchangeably.