---
name: Code generation runtime versions
description: Why API code generation must explicitly match consumer runtime versions.
---
Keep API code-generator runtime versions explicit when the spec package does not declare the libraries used by generated consumers.

**Why:** The generator detected dependencies from the spec package rather than the React client and silently selected React Query v4 despite the app using v5. This produced incompatible generated option types. Version detection is not reliable across this workspace's package boundaries.

**How to apply:** Match generation settings to the installed consumer runtime, rather than accepting auto-detection warnings. Generated browser helpers that iterate Headers also require DOM iterable TypeScript libraries; do not hand-edit generated helpers to hide missing library declarations.
