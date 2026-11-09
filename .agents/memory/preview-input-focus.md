---
name: Preview input focus
description: Distinguish Preview element-selection focus interception from sign-in failures.
---
When typing in an embedded Preview instead goes to the Agent prompt, check whether Replit's Visual Editor element-selection mode is active before changing authentication code.

**Why:** The user reported that Clerk login worked in a new tab but typing in Preview went to the prompt. They confirmed the guidance to exit selection mode resolved the issue.

**How to apply:** Exit selection mode with Escape or close the editing panel, then click the input again. Do not add app-side focus overrides for workspace-level interception.
