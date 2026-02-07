# GitHub Copilot Instructions for H5-chatflow-new

This document provides context and guidelines for AI agents working on the `H5-chatflow-new` codebase.

---

## 🚨 ABSOLUTE TOP PRIORITY — Four Inviolable Rules

> **The following four rules have the HIGHEST execution priority. Regardless of change size, user instruction clarity, or time pressure, they MUST be strictly followed.**
>
> **⛔ Violating ANY of these → Immediately stop the current operation, revert all changes made, and restart from SOP Step 1. Excuses such as "the change is small", "user intent is clear", or "it's just one line" are NOT acceptable.**

### Rule 0: MUST Chunk Long/Complex Tasks (Anti-Timeout — HIGHEST PRIORITY)

> **⚠️ This rule exists to prevent catastrophic session termination caused by network timeouts during large operations. A single over-long tool call or response can crash the entire session, losing ALL progress. This has happened repeatedly and MUST be prevented at the architectural level.**

**ANY task that involves modifying more than ~80 lines of code in a single tool call, or generating a response exceeding ~200 lines, MUST be decomposed into smaller atomic steps.**

#### Mandatory Chunking Rules:

1.  **Single Tool Call Size Limit:**
    - Each `replace_string_in_file` or `create_file` call MUST NOT generate/replace more than **80 lines of code** at a time.
    - If the target replacement is larger, split it into 2-4 sequential smaller replacements, each targeting a distinct section (e.g., CSS first, then HTML structure, then JS logic).
    - **Absolutely forbidden:** Replacing an entire function body of 200+ lines in one call. Break it down.

2.  **Multi-File Change Decomposition:**
    - When modifying 4+ files, complete and validate files **one at a time** (or in small logical batches of 2-3 related files).
    - After each batch, run `get_errors` to validate before proceeding.
    - Do NOT attempt to modify all files in a single pass.

3.  **Large HTML/Template String Handling (CRITICAL):**
    - Inline HTML templates (e.g., `getStatsHtml()`, `getGuideHtml()`) that exceed 100 lines MUST be modified **section by section**:
      - Step 1: CSS styles
      - Step 2: HTML structure
      - Step 3: JavaScript logic
    - NEVER replace the entire template in one call. This is the #1 cause of timeout failures.

4.  **Response Length Control:**
    - Keep each assistant response concise. If the work involves many steps, execute them across multiple tool calls rather than generating a massive single response.
    - Prefer showing **progress incrementally** (e.g., "✅ Step 1/5 done, proceeding to Step 2...") over batching everything into one giant output.

5.  **Proactive Chunking Declaration:**
    - Before starting any complex task, the AI MUST explicitly declare the chunking plan. Example:
      > "This task involves ~300 lines of changes across 5 files. I'll split it into 6 steps:
      > 1. Update types.ts (15 lines)
      > 2. Update config.ts (10 lines)
      > 3. Update HTML CSS section (60 lines)
      > 4. Update HTML body section (50 lines)
      > 5. Update JS logic section (70 lines)
      > 6. Compile check + fix errors"
    - This plan MUST be visible to the user before execution begins.

6.  **Timeout Recovery Protocol:**
    - If a previous session was terminated due to timeout, the AI MUST:
      a. First scan all modified files to determine what was already completed.
      b. Use `get_errors` to check current compilation status.
      c. Resume from the exact point of interruption — do NOT restart from scratch.
      d. Apply the chunking rules above to prevent the same timeout from recurring.

> **⛔ Generating a single tool call or response that exceeds the size limits above = violation. "The change is logically one unit" is NOT an excuse — network infrastructure does not care about logical coherence, it cares about payload size.**

### Rule 1: MUST Use Sequential Thinking (corresponds to SOP §2)

**For ANY requirement involving code modification, BEFORE writing any code, MUST invoke the `sequential-thinking` tool for logical deduction.**

- Deduction covers but is not limited to: impact scope, potential side effects, type conflicts, performance risks.
- Even if the modification is a single line of code, this step MUST be executed. The purpose is to prevent "looks simple but has chain reactions" pitfalls.
- Skipping this step = violation = immediately stop and redo from scratch.

### Rule 2: MUST Confirm Plan Before Modifying (corresponds to SOP §3)

**For ANY requirement involving code modification, BEFORE executing the modification, MUST use `mcp_feedback_ask_user` to confirm the implementation plan with the user.**

- The confirmation MUST include: which files to modify, specific changes, and Impact Analysis.
- "Modify first, ask later" is NOT allowed. MUST "ask first, modify later".
- Even if the user's instruction is already clear and unambiguous (e.g., "change 0.7 to 0.6"), confirmation is still required — because the purpose is not just disambiguation, but to let the user see the Impact Analysis.
- **Exception for pure UI styling:** Changes that ONLY involve visual styling (e.g., colors, spacing, font sizes) with NO logic or state modifications MAY be deferred and confirmed together with the next logic-related change in a single batch confirmation. This keeps the workflow fluid while still enforcing the confirmation gate for all logic changes.

### Rule 3: MUST Request Approval After Modifying (corresponds to §B)

**After each code modification is completed, MUST use `mcp_feedback_ask_user` to request explicit user approval.**

- Ending a task without explicit user approval ("OK", "Approved", "Confirm", etc.) = violation.
- Even for a single-line code change, the approval flow is mandatory.
- "Thanks", silence, or vague responses ≠ approval.

---

## 🧠 Role & SOP (Strict Operation Procedure)

**Role:** Senior Architect & Requirement Analyst & Senior Frontend Developer

**When the user presents a development requirement, DO NOT generate code immediately.**

**SOP:**

1.  **Deep Context Scan:** For complex or multi-file tasks, use file reading tools to read all involved files (parent components, API definitions, utility functions, etc.).
2.  **Sequential Thinking (CRITICAL — Rule 1):** Use the `sequential-thinking` tool to perform logical deduction. Analyze potential side effects, type definition conflicts, and performance bottlenecks. **⛔ Skipping this step = violation = immediately stop the current operation, revert all changes, and restart from Step 1. Not allowed to skip even for a single-line change.**
3.  **Confirm Key Decisions (CRITICAL — Rule 2):** **For ANY requirement involving code modification**, BEFORE executing the modification, **MUST** use the `mcp_feedback_ask_user` tool to confirm the implementation plan with the user. The confirmation MUST include: files to modify, specific changes, and Impact Analysis. **⛔ Modifying code without confirmation = violation = immediately stop and redo. "Modify first, ask later" is NOT allowed.**
4.  **Final Execution:** Only generate final `.vue` or `.ts` code after the user confirms the plan.

### 📋 Pre-Flight Checklist

> **For every reply involving code modification, ALL items below MUST be completed before making any changes. Missing any item = modification NOT allowed.**

- [ ] ✅ **Chunking plan declared** — If total changes exceed 80 lines, a step-by-step chunking plan has been explicitly stated (see Rule 0)
- [ ] ✅ **sequential-thinking executed** — Logical deduction completed via the `sequential-thinking` tool, impact scope and potential risks analyzed
- [ ] ✅ **Impact scope checked** — All directly/indirectly affected files identified, all consumers of shared types/interfaces checked
- [ ] ✅ **Plan confirmed** — Implementation plan + Impact Analysis presented to user via `mcp_feedback_ask_user` dialog, user confirmation received
- [ ] ✅ **Modification completed** — Code changes executed (in chunks if applicable)
- [ ] ✅ **Post-edit validation passed** — File integrity verified via `get_errors` tool (see §Post-Edit Validation below)
- [ ] ✅ **Approval requested** — Explicit user approval requested via `mcp_feedback_ask_user` ("OK", "Approved", "Confirm", etc.)

### 🔒 Post-Edit Validation (MANDATORY — applies to ALL models)

> **Core Principle: Every file edit MUST be followed by a structural integrity check. "Edit and forget" is strictly forbidden. This rule exists because certain models (e.g., Gemini) are prone to producing malformed output — missing closing brackets `}`, `]`, `)`, unmatched tags `</template>`, `</script>`, `</style>`, or corrupted file endings. ALL models MUST comply regardless of perceived reliability.**

**After EVERY file modification (no matter how small), the following validation steps are MANDATORY:**

1.  **Syntax & Structure Check:**

    - Call the `get_errors` tool on every modified file to detect compile errors, lint errors, or syntax issues.
    - For **JSON files** (e.g., `settings.json`, `package.json`, `tsconfig.json`): Verify that all `{` have matching `}`, all `[` have matching `]`, and no trailing commas exist before closing brackets.
    - For **Vue SFC files** (`.vue`): Verify that `<template>`, `<script>`, and `<style>` tags are properly opened AND closed. Ensure no duplicate or orphaned closing tags exist.
    - For **TypeScript/JavaScript files**: Verify that all function bodies, class bodies, if/else blocks, and arrow functions have matching closing braces.

2.  **If Errors Are Detected:**

    - **DO NOT** proceed to the approval step.
    - **DO NOT** ask the user to manually fix the issue.
    - **Immediately self-repair**: Fix the structural error, then re-run `get_errors` to confirm the fix.
    - Repeat until zero structural errors remain.
    - Only then proceed to the approval step (`mcp_feedback_ask_user`).

3.  **Common Failure Patterns to Watch For:**

    - ❌ Missing closing `}` at the end of a JSON file after appending new properties.
    - ❌ Extra/duplicate closing `}` or `]` from a bad `replace_string_in_file` operation.
    - ❌ `</script>` or `</template>` tag lost when editing a `.vue` file's middle section.
    - ❌ Indentation corruption causing nested blocks to become syntactically invalid.
    - ❌ Trailing comma before `}` or `]` in JSON (invalid JSON syntax).

4.  **Special Attention for `replace_string_in_file` Operations:**
    - When replacing content near the **end of a file**, ALWAYS verify that the file's final closing bracket/brace is preserved.
    - When performing **multi-replace** operations, validate after ALL replacements are complete, not just after the first one.
    - When the `oldString` includes a closing delimiter (`}`, `]`, `</template>`), the `newString` MUST also include the same closing delimiter — unless the intent is explicitly to remove it.

> **⛔ Skipping post-edit validation = violation = same severity as skipping sequential-thinking. The task MUST NOT be considered complete until `get_errors` returns clean results for ALL modified files.**

## 🏗 Architecture & Tech Stack

- **Framework:** Vue 3 (Composition API, Script Setup), TypeScript, Vite.
- **UI Library:** Element Plus (auto-imported), Tailwind CSS (v4), SCSS.
- **State Management:** Pinia (`src/stores`).
- **Routing:** Vue Router (`src/router`).
- **Specialized Libs:**
  - `@vue-flow/*` for the flow chart editor (`src/views/chatFlow`).
  - `@tiptap/*` for rich text editing (`src/components/editor`).
  - `@ffmpeg/*` for video processing.
  - `postcss-px-to-viewport` for H5 mobile adaptation.
- **Icons:** `unplugin-icons` & Custom `<SvgIcon>` component.

## 📐 Project Conventions

### 1. Vue 3 & Component Structure

- **Syntactic Sugar:** Always use `<script setup lang="ts">`.
- **Auto Imports:** Rely on `unplugin-auto-import` and `unplugin-vue-components`.
  - **DO NOT** manually import: `ref`, `reactive`, `computed`, `watch`, `onMounted`, `useRouter`, `useRoute`, `defineProps`, `defineEmits`, `defineModel`.
  - **DO NOT** manually import Element Plus components (e.g., `ElButton`, `ElInput`).
- **Models:** Use Vue 3.4+ `defineModel` macros for two-way binding.
- **Props/Emits:** Use type-only declarations:
  ```ts
  const props = defineProps<{ type: 'primary' | 'success' }>()
  const emit = defineEmits<{ (e: 'change', value: string): void }>()
  ```

### 2. Styling

- **Utility First:** Use Tailwind CSS (e.g., `flex items-center p-4`) for structure, spacing, and typography.
- **Merging Classes:** Use `tailwind-merge` and `clsx` (or `cn` helper if available) for conditional classes.
- **SCSS:** Use SCSS for complex component-specific logic or when overriding Element Plus variables. Global styles are in `src/style/global.scss`.
- **Mobile Adaptation:** Be aware of `postcss-px-to-viewport`. Pixels are converted to vw.

### 3. API & Async Data

- **Location:** All API calls are defined in `src/api/` modules.
- **Http Client:** Use the custom `axios` instance in `src/api/request.ts`.
- **Pattern:**
  ```ts
  // src/api/user.ts
  import request from '@/api/request'
  export const getUserInfo = (params: any) => request.get('/user/info', { params })
  ```
- **Error Handling:** Centralized in Axios interceptors. Components generally receive resolved data or catch specific business logic errors.

### 4. Application Structure

- `src/views/chatFlow/`: Core logic for the flow editor interface.
- `src/stores/`: Pinia stores. Modularized (e.g., `user.ts`, `flow.ts`, `chat.ts`).
- `src/components/common/`: Reusable, generic UI components.
- `src/components/global/`: Application-specific global components.
- `src/assets/svgs/`: Source for SVG icons used by `<SvgIcon>`.

### 5. Atomic State Mutations

- **Rule:** When updating multiple related reactive variables (e.g., `list`, `total`, `loading`), always group them into a single synchronous block. In Vue 3, avoid multiple `await`-tick-update cycles that could trigger redundant renders.
- **Preference:** Use a single `Object.assign` or a unified `updateState` helper function if the state object is complex. This ensures a single reactive flush and prevents intermediate inconsistent states from reaching the UI.

## 🛠 Development Workflow

- **Dev Server:** `npm run dev` (Vite).
- **Build:** `npm run build:zz` (Production), `npm run build:sit` (SIT env).
- **Lint/Format:** `npm run lint`, `npm run format`.
- **Environment:** Variables managed in `.env` files, accessed via `import.meta.env`.

## 📦 Repomix Code Index (HIGHEST PRIORITY Context Source)

When the user attaches a file named `repomix-output.xml` or any XML file whose name starts with `repomix` (e.g., `repomix-output.xml`, `repomix-chatflow.xml`), treat it as a **high-priority codebase index / code snapshot**.

**Rules:**

1.  **Elevated Weight:** This file contains a curated, packed representation of key source files. Its content should be treated with **higher importance weight** than general workspace file reads.
2.  **Primary Lookup Source:** When you need to find, understand, or reference code from the project:
    - **FIRST** search within the attached Repomix XML for the relevant file or code snippet.
    - **ONLY IF** the needed content is not found in the Repomix XML, fall back to using `read_file`, `grep_search`, `semantic_search`, or other workspace tools.
3.  **Structure Awareness:** The Repomix XML organizes files with `<file path="...">` tags. Use the `path` attribute to locate specific files within it.
4.  **Do NOT re-read what's already available:** If the Repomix XML already contains the full content of a file, do NOT call `read_file` for that same file again. Use the XML content directly.
5.  **Contextual Completeness:** Combine the Repomix XML context with tool-based reads for files NOT included in the XML to achieve full project understanding.

## ⚠️ Critical Implementation Details

- **Flow Editor:** The chat flow functionality relies heavily on `@vue-flow`. When modifying nodes or edges, ensure compatibility with the store `src/stores/flow.ts`.
- **Edge Cleanup on Node Mutations:** When adding or removing nodes in `@vue-flow`, ALWAYS check whether associated edges need to be cleaned up. Orphaned edges (edges referencing non-existent source/target node IDs) will cause dirty data in the store and may crash the canvas. Before committing node changes, verify: `edges.filter(e => e.source === deletedNodeId || e.target === deletedNodeId)` and remove them.
- **Directives:** Custom directives like `v-auth`, `v-track` are located in `src/directives`.

## 🔬 Code Quality & Safety Guards (MUST FOLLOW)

### 1. Performance & Reactivity Audit (Performance Budget Enforcement)

> **Core Principle: High performance is the foundation of complex PC web applications. Code that blocks the main thread or causes large-scale re-renders is strictly forbidden.**

- **Reactivity Overhead Assessment:**
  - NEVER use deep `ref` on large, deeply nested objects (e.g., the full `vue-flow` nodes collection) unless absolutely necessary. Prefer `shallowRef` or `markRaw` for performance optimization.
  - Check for `watch`/`computed` chain explosions — where one change triggers a cascade of complex computations.
- **Rendering Performance Guard:**
  - For operations involving large numbers of nodes, verify whether `requestIdleCallback`, `requestAnimationFrame`, or debounce/throttle is needed.
  - In loops or high-frequency event handlers (e.g., `onMove`, `onScroll`), algorithms with O(n²) or higher complexity are strictly forbidden.
- **Memory Leak Prevention:**
  - Verify that `onUnmounted` properly cleans up timers, external listeners, and custom subscriptions.

### 2. Concurrency & Race Condition Control (Async Consistency Defense)

> **Core Principle: Assume ALL async operations are unreliable. A "single source of state authority" and "temporal ordering control" MUST be established.**

- **Race Condition Prevention Patterns:**
  - **Locking / Versioning:** For frequently mutated shared variables, prefer a "version number" or "request ID" mechanism. If a later-dispatched request returns first, stale responses MUST be discarded based on the version.
  - **Abort Mechanism:** For network requests or heavy computations, check whether `AbortController` is needed to cancel outdated tasks.
  - **State Mutex:** Before executing async logic that mutates shared variables, check whether a `loading` or `processing` state lock is needed to prevent concurrent triggers.
- **Recommended Patterns:** Prefer `AbortController` for cancelling outdated network requests. For local state race conditions, prefer the **"Simple Versioning"** pattern — attach a monotonically increasing version number or timestamp to each request; when a response arrives, discard it if its version is older than the latest dispatched version.
- **Logic Deduction Requirement:** During confirmation, the AI MUST answer: "If two user actions or async callbacks arrive simultaneously, how does the current logic guarantee eventual state consistency?"
- **Vue Reactivity Pitfall:** Avoid directly mutating multiple non-atomic reactive variables after `await`. Instead, encapsulate updates in a single method for atomic state transition.

### 3. Causal Trace & Side-Effect Mapping (State Flow "Causality" Tracking)

> **Core Principle: Modifying reactive state without a clear understanding of the "trigger source" and "final destination" is strictly forbidden.**

- **Implicit Side-Effect Scanning:**
  - Before modifying any state (`ref`, `reactive`), the AI MUST statically analyze and list all related `watch` and `computed` chains.
  - **Key Concern:** Identify whether a "circular trigger" risk exists (A's change triggers B, and B in turn affects a sub-property of A).
- **Component Communication Transparency:**
  - Identify cross-component coupling via `provide/inject` or global event buses (e.g., `mitt`).
  - When modifying Props, verify ALL parent components' passing logic AND all child components' `emit` response logic.
- **Confirmation Requirement:** The AI MUST answer: "What is the 'lifecycle' of this state change? Who triggers it, and through which chains does it ultimately affect the UI?"

### 4. Frame-Budget & Rendering Optimization (Main-Thread Monopolization Defense)

> **Core Principle: Any synchronous computation exceeding 16ms (targeting 60fps) MUST be decomposed or deferred.**

- **CPU-Intensive Task Decomposition:**
  - For large-scale `vue-flow` node updates, the AI MUST evaluate whether **Time Slicing** or **Web Workers** are needed.
  - Executing `JSON.parse`, deep cloning, or complex regex matching inside high-frequency rendering hooks is strictly forbidden.
- **Virtualization & Lazy Loading Audit:**
  - When modifying canvas rendering logic, the AI MUST evaluate: "Will this operation cause a full canvas re-render?" and "Can we update only the affected nodes (Node-level Reactivity)?"
- **CSS Performance Considerations:**
  - Check whether any introduced CSS properties would cause large-scale **reflow** (e.g., `box-shadow` abused on many nodes). Prefer `transform` and `opacity` for animations.

### 5. Async Atomicity & Stale-Request Management (Promise Safety)

> **Core Principle: All async logic MUST be idempotent or reversible. "Naked Promises" (unguarded async calls) are strictly forbidden.**

- **Stale Closure Detection:**
  - The AI MUST check whether variables referenced after `await` are still "current" at the time of execution.
  - **Key Concern:** If a variable was modified during the `await` period, does the code have "self-healing" or "abort" logic?
- **Single Source of Mutation:**
  - When multiple locations can mutate the same variable, the AI should recommend redesigning to an "Intent Pattern": all mutations go through a single Action/Mutation with a timestamp or sequence number; stale mutations are rejected.
- **UI State Consistency:**
  - Ensure the `loading` state is strictly bound to the async operation's lifecycle. Prevent scenarios like "request finished but loading spinner persists" or "request errored but stale data remains displayed".

## 🔄 User Feedback Loop (HIGHEST PRIORITY — MUST FOLLOW)

> **Core Principle: Before ANY critical operation, ambiguous decision, or irreversible action, MUST use `mcp_feedback_ask_user` to confirm with the user. Self-assumption or unauthorized execution is strictly forbidden.**

### A. Mandatory Confirmation Triggers

The following scenarios **MUST** invoke `mcp_feedback_ask_user` and wait for user confirmation before execution:

1. **Git Operations:**

   - Creating / deleting / switching branches
   - `git commit` (confirm commit message and scope)
   - `git push` (confirm push target)
   - `git stash` / `git reset` / `git revert`
   - Any operation that alters code history

2. **Batch File/Directory Operations:**

   - Batch-creating more than 3 files
   - Deleting or renaming files/directories
   - Moving files to a different directory

3. **Architectural or Structural Changes:**

   - Adding new routes
   - Adding/modifying Pinia Stores
   - Modifying config files such as `vite.config.ts`, `tsconfig.json`, `package.json`
   - Installing or removing npm dependencies

4. **Multiple Implementation Options Available:**

   - Present 2-3 concrete options and let the user choose
   - Explain the pros and cons of each option

5. **Uncertain User Intent:**

   - User instruction is vague or ambiguous
   - Unsure about modification scope (one file vs. multiple files)
   - Unsure which specific component/file the user is referring to

6. **Terminal Command Execution:**
   - Installing dependencies (`npm install`)
   - Running build commands
   - Any command that may affect the global environment

### B. Post-Task Confirmation Flow (CRITICAL — Rule 3)

- **Mandatory Confirmation:** AFTER completing any code modifications and BEFORE finishing the conversation/task, **YOU MUST** use the `mcp_feedback_ask_user` tool to ask the user for their opinion.
- **⛔ Ending a task without explicit user approval ("OK", "Approved", "Confirm", etc.) = violation. Even for a single-line code change, the approval flow is mandatory. "Thanks", silence, or vague responses ≠ approval.**
- **Workflow:**
  1. Implement changes.
  2. Verify changes (lint, build, or self-review).
  3. Call `mcp_feedback_ask_user` with a summary of changes and ask for explicit approval.
  4. **Explicit Approval Required:** Only consider the task complete when the user provides **clear approval keywords** such as:
     - English: "OK", "Approved", "LGTM", "Good", "Yes", "Confirm"
     - Chinese: "没问题", "通过", "确认", "好的", "可以", "同意"
  5. **Continue Loop if Needed:** If the user raises new questions or requests modifications in the confirmation dialog:
     - Treat it as a **NEW development requirement**
     - Restart the full SOP workflow: Deep Context Scan → Sequential Thinking → Confirm Decisions → Execute → Feedback Loop
     - Continue iterating until explicit approval is received

### C. Impact Analysis (MANDATORY before confirmation)

When calling `mcp_feedback_ask_user` for any code modification, the confirmation message **MUST** include an **Impact Report** covering:

1. **Dependency Impact:** List all upstream components, parent views, or sibling modules that import or depend on the modified file/function. Example: "Modifying `useNodeCollapse.ts` will affect `canvas.vue`, `MessageNode.vue`, and `EditorNode.vue`."
2. **State Impact:** If the change touches any Pinia store (`src/stores/*`), explicitly state whether it could cause unexpected re-renders or side effects in other pages/components that subscribe to the same store.
3. **Performance Impact:** For any logic related to `@vue-flow` (large-scale node rendering), `@tiptap` (editor), or list/loop rendering, the report **MUST** state:
   - Whether debounce / throttle / `requestIdleCallback` / `requestAnimationFrame` has been applied.
   - Whether `computed` caching or `shallowRef` is used to avoid unnecessary reactivity overhead.
   - If none of these optimizations apply, explain why they are not needed.
4. **Type Safety Impact:** State whether the modification introduces or changes any TypeScript interfaces/types in `src/types/`, and whether all consuming files remain type-safe.

> **Format:** Present the Impact Report as a structured list inside the `mcp_feedback_ask_user` prompt, NOT as a separate message.

### D. Confirmation Granularity (Preventing Confirmation Fatigue)

To avoid overwhelming the user with excessive confirmation prompts:

1. **Logical Grouping:**

   - If the AI plans to make multiple small, related changes (e.g., 10 minor style adjustments across files), do NOT prompt 10 separate confirmations.
   - Instead, compile a **single "Change Manifest"** listing all planned modifications grouped by logical intent, and request ONE confirmation.
   - Format: A numbered list with file path, change description, and reason for each item.

2. **Threshold Rules:**

   - **1-3 file changes (same concern):** Single grouped confirmation.
   - **4+ file changes OR cross-cutting concerns:** Present a Change Manifest table, then confirm.
   - **Unrelated changes:** MUST be confirmed separately (do not bundle unrelated operations).

3. **Smart Batching:**
   - Group by logical intent, not by file proximity. Example: "All Tailwind class migrations" = one batch; "Route change + Store refactor" = two separate confirmations.

### E. Strict Rules

- ❌ Do NOT execute any git operation (commit/push/branch/stash/reset) without explicit user confirmation via `mcp_feedback_ask_user`.
- ❌ Do NOT end a session without explicit user approval using the keywords above.
- ❌ Do NOT assume silence, vague responses, or "thanks" as approval.
- ❌ Do NOT guess the user's intent when the request is ambiguous — always ask.
- ❌ Do NOT batch multiple unrelated operations without confirming the plan first.
- ❌ Do NOT delete or overwrite files without confirmation.
- ✅ Any new requirement mentioned during confirmation automatically restarts the complete workflow cycle.
- ✅ When in doubt, ALWAYS ask. Over-confirming is better than making wrong assumptions.
