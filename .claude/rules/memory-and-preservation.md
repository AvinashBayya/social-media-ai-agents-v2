# Claude Code Preservation & Memory Guidelines

This repository enforces strict memory tracking and anti-deletion protocols for all AI model interactions.

## 1. Initialization Workflow
At the beginning of any session or task execution:
1. Read `PROJECT_MEMORY.md` in the repository root to load the active roadmap state, codebase export inventory, and hard technical constraints.
2. Check the `Active Task State & Progress Roadmap` section to understand what has been completed and what is currently in progress.

## 2. Anti-Deletion Protocol for Code Edits
When modifying or extending existing code:
- **Full File View Required**: View the entire target file or complete module context before proposing changes. Snippet-based partial replacements are strictly forbidden as they wipe out un-viewed exported functions.
- **Preserve Existing Exports**: Do NOT remove, rename, or drop existing exported functions, interfaces, or types.
- **Additive Modifications Only**:
  - Add optional parameters to existing function signatures rather than breaking callers.
  - Implement new capabilities in new helper functions or optional branches.
  - Maintain backwards compatibility with all frozen data contracts in `src/types/core.ts`.

## 3. Task Completion Workflow
Before concluding any task:
1. Run `bun test` to confirm all 415+ tests pass cleanly without regression.
2. Run `bun scripts/check-exports.ts` to verify export integrity.
3. Update `PROJECT_MEMORY.md` with:
   - Updated task state (move completed item to `Completed Milestones`).
   - Any new exported functions or modules added to the `Codebase Inventory & Export Registry`.
