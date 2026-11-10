---
name: OpenAPI parameter collisions
description: A generator naming constraint when an operation has both path parameters and query filters.
---

Check generated exports when adding an operation with both path parameters and query filters. The current generator can give its Zod path-parameter schema and TypeScript query-parameter interface the same exported name.

**Why:** A filtered activity endpoint generated this duplicate-export failure even though OpenAPI generation itself succeeded. A query-only filtered collection avoided the ambiguity without modifying generated files.

**How to apply:** Run the complete codegen command before integrating consumers. If this collision appears, use distinct generation names where supported or a suitable query-only collection contract; never hand-edit generated output.
